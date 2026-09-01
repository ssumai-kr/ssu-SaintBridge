import {
  authInputModeSchema,
  authSourceIdSchema,
  providerForScope,
  providerIdSchema,
  providerIds,
  providerSessionSchema,
  scopeSchema,
  type AuthSourceId,
  type ProviderId,
  type ProviderSession,
  type Scope,
} from "@ssu-saintbridge/types";

import type { ProviderCallbackTransportFactory } from "./provider-callback-coordinator.js";
import {
  ProviderCallbackContractError,
  isProviderCallbackBindingAllowed,
  type BeginProviderCallbackTransactionOptions,
  type ProviderCallbackCommit,
  type ProviderCallbackTransaction,
  type ProviderCallbackTransactionManager,
  type StageProviderCallbackResultOptions,
} from "./provider-callback-transaction.js";
import { ProviderHttpSessionRegistry } from "./provider-http-sessions.js";

type TrackedTransactionState = "staging" | "committed" | "rolled-back";

interface TrackedProviderCallbackResult {
  readonly provider: ProviderId;
  readonly requestedScopes: readonly Scope[];
  readonly result: ProviderSession;
  readonly transport: StageProviderCallbackResultOptions["transport"];
}

interface TrackedProviderCallbackTransaction {
  readonly token: ProviderCallbackTransaction;
  readonly authSource: AuthSourceId;
  readonly requestedScopesByProvider: ReadonlyMap<ProviderId, readonly Scope[]>;
  readonly baselineRevisions: ReadonlyMap<ProviderId, number>;
  readonly staged: Map<ProviderId, TrackedProviderCallbackResult>;
  state: TrackedTransactionState;
}

const parseTransactionOptions = (
  options: BeginProviderCallbackTransactionOptions,
): Readonly<{
  readonly authSource: AuthSourceId;
  readonly inputMode: ProviderCallbackTransaction["inputMode"];
  readonly requestedScopes: readonly Scope[];
}> => {
  if (typeof options !== "object" || options === null) {
    throw new ProviderCallbackContractError("INVALID_CALLBACK_REQUEST");
  }
  const authSourceResult = authSourceIdSchema.safeParse(options.authSource);
  const inputModeResult = authInputModeSchema.safeParse(options.inputMode);
  const requestedScopesResult = scopeSchema.array().readonly().safeParse(options.requestedScopes);
  if (!authSourceResult.success || !inputModeResult.success || !requestedScopesResult.success) {
    throw new ProviderCallbackContractError("INVALID_CALLBACK_REQUEST");
  }
  if (new Set(requestedScopesResult.data).size !== requestedScopesResult.data.length) {
    throw new ProviderCallbackContractError("INVALID_CALLBACK_REQUEST", {
      authSource: authSourceResult.data,
    });
  }
  for (const scope of requestedScopesResult.data) {
    const provider = providerForScope(scope);
    if (!isProviderCallbackBindingAllowed(authSourceResult.data, provider)) {
      throw new ProviderCallbackContractError("BINDING_NOT_ALLOWED", {
        authSource: authSourceResult.data,
        provider,
      });
    }
  }
  return Object.freeze({
    authSource: authSourceResult.data,
    inputMode: inputModeResult.data,
    requestedScopes: requestedScopesResult.data,
  });
};

const groupScopes = (scopes: readonly Scope[]): ReadonlyMap<ProviderId, readonly Scope[]> => {
  const grouped = new Map<ProviderId, Scope[]>();
  for (const scope of scopes) {
    const provider = providerForScope(scope);
    const providerScopes = grouped.get(provider) ?? [];
    providerScopes.push(scope);
    grouped.set(provider, providerScopes);
  }
  return new Map(
    [...grouped].map(([provider, providerScopes]) => [provider, Object.freeze(providerScopes)]),
  );
};

const scopesEqual = (left: readonly Scope[], right: readonly Scope[]): boolean =>
  left.length === right.length && left.every((scope, index) => scope === right[index]);

export class InMemoryProviderCallbackTransactionManager implements ProviderCallbackTransactionManager {
  readonly #httpSessions: ProviderHttpSessionRegistry;
  readonly #knownTransactions = new WeakMap<
    ProviderCallbackTransaction,
    TrackedProviderCallbackTransaction
  >();
  readonly #providerRevisions = new Map<ProviderId, number>();
  readonly #sessions = new Map<ProviderId, ProviderSession>();

  readonly createTransport: ProviderCallbackTransportFactory = (context) => {
    context.signal.throwIfAborted();
    return this.#httpSessions.createStaged(context.provider);
  };

  constructor(httpSessions: ProviderHttpSessionRegistry) {
    if (!(httpSessions instanceof ProviderHttpSessionRegistry)) {
      throw new ProviderCallbackContractError("INVALID_HTTP_SESSION_REGISTRY");
    }
    this.#httpSessions = httpSessions;
  }

  begin(options: BeginProviderCallbackTransactionOptions): ProviderCallbackTransaction {
    const parsed = parseTransactionOptions(options);
    const requestedScopesByProvider = groupScopes(parsed.requestedScopes);
    const token = Object.freeze({
      authSource: parsed.authSource,
      inputMode: parsed.inputMode,
      requestedScopes: parsed.requestedScopes,
    }) as ProviderCallbackTransaction;
    const baselineRevisions = new Map(
      [...requestedScopesByProvider.keys()].map((provider) => [
        provider,
        this.#providerRevisions.get(provider) ?? 0,
      ]),
    );
    const tracked: TrackedProviderCallbackTransaction = {
      token,
      authSource: parsed.authSource,
      requestedScopesByProvider,
      baselineRevisions,
      staged: new Map(),
      state: "staging",
    };
    this.#knownTransactions.set(token, tracked);
    return token;
  }

  stage(
    transaction: ProviderCallbackTransaction,
    options: StageProviderCallbackResultOptions,
  ): void {
    const tracked = this.#requireActive(transaction);
    const provider = providerIdSchema.parse(options.expectedProvider);
    if (tracked.staged.has(provider)) {
      throw new ProviderCallbackContractError("DUPLICATE_PROVIDER_RESULT", {
        authSource: tracked.authSource,
        provider,
      });
    }

    const requestedScopesResult = scopeSchema.array().readonly().safeParse(options.requestedScopes);
    const plannedScopes = tracked.requestedScopesByProvider.get(provider);
    if (
      !requestedScopesResult.success ||
      plannedScopes === undefined ||
      !scopesEqual(requestedScopesResult.data, plannedScopes)
    ) {
      throw new ProviderCallbackContractError("RESULT_SCOPE_NOT_REQUESTED", {
        authSource: tracked.authSource,
        provider,
      });
    }

    const result = providerSessionSchema.safeParse(options.result);
    if (!result.success) {
      throw new ProviderCallbackContractError("INVALID_PROVIDER_SESSION", {
        authSource: tracked.authSource,
        provider,
      });
    }
    if (result.data.provider !== provider) {
      throw new ProviderCallbackContractError("RESULT_PROVIDER_MISMATCH", {
        authSource: tracked.authSource,
        provider,
      });
    }
    if (result.data.authenticatedBy !== tracked.authSource) {
      throw new ProviderCallbackContractError("RESULT_AUTH_SOURCE_MISMATCH", {
        authSource: tracked.authSource,
        provider,
      });
    }
    const requestedScopeSet = new Set(plannedScopes);
    if (result.data.grantedScopes.some((scope) => !requestedScopeSet.has(scope))) {
      throw new ProviderCallbackContractError("RESULT_SCOPE_NOT_REQUESTED", {
        authSource: tracked.authSource,
        provider,
      });
    }

    this.#httpSessions.assertStaged(provider, options.transport);
    tracked.staged.set(
      provider,
      Object.freeze({
        provider,
        requestedScopes: requestedScopesResult.data,
        result: result.data,
        transport: options.transport,
      }),
    );
  }

  commit(transaction: ProviderCallbackTransaction): ProviderCallbackCommit {
    const tracked = this.#requireActive(transaction);
    if (
      tracked.staged.size !== tracked.requestedScopesByProvider.size ||
      [...tracked.requestedScopesByProvider.keys()].some(
        (provider) => !tracked.staged.has(provider),
      )
    ) {
      throw new ProviderCallbackContractError("INCOMPLETE_TRANSACTION", {
        authSource: tracked.authSource,
      });
    }
    for (const [provider, revision] of tracked.baselineRevisions) {
      if ((this.#providerRevisions.get(provider) ?? 0) !== revision) {
        throw new ProviderCallbackContractError("STALE_TRANSACTION", {
          authSource: tracked.authSource,
          provider,
        });
      }
    }

    const staged = [...tracked.staged.values()];
    const cleanup = this.#httpSessions.commitStaged(
      staged.map(({ provider, transport }) => ({ provider, transport })),
    );
    for (const { provider, result } of staged) {
      this.#sessions.set(provider, result);
      this.#providerRevisions.set(provider, (this.#providerRevisions.get(provider) ?? 0) + 1);
    }
    tracked.state = "committed";
    tracked.staged.clear();
    return Object.freeze({ sessions: this.getSnapshot(), cleanup });
  }

  async rollback(transaction: ProviderCallbackTransaction): Promise<void> {
    const tracked = this.#requireActive(transaction);
    tracked.state = "rolled-back";
    const transports = [...tracked.staged.values()].map(({ transport }) => transport);
    tracked.staged.clear();
    const results = await Promise.allSettled(
      transports.map(async (transport) => this.#httpSessions.discardStaged(transport)),
    );
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
  }

  getSnapshot(): readonly ProviderSession[] {
    return Object.freeze(
      providerIds.flatMap((provider) => {
        const session = this.#sessions.get(provider);
        return session === undefined ? [] : [session];
      }),
    );
  }

  #requireActive(transaction: ProviderCallbackTransaction): TrackedProviderCallbackTransaction {
    if (typeof transaction !== "object" || transaction === null) {
      throw new ProviderCallbackContractError("TRANSACTION_NOT_ACTIVE");
    }
    const tracked = this.#knownTransactions.get(transaction);
    if (tracked === undefined) {
      throw new ProviderCallbackContractError("TRANSACTION_NOT_ACTIVE");
    }
    if (tracked.state !== "staging") {
      throw new ProviderCallbackContractError("STALE_TRANSACTION", {
        authSource: tracked.authSource,
      });
    }
    return tracked;
  }
}
