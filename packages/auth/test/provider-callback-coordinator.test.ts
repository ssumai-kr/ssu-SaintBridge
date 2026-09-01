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
  ProviderAdapterRegistry,
  ProviderCallbackContractError,
  ProviderCallbackCoordinator,
  type ProviderAdapter,
  type ProviderCallbackContext,
  type ProviderCallbackContractViolation,
  type ProviderCallbackTransaction,
  type ProviderCallbackTransactionManager,
  type ProviderCallbackTransportFactoryContext,
  type StageProviderCallbackResultOptions,
} from "../src/index.js";
import { createProviderDescriptor } from "./support/provider-adapter-fixtures.js";

class TestHttpSession implements HttpSession {
  readonly id: string;
  readonly #closeError: unknown;
  closeCalls = 0;

  constructor(id: string, closeError?: unknown) {
    this.id = id;
    this.#closeError = closeError;
  }

  async request(): Promise<HttpSessionResponse> {
    throw new Error("The coordinator test transport must not make HTTP requests.");
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.#closeError !== undefined) throw this.#closeError;
  }
}

interface StagedResult extends StageProviderCallbackResultOptions {
  readonly transport: TestHttpSession;
}

class TestTransactionManager implements ProviderCallbackTransactionManager {
  readonly events: string[] = [];
  readonly staged: StagedResult[] = [];
  readonly #commitError: unknown;
  #active: ProviderCallbackTransaction | undefined;
  #committed: readonly ProviderSession[] = Object.freeze([]);

  constructor(options: { readonly commitError?: unknown } = {}) {
    this.#commitError = options.commitError;
  }

  begin(options: {
    readonly authSource: AuthSourceId;
    readonly inputMode: "official-browser" | "application-credentials";
    readonly requestedScopes: readonly Scope[];
  }): ProviderCallbackTransaction {
    const transaction = Object.freeze({ ...options }) as ProviderCallbackTransaction;
    this.#active = transaction;
    this.events.push("begin");
    return transaction;
  }

  stage(
    transaction: ProviderCallbackTransaction,
    options: StageProviderCallbackResultOptions,
  ): void {
    this.#assertActive(transaction);
    this.staged.push(options as StagedResult);
    this.events.push(`stage:${options.expectedProvider}`);
  }

  commit(transaction: ProviderCallbackTransaction): readonly ProviderSession[] {
    this.#assertActive(transaction);
    this.events.push("commit");
    if (this.#commitError !== undefined) throw this.#commitError;
    this.#committed = Object.freeze(this.staged.map(({ result }) => result));
    this.#active = undefined;
    return this.#committed;
  }

  async rollback(transaction: ProviderCallbackTransaction): Promise<void> {
    this.#assertActive(transaction);
    this.events.push("rollback");
    this.#active = undefined;
    await Promise.all(this.staged.map(async ({ transport }) => transport.close()));
    this.staged.length = 0;
  }

  getSnapshot(): readonly ProviderSession[] {
    return this.#committed;
  }

  #assertActive(transaction: ProviderCallbackTransaction): void {
    if (this.#active !== transaction) {
      throw new ProviderCallbackContractError("TRANSACTION_NOT_ACTIVE");
    }
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

const createCoordinator = (options: {
  readonly adapters: readonly ProviderAdapter[];
  readonly transactions: TestTransactionManager;
  readonly sessions: TestHttpSession[];
}): ProviderCallbackCoordinator =>
  new ProviderCallbackCoordinator({
    adapters: new ProviderAdapterRegistry(
      options.adapters.map((adapter) => ({
        provider: adapter.descriptor.provider,
        adapter,
      })),
    ),
    transactions: options.transactions,
    createTransport: (context) => {
      const session = new TestHttpSession(`${context.provider}:${options.sessions.length}`);
      options.sessions.push(session);
      return session;
    },
  });

const expectViolation = async (
  action: Promise<unknown>,
  violation: ProviderCallbackContractViolation,
): Promise<void> => {
  try {
    await action;
    throw new Error("Expected provider callback coordination to fail.");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ProviderCallbackContractError);
    expect(error).toMatchObject({ violation });
  }
};

describe("provider callback coordinator", () => {
  it("runs provider-scoped callbacks in plan order and commits once", async () => {
    const callbacks: Array<{
      readonly provider: ProviderId;
      readonly context: ProviderCallbackContext;
    }> = [];
    const factoryContexts: ProviderCallbackTransportFactoryContext[] = [];
    const sessions: TestHttpSession[] = [];
    const transactions = new TestTransactionManager();
    const adapters = [
      createAdapter("library", ["library:loans.read"], async (context) => {
        callbacks.push({ provider: "library", context });
        return createSession("library", context.authSource, context.requestedScopes);
      }),
      createAdapter("lms", ["lms:courses.read", "lms:tasks.read"], async (context) => {
        callbacks.push({ provider: "lms", context });
        expect(transactions.getSnapshot()).toEqual([]);
        return createSession("lms", context.authSource, context.requestedScopes);
      }),
      createAdapter("usaint", ["usaint:profile.read"], async (context) => {
        callbacks.push({ provider: "usaint", context });
        return createSession("usaint", context.authSource, context.requestedScopes);
      }),
    ];
    const coordinator = new ProviderCallbackCoordinator({
      adapters: new ProviderAdapterRegistry(
        adapters.map((adapter) => ({ provider: adapter.descriptor.provider, adapter })),
      ),
      transactions,
      createTransport: (context) => {
        factoryContexts.push(context);
        const session = new TestHttpSession(context.provider);
        sessions.push(session);
        return session;
      },
    });

    const result = await coordinator.execute({
      authSource: "smartid",
      inputMode: "official-browser",
      requestedScopes: [
        "library:loans.read",
        "lms:tasks.read",
        "usaint:profile.read",
        "lms:courses.read",
      ],
      signal: new AbortController().signal,
    });

    expect(callbacks.map(({ provider }) => provider)).toEqual(["usaint", "lms", "library"]);
    expect(callbacks.map(({ context }) => context.requestedScopes)).toEqual([
      ["usaint:profile.read"],
      ["lms:tasks.read", "lms:courses.read"],
      ["library:loans.read"],
    ]);
    expect(callbacks.every(({ context }) => Object.isFrozen(context))).toBe(true);
    expect(callbacks.every(({ context }) => Object.keys(context).length === 5)).toBe(true);
    expect(factoryContexts.map(({ provider }) => provider)).toEqual(["usaint", "lms", "library"]);
    expect(new Set(callbacks.map(({ context }) => context.transport)).size).toBe(3);
    expect(transactions.events).toEqual([
      "begin",
      "stage:usaint",
      "stage:lms",
      "stage:library",
      "commit",
    ]);
    expect(result.map(({ provider }) => provider)).toEqual(["usaint", "lms", "library"]);
    expect(sessions.every(({ closeCalls }) => closeCalls === 0)).toBe(true);
  });

  it.each([
    [
      "RESULT_PROVIDER_MISMATCH",
      {
        provider: "usaint",
        authenticatedBy: "smartid",
        status: "ready",
        grantedScopes: ["lms:courses.read"],
        capabilities: [],
        expiresAt: null,
      },
    ],
    [
      "RESULT_AUTH_SOURCE_MISMATCH",
      {
        provider: "lms",
        authenticatedBy: "library",
        status: "ready",
        grantedScopes: ["lms:courses.read"],
        capabilities: [],
        expiresAt: null,
      },
    ],
    [
      "RESULT_SCOPE_NOT_OWNED",
      {
        provider: "lms",
        authenticatedBy: "smartid",
        status: "ready",
        grantedScopes: ["usaint:profile.read"],
        capabilities: [],
        expiresAt: null,
      },
    ],
    [
      "RESULT_SCOPE_NOT_REQUESTED",
      {
        provider: "lms",
        authenticatedBy: "smartid",
        status: "ready",
        grantedScopes: ["lms:tasks.read"],
        capabilities: [],
        expiresAt: null,
      },
    ],
    [
      "INVALID_PROVIDER_SESSION",
      {
        provider: "lms",
        authenticatedBy: "smartid",
        status: "ready",
        grantedScopes: ["lms:courses.read"],
        expiresAt: null,
      },
    ],
  ] as const)("rejects invalid callback results: %s", async (violation, result) => {
    const sessions: TestHttpSession[] = [];
    const transactions = new TestTransactionManager();
    const adapter = createAdapter(
      "lms",
      ["lms:courses.read", "lms:tasks.read"],
      async () => result as unknown as ProviderSession,
    );
    const coordinator = createCoordinator({ adapters: [adapter], transactions, sessions });

    await expectViolation(
      coordinator.execute({
        authSource: "smartid",
        inputMode: "official-browser",
        requestedScopes: ["lms:courses.read"],
        signal: new AbortController().signal,
      }),
      violation,
    );
    expect(transactions.events).toEqual(["begin", "rollback"]);
    expect(sessions[0]?.closeCalls).toBe(1);
    expect(transactions.getSnapshot()).toEqual([]);
  });

  it("preserves the callback error when current and staged transport cleanup fail", async () => {
    const callbackError = new Error("mock callback failed");
    const cleanupError = new Error("mock cleanup failed");
    const sessions: TestHttpSession[] = [];
    const transactions = new TestTransactionManager();
    const usaint = createAdapter("usaint", ["usaint:profile.read"], async (context) =>
      createSession("usaint", context.authSource, context.requestedScopes),
    );
    const lms = createAdapter("lms", ["lms:courses.read"], async () => {
      throw callbackError;
    });
    const coordinator = new ProviderCallbackCoordinator({
      adapters: new ProviderAdapterRegistry([
        { provider: "usaint", adapter: usaint },
        { provider: "lms", adapter: lms },
      ]),
      transactions,
      createTransport: (context) => {
        const session = new TestHttpSession(context.provider, cleanupError);
        sessions.push(session);
        return session;
      },
    });

    await expect(
      coordinator.execute({
        authSource: "smartid",
        inputMode: "official-browser",
        requestedScopes: ["usaint:profile.read", "lms:courses.read"],
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(callbackError);
    expect(transactions.events).toEqual(["begin", "stage:usaint", "rollback"]);
    expect(sessions.map(({ closeCalls }) => closeCalls)).toEqual([1, 1]);
    expect(transactions.getSnapshot()).toEqual([]);
  });

  it("prevents an aborted late callback result from being staged", async () => {
    const abortError = new Error("mock authentication attempt removed");
    const controller = new AbortController();
    const sessions: TestHttpSession[] = [];
    const transactions = new TestTransactionManager();
    const adapter = createAdapter("lms", ["lms:courses.read"], async (context) => {
      controller.abort(abortError);
      return createSession("lms", context.authSource, context.requestedScopes);
    });
    const coordinator = createCoordinator({ adapters: [adapter], transactions, sessions });

    await expect(
      coordinator.execute({
        authSource: "smartid",
        inputMode: "official-browser",
        requestedScopes: ["lms:courses.read"],
        signal: controller.signal,
      }),
    ).rejects.toBe(abortError);
    expect(transactions.events).toEqual(["begin", "rollback"]);
    expect(sessions[0]?.closeCalls).toBe(1);
  });

  it("rolls staged callbacks back when commit ownership is stale", async () => {
    const staleError = new ProviderCallbackContractError("STALE_TRANSACTION", {
      authSource: "smartid",
      provider: "lms",
    });
    const sessions: TestHttpSession[] = [];
    const transactions = new TestTransactionManager({ commitError: staleError });
    const adapter = createAdapter("lms", ["lms:courses.read"], async (context) =>
      createSession("lms", context.authSource, context.requestedScopes),
    );
    const coordinator = createCoordinator({ adapters: [adapter], transactions, sessions });

    await expect(
      coordinator.execute({
        authSource: "smartid",
        inputMode: "official-browser",
        requestedScopes: ["lms:courses.read"],
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(staleError);
    expect(transactions.events).toEqual(["begin", "stage:lms", "commit", "rollback"]);
    expect(sessions[0]?.closeCalls).toBe(1);
  });

  it("rejects an invalid transport before invoking the adapter", async () => {
    let callbackCalls = 0;
    const transactions = new TestTransactionManager();
    const adapter = createAdapter("lms", ["lms:courses.read"], async (context) => {
      callbackCalls += 1;
      return createSession("lms", context.authSource, context.requestedScopes);
    });
    const coordinator = new ProviderCallbackCoordinator({
      adapters: new ProviderAdapterRegistry([{ provider: "lms", adapter }]),
      transactions,
      createTransport: () => ({}) as HttpSession,
    });

    await expectViolation(
      coordinator.execute({
        authSource: "smartid",
        inputMode: "official-browser",
        requestedScopes: ["lms:courses.read"],
        signal: new AbortController().signal,
      }),
      "INVALID_PROVIDER_TRANSPORT",
    );
    expect(callbackCalls).toBe(0);
    expect(transactions.events).toEqual(["begin", "rollback"]);
  });
});
