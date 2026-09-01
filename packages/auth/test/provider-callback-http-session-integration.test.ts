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
  InMemoryProviderCallbackTransactionManager,
  ProviderAdapterRegistry,
  ProviderCallbackCoordinator,
  ProviderHttpSessionRegistry,
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
    throw new Error("The callback integration transport must not make HTTP requests.");
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

const createRuntime = (adapters: readonly ProviderAdapter[]) => {
  const created: TrackingHttpSession[] = [];
  const httpSessions = new ProviderHttpSessionRegistry(
    adapters.map((adapter) => ({
      provider: adapter.descriptor.provider,
      allowedHosts: [`${adapter.descriptor.provider}.example.invalid`],
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
  return { coordinator, created, httpSessions, transactions };
};

describe("provider callback HTTP session integration", () => {
  it("commits distinct provider transports only after every callback succeeds", async () => {
    const callbackTransports = new Map<ProviderId, HttpSession>();
    const runtimeReference: { httpSessions?: ProviderHttpSessionRegistry } = {};
    const runtime = createRuntime([
      createAdapter("usaint", ["usaint:profile.read"], async (context) => {
        callbackTransports.set("usaint", context.transport);
        return createSession("usaint", context.authSource, context.requestedScopes);
      }),
      createAdapter("lms", ["lms:courses.read"], async (context) => {
        expect(runtimeReference.httpSessions?.has("usaint")).toBe(false);
        callbackTransports.set("lms", context.transport);
        return createSession("lms", context.authSource, context.requestedScopes);
      }),
    ]);
    runtimeReference.httpSessions = runtime.httpSessions;

    const result = await runtime.coordinator.execute({
      authSource: "smartid",
      inputMode: "official-browser",
      requestedScopes: ["lms:courses.read", "usaint:profile.read"],
      signal: new AbortController().signal,
    });

    expect(result.map(({ provider }) => provider)).toEqual(["usaint", "lms"]);
    expect(runtime.httpSessions.get("usaint")).toBe(callbackTransports.get("usaint"));
    expect(runtime.httpSessions.get("lms")).toBe(callbackTransports.get("lms"));
    expect(callbackTransports.get("usaint")).not.toBe(callbackTransports.get("lms"));
    expect(runtime.created).toHaveLength(2);
    expect(runtime.created.every(({ closeCalls }) => closeCalls === 0)).toBe(true);

    await runtime.httpSessions.close();
  });

  it("closes failed replacements while preserving the previous provider session", async () => {
    const callbackError = new Error("mock LMS replacement failed");
    let lmsCalls = 0;
    const runtime = createRuntime([
      createAdapter("usaint", ["usaint:profile.read"], async (context) =>
        createSession("usaint", context.authSource, context.requestedScopes),
      ),
      createAdapter("lms", ["lms:courses.read"], async (context) => {
        lmsCalls += 1;
        if (lmsCalls > 1) throw callbackError;
        return createSession("lms", context.authSource, context.requestedScopes);
      }),
    ]);

    await runtime.coordinator.execute({
      authSource: "smartid",
      inputMode: "official-browser",
      requestedScopes: ["lms:courses.read"],
      signal: new AbortController().signal,
    });
    const previousLms = runtime.httpSessions.get("lms");
    const previousSnapshot = runtime.transactions.getSnapshot();

    await expect(
      runtime.coordinator.execute({
        authSource: "smartid",
        inputMode: "official-browser",
        requestedScopes: ["usaint:profile.read", "lms:courses.read"],
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(callbackError);

    expect(runtime.httpSessions.get("lms")).toBe(previousLms);
    expect(runtime.httpSessions.has("usaint")).toBe(false);
    expect(runtime.transactions.getSnapshot()).toEqual(previousSnapshot);
    expect(runtime.created.map(({ closeCalls }) => closeCalls)).toEqual([0, 1, 1]);

    await runtime.httpSessions.close();
  });

  it("rejects a late transaction after another attempt commits the same provider", async () => {
    let resolveFirst: ((session: ProviderSession) => void) | undefined;
    let firstStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstResult = new Promise<ProviderSession>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;
    const runtime = createRuntime([
      createAdapter("lms", ["lms:courses.read"], async (context) => {
        calls += 1;
        if (calls === 1) {
          firstStarted?.();
          return firstResult;
        }
        return createSession("lms", context.authSource, context.requestedScopes);
      }),
    ]);

    const late = runtime.coordinator.execute({
      authSource: "smartid",
      inputMode: "official-browser",
      requestedScopes: ["lms:courses.read"],
      signal: new AbortController().signal,
    });
    await started;
    const winner = await runtime.coordinator.execute({
      authSource: "smartid",
      inputMode: "official-browser",
      requestedScopes: ["lms:courses.read"],
      signal: new AbortController().signal,
    });
    const winnerTransport = runtime.httpSessions.get("lms");
    resolveFirst?.(createSession("lms", "smartid", ["lms:courses.read"]));

    await expect(late).rejects.toMatchObject({ violation: "STALE_TRANSACTION" });
    expect(runtime.transactions.getSnapshot()).toEqual(winner);
    expect(runtime.httpSessions.get("lms")).toBe(winnerTransport);
    expect(runtime.created.map(({ closeCalls }) => closeCalls)).toEqual([1, 0]);

    await runtime.httpSessions.close();
  });
});
