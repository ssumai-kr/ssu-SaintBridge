import type { HttpSession, HttpSessionResponse } from "@ssu-saintbridge/transport";
import {
  providerSessionSchema,
  type AuthSourceId,
  type ProviderId,
  type ProviderSession,
  type Scope,
} from "@ssu-saintbridge/types";
import { describe, expect, it } from "vitest";

import {
  AuthenticationExecutor,
  InMemoryProviderCallbackTransactionManager,
  ProviderAdapterRegistry,
  ProviderCallbackCoordinator,
  ProviderHttpSessionRegistry,
  StatefulProviderAuthenticationExecutor,
  TransientCredentials,
  createPreparedProviderAuthentication,
  type AuthenticationExecutionContext,
  type AuthenticationExecutionHandlers,
  type PreparedProviderAuthentication,
  type ProviderAdapter,
  type ProviderCallbackContext,
} from "../src/index.js";
import { createProviderDescriptor } from "./support/provider-adapter-fixtures.js";

class TrackingHttpSession implements HttpSession {
  readonly provider: ProviderId;
  closeCalls = 0;

  constructor(provider: ProviderId) {
    this.provider = provider;
  }

  async request(): Promise<HttpSessionResponse> {
    throw new Error("The stateful callback test transport must not make HTTP requests.");
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

const createSession = (
  provider: ProviderId,
  authenticatedBy: AuthSourceId,
  grantedScopes: readonly Scope[],
): ProviderSession =>
  providerSessionSchema.parse({
    provider,
    authenticatedBy,
    status: "ready",
    grantedScopes,
    capabilities: grantedScopes.map((scope) => ({
      id: scope.slice(scope.indexOf(":") + 1),
      available: true,
    })),
    expiresAt: null,
  });

const createAdapter = (
  provider: ProviderId,
  supportedScopes: readonly Scope[],
  openSession: (context: ProviderCallbackContext) => Promise<ProviderSession>,
): ProviderAdapter => ({
  descriptor: createProviderDescriptor({
    provider,
    supportedAuthSources: provider === "library" ? ["smartid", "library"] : ["smartid"],
    supportedScopes,
  }),
  openSession,
});

const prepareCallbacks = async (
  coordinator: ProviderCallbackCoordinator,
  context: AuthenticationExecutionContext,
): Promise<PreparedProviderAuthentication<string>> =>
  createPreparedProviderAuthentication(
    "authenticated",
    await coordinator.prepare({
      authSource: context.authSource,
      inputMode: context.inputMode,
      requestedScopes: context.requestedScopes,
      signal: context.signal,
    }),
  );

const createRuntime = (
  adapters: readonly ProviderAdapter[],
  createHandlerOverrides: (
    coordinator: ProviderCallbackCoordinator,
  ) => Partial<
    AuthenticationExecutionHandlers<PreparedProviderAuthentication<string>>
  > = () => ({}),
) => {
  const created: TrackingHttpSession[] = [];
  const httpSessions = new ProviderHttpSessionRegistry(
    adapters.map(({ descriptor }) => ({
      provider: descriptor.provider,
      allowedHosts: [`${descriptor.provider}.example.invalid`],
    })),
    {
      sessionFactory: ({ provider }) => {
        const session = new TrackingHttpSession(provider);
        created.push(session);
        return session;
      },
    },
  );
  const transactions = new InMemoryProviderCallbackTransactionManager(httpSessions);
  const coordinator = new ProviderCallbackCoordinator({
    adapters: new ProviderAdapterRegistry(
      adapters.map((adapter) => ({ provider: adapter.descriptor.provider, adapter })),
    ),
    transactions,
    createTransport: transactions.createTransport,
  });
  const handlerOverrides = createHandlerOverrides(coordinator);
  const executor = new AuthenticationExecutor({
    officialBrowser:
      handlerOverrides.officialBrowser ??
      (async (context) => prepareCallbacks(coordinator, context)),
    applicationCredentials:
      handlerOverrides.applicationCredentials ??
      (async (context) => prepareCallbacks(coordinator, context)),
  });
  const stateful = new StatefulProviderAuthenticationExecutor(executor, coordinator);
  return { coordinator, created, httpSessions, stateful, transactions };
};

describe("stateful provider authentication executor", () => {
  it("atomically binds validated provider sessions to the authenticated source", async () => {
    const runtime = createRuntime([
      createAdapter("lms", ["lms:courses.read"], async (context) =>
        createSession("lms", context.authSource, context.requestedScopes),
      ),
    ]);

    await expect(
      runtime.stateful.execute({
        authSource: "smartid",
        mode: "official-browser",
        scopes: ["lms:courses.read"],
      }),
    ).resolves.toBe("authenticated");

    expect(runtime.stateful.getSnapshot()).toEqual({
      state: "open",
      authSources: [
        {
          source: "smartid",
          inputMode: "official-browser",
          status: "authenticated",
          expiresAt: null,
        },
      ],
      providers: [
        expect.objectContaining({
          provider: "lms",
          authenticatedBy: "smartid",
          status: "ready",
          grantedScopes: ["lms:courses.read"],
        }),
      ],
    });
    expect(JSON.stringify(runtime.stateful.getSnapshot())).not.toMatch(
      /cookie|authorization|token|httpSession|transport/i,
    );

    runtime.stateful.expire("smartid");
    expect(runtime.stateful.getSnapshot()).toMatchObject({
      authSources: [{ source: "smartid", status: "expired" }],
      providers: [{ provider: "lms", authenticatedBy: "smartid", status: "expired" }],
    });

    await runtime.httpSessions.close();
  });

  it("keeps prepared callback sessions hidden until auth-source completion", async () => {
    const prepared = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const adapter = createAdapter("lms", ["lms:courses.read"], async (context) =>
      createSession("lms", context.authSource, context.requestedScopes),
    );
    const runtime = createRuntime([adapter], (coordinator) => ({
      officialBrowser: async (context) => {
        const result = await prepareCallbacks(coordinator, context);
        prepared.resolve();
        await release.promise;
        return result;
      },
    }));

    const execution = runtime.stateful.execute({
      authSource: "smartid",
      mode: "official-browser",
      scopes: ["lms:courses.read"],
    });
    await prepared.promise;

    expect(runtime.stateful.getSnapshot()).toEqual({
      state: "open",
      authSources: [expect.objectContaining({ source: "smartid", status: "authenticating" })],
      providers: [],
    });
    expect(runtime.httpSessions.has("lms")).toBe(false);

    release.resolve();
    await expect(execution).resolves.toBe("authenticated");
    expect(runtime.stateful.getSnapshot().providers[0]).toMatchObject({ status: "ready" });

    await runtime.httpSessions.close();
  });

  it("restores the previous source and provider when reauthentication callbacks fail", async () => {
    const replacement = Promise.withResolvers<ProviderSession>();
    const replacementStarted = Promise.withResolvers<void>();
    let calls = 0;
    const runtime = createRuntime([
      createAdapter("lms", ["lms:courses.read"], async (context) => {
        calls += 1;
        if (calls === 1) {
          return createSession("lms", context.authSource, context.requestedScopes);
        }
        replacementStarted.resolve();
        return replacement.promise;
      }),
    ]);
    const request = {
      authSource: "smartid",
      mode: "official-browser",
      scopes: ["lms:courses.read"],
    } as const;

    await runtime.stateful.execute(request);
    const previous = runtime.stateful.getSnapshot();
    const reauthentication = runtime.stateful.execute(request);
    await replacementStarted.promise;
    expect(runtime.stateful.getSnapshot()).toEqual({
      state: "open",
      authSources: [expect.objectContaining({ source: "smartid", status: "authenticating" })],
      providers: [expect.objectContaining({ provider: "lms", status: "expired" })],
    });

    const callbackError = new Error("replacement callback failed");
    replacement.reject(callbackError);
    await expect(reauthentication).rejects.toBe(callbackError);
    expect(runtime.stateful.getSnapshot()).toEqual(previous);
    expect(runtime.created.map(({ closeCalls }) => closeCalls)).toEqual([0, 1]);

    await runtime.httpSessions.close();
  });

  it("rolls prepared providers back when the auth-source attempt becomes stale", async () => {
    const prepared = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const runtime = createRuntime(
      [
        createAdapter("lms", ["lms:courses.read"], async (context) =>
          createSession("lms", context.authSource, context.requestedScopes),
        ),
      ],
      (coordinator) => ({
        officialBrowser: async (context) => {
          const result = await prepareCallbacks(coordinator, context);
          prepared.resolve();
          await release.promise;
          return result;
        },
      }),
    );

    const execution = runtime.stateful.execute({
      authSource: "smartid",
      mode: "official-browser",
      scopes: ["lms:courses.read"],
    });
    await prepared.promise;
    runtime.stateful.remove("smartid");
    release.resolve();

    await expect(execution).rejects.toMatchObject({ violation: "STALE_ATTEMPT" });
    expect(runtime.stateful.getSnapshot()).toEqual({
      state: "open",
      authSources: [],
      providers: [],
    });
    expect(runtime.created[0]?.closeCalls).toBe(1);
    expect(runtime.httpSessions.has("lms")).toBe(false);

    await runtime.httpSessions.close();
  });

  it("rejects callbacks prepared for a different authentication binding", async () => {
    const runtime = createRuntime(
      [
        createAdapter("lms", ["lms:courses.read"], async (context) =>
          createSession("lms", context.authSource, context.requestedScopes),
        ),
        createAdapter("library", ["library:loans.read"], async (context) =>
          createSession("library", context.authSource, context.requestedScopes),
        ),
      ],
      (coordinator) => ({
        officialBrowser: async (context) =>
          createPreparedProviderAuthentication(
            "authenticated",
            await coordinator.prepare({
              authSource: "library",
              inputMode: context.inputMode,
              requestedScopes: ["library:loans.read"],
              signal: context.signal,
            }),
          ),
      }),
    );

    await expect(
      runtime.stateful.execute({
        authSource: "smartid",
        mode: "official-browser",
        scopes: ["lms:courses.read"],
      }),
    ).rejects.toMatchObject({ violation: "PREPARED_CALLBACK_BINDING_MISMATCH" });
    expect(runtime.stateful.getSnapshot()).toEqual({
      state: "open",
      authSources: [],
      providers: [],
    });
    expect(runtime.created[0]?.closeCalls).toBe(1);

    await runtime.httpSessions.close();
  });

  it("prepares callbacks inside the one-shot application-credential handler", async () => {
    let handlerActive = false;
    const credentials = new TransientCredentials({
      identifier: "student-id",
      password: "temporary-password",
    });
    const runtime = createRuntime(
      [
        createAdapter("lms", ["lms:courses.read"], async (context) => {
          expect(handlerActive).toBe(true);
          return createSession("lms", context.authSource, context.requestedScopes);
        }),
      ],
      (coordinator) => ({
        applicationCredentials: async (context, values) => {
          expect(values.identifier).toBe("student-id");
          handlerActive = true;
          try {
            return await prepareCallbacks(coordinator, context);
          } finally {
            handlerActive = false;
          }
        },
      }),
    );

    await runtime.stateful.execute({
      authSource: "smartid",
      mode: "application-credentials",
      scopes: ["lms:courses.read"],
      acquireCredentials: () => credentials,
    });

    expect(credentials.released).toBe(true);
    expect(runtime.stateful.getSnapshot()).toMatchObject({
      authSources: [
        { source: "smartid", inputMode: "application-credentials", status: "authenticated" },
      ],
      providers: [{ provider: "lms", authenticatedBy: "smartid", status: "ready" }],
    });
    expect(JSON.stringify(runtime.stateful.getSnapshot())).not.toMatch(
      /student-id|temporary-password/,
    );

    await runtime.httpSessions.close();
  });
});
