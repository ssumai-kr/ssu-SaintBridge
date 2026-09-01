import type { HttpSession } from "@ssu-saintbridge/transport";
import {
  providerAuthenticationSourceSchema,
  providerForScope,
  providerIdSchema,
  providerSessionSchema,
  scopeSchema,
  type AuthInputMode,
  type AuthSourceId,
  type ProviderId,
  type ProviderSession,
  type Scope,
} from "@ssu-saintbridge/types";

import type { ProviderCallbackContext } from "./contracts.js";
import type { ProviderAdapterRegistry } from "./provider-adapter-registry.js";
import {
  createProviderCallbackPlan,
  type CreateProviderCallbackPlanOptions,
  type ProviderCallbackPlanEntry,
} from "./provider-callback-plan.js";
import {
  ProviderCallbackContractError,
  type ProviderCallbackContractViolation,
  type ProviderCallbackTransaction,
  type ProviderCallbackTransactionManager,
} from "./provider-callback-transaction.js";

export interface ProviderCallbackTransportFactoryContext {
  readonly authSource: AuthSourceId;
  readonly inputMode: AuthInputMode;
  readonly provider: ProviderId;
  readonly requestedScopes: readonly Scope[];
  readonly signal: AbortSignal;
}

export type ProviderCallbackTransportFactory = (
  context: ProviderCallbackTransportFactoryContext,
) => HttpSession | Promise<HttpSession>;

export interface ProviderCallbackCoordinatorOptions {
  readonly adapters: ProviderAdapterRegistry;
  readonly transactions: ProviderCallbackTransactionManager;
  readonly createTransport: ProviderCallbackTransportFactory;
}

export interface ExecuteProviderCallbacksOptions extends CreateProviderCallbackPlanOptions {
  readonly signal: AbortSignal;
}

const createContractError = (
  violation: ProviderCallbackContractViolation,
  authSource: AuthSourceId,
  provider: ProviderId,
): ProviderCallbackContractError =>
  new ProviderCallbackContractError(violation, { authSource, provider });

const readResultFields = (
  value: unknown,
  authSource: AuthSourceId,
  provider: ProviderId,
): Readonly<{
  readonly provider: unknown;
  readonly authenticatedBy: unknown;
  readonly grantedScopes: unknown;
}> => {
  if (typeof value !== "object" || value === null) {
    throw createContractError("INVALID_PROVIDER_SESSION", authSource, provider);
  }
  try {
    const result = value as Readonly<{
      provider?: unknown;
      authenticatedBy?: unknown;
      grantedScopes?: unknown;
    }>;
    return {
      provider: result.provider,
      authenticatedBy: result.authenticatedBy,
      grantedScopes: result.grantedScopes,
    };
  } catch {
    throw createContractError("INVALID_PROVIDER_SESSION", authSource, provider);
  }
};

export const validateProviderCallbackResult = (
  value: unknown,
  options: Readonly<{
    readonly authSource: AuthSourceId;
    readonly expectedProvider: ProviderId;
    readonly requestedScopes: readonly Scope[];
  }>,
): ProviderSession => {
  const fields = readResultFields(value, options.authSource, options.expectedProvider);
  const providerResult = providerIdSchema.safeParse(fields.provider);
  const authenticatedByResult = providerAuthenticationSourceSchema.safeParse(
    fields.authenticatedBy,
  );
  const grantedScopesResult = scopeSchema.array().readonly().safeParse(fields.grantedScopes);

  if (!providerResult.success || !authenticatedByResult.success || !grantedScopesResult.success) {
    throw createContractError(
      "INVALID_PROVIDER_SESSION",
      options.authSource,
      options.expectedProvider,
    );
  }
  if (providerResult.data !== options.expectedProvider) {
    throw createContractError(
      "RESULT_PROVIDER_MISMATCH",
      options.authSource,
      options.expectedProvider,
    );
  }
  if (authenticatedByResult.data !== options.authSource) {
    throw createContractError(
      "RESULT_AUTH_SOURCE_MISMATCH",
      options.authSource,
      options.expectedProvider,
    );
  }
  if (
    grantedScopesResult.data.some((scope) => providerForScope(scope) !== options.expectedProvider)
  ) {
    throw createContractError(
      "RESULT_SCOPE_NOT_OWNED",
      options.authSource,
      options.expectedProvider,
    );
  }
  const requestedScopeSet = new Set(options.requestedScopes);
  if (grantedScopesResult.data.some((scope) => !requestedScopeSet.has(scope))) {
    throw createContractError(
      "RESULT_SCOPE_NOT_REQUESTED",
      options.authSource,
      options.expectedProvider,
    );
  }

  const sessionResult = providerSessionSchema.safeParse(value);
  if (!sessionResult.success) {
    throw createContractError(
      "INVALID_PROVIDER_SESSION",
      options.authSource,
      options.expectedProvider,
    );
  }
  return sessionResult.data;
};

const parseTransport = (
  value: unknown,
  authSource: AuthSourceId,
  provider: ProviderId,
): HttpSession => {
  if (typeof value !== "object" || value === null) {
    throw createContractError("INVALID_PROVIDER_TRANSPORT", authSource, provider);
  }
  try {
    const candidate = value as Partial<HttpSession>;
    if (typeof candidate.request !== "function" || typeof candidate.close !== "function") {
      throw createContractError("INVALID_PROVIDER_TRANSPORT", authSource, provider);
    }
    return candidate as HttpSession;
  } catch (error: unknown) {
    if (error instanceof ProviderCallbackContractError) throw error;
    throw createContractError("INVALID_PROVIDER_TRANSPORT", authSource, provider);
  }
};

const closePreservingOriginalError = async (
  transport: HttpSession,
  originalError: unknown,
): Promise<never> => {
  try {
    await transport.close();
  } catch {
    // The callback or validation failure remains the primary error.
  }
  throw originalError;
};

const rollbackPreservingOriginalError = async (
  transactions: ProviderCallbackTransactionManager,
  transaction: ProviderCallbackTransaction,
  originalError: unknown,
): Promise<never> => {
  try {
    await transactions.rollback(transaction);
  } catch {
    // Cleanup failures must not replace the callback or stale-attempt failure.
  }
  throw originalError;
};

const createFactoryContext = (
  plan: Readonly<{
    readonly authSource: AuthSourceId;
    readonly inputMode: AuthInputMode;
  }>,
  callback: ProviderCallbackPlanEntry,
  signal: AbortSignal,
): ProviderCallbackTransportFactoryContext =>
  Object.freeze({
    authSource: plan.authSource,
    inputMode: plan.inputMode,
    provider: callback.provider,
    requestedScopes: callback.requestedScopes,
    signal,
  });

const createCallbackContext = (
  factoryContext: ProviderCallbackTransportFactoryContext,
  transport: HttpSession,
): ProviderCallbackContext =>
  Object.freeze({
    authSource: factoryContext.authSource,
    inputMode: factoryContext.inputMode,
    requestedScopes: factoryContext.requestedScopes,
    transport,
    signal: factoryContext.signal,
  });

export class ProviderCallbackCoordinator {
  readonly #adapters: ProviderAdapterRegistry;
  readonly #transactions: ProviderCallbackTransactionManager;
  readonly #createTransport: ProviderCallbackTransportFactory;

  constructor(options: ProviderCallbackCoordinatorOptions) {
    this.#adapters = options.adapters;
    this.#transactions = options.transactions;
    this.#createTransport = options.createTransport;
  }

  async execute(options: ExecuteProviderCallbacksOptions): Promise<readonly ProviderSession[]> {
    const plan = createProviderCallbackPlan(options, this.#adapters);
    const requestedScopes = Object.freeze(
      plan.callbacks.flatMap((callback) => callback.requestedScopes),
    );
    const transaction = this.#transactions.begin({
      authSource: plan.authSource,
      inputMode: plan.inputMode,
      requestedScopes,
    });

    try {
      for (const callback of plan.callbacks) {
        options.signal.throwIfAborted();
        const factoryContext = createFactoryContext(plan, callback, options.signal);
        let transport: HttpSession | undefined;

        try {
          transport = parseTransport(
            await this.#createTransport(factoryContext),
            plan.authSource,
            callback.provider,
          );
          options.signal.throwIfAborted();
          const adapter = this.#adapters.get(callback.provider);
          const result = await adapter.openSession(
            createCallbackContext(factoryContext, transport),
          );
          options.signal.throwIfAborted();
          const session = validateProviderCallbackResult(result, {
            authSource: plan.authSource,
            expectedProvider: callback.provider,
            requestedScopes: callback.requestedScopes,
          });
          this.#transactions.stage(transaction, {
            expectedProvider: callback.provider,
            requestedScopes: callback.requestedScopes,
            result: session,
            transport,
          });
          transport = undefined;
        } catch (error: unknown) {
          if (transport !== undefined) {
            await closePreservingOriginalError(transport, error);
          }
          throw error;
        }
      }

      options.signal.throwIfAborted();
      return await this.#transactions.commit(transaction);
    } catch (error: unknown) {
      return rollbackPreservingOriginalError(this.#transactions, transaction, error);
    }
  }
}
