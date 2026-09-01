import type { HttpSession } from "@ssu-saintbridge/transport";
import type {
  AuthInputMode,
  AuthSourceId,
  ProviderId,
  ProviderSession,
  Scope,
} from "@ssu-saintbridge/types";

export interface ProviderCallbackBindingRule {
  readonly authSource: AuthSourceId;
  readonly provider: ProviderId;
}

export const providerCallbackBindingRules = Object.freeze([
  Object.freeze({ authSource: "smartid", provider: "usaint" }),
  Object.freeze({ authSource: "smartid", provider: "lms" }),
  Object.freeze({ authSource: "smartid", provider: "library" }),
  Object.freeze({ authSource: "library", provider: "library" }),
] as const satisfies readonly ProviderCallbackBindingRule[]);

export const isProviderCallbackBindingAllowed = (
  authSource: AuthSourceId,
  provider: ProviderId,
): boolean =>
  providerCallbackBindingRules.some(
    (rule) => rule.authSource === authSource && rule.provider === provider,
  );

export const providerCallbackTransactionStates = ["staging", "committed", "rolled-back"] as const;
export type ProviderCallbackTransactionState = (typeof providerCallbackTransactionStates)[number];

export const providerCallbackTransactionEvents = ["stage", "commit", "rollback"] as const;
export type ProviderCallbackTransactionEvent = (typeof providerCallbackTransactionEvents)[number];

export interface ProviderCallbackTransactionRule {
  readonly from: ProviderCallbackTransactionState;
  readonly event: ProviderCallbackTransactionEvent;
  readonly to: ProviderCallbackTransactionState;
}

export const providerCallbackTransactionRules = Object.freeze([
  Object.freeze({ from: "staging", event: "stage", to: "staging" }),
  Object.freeze({ from: "staging", event: "commit", to: "committed" }),
  Object.freeze({ from: "staging", event: "rollback", to: "rolled-back" }),
] as const satisfies readonly ProviderCallbackTransactionRule[]);

export const getProviderCallbackTransactionTarget = (
  from: ProviderCallbackTransactionState,
  event: ProviderCallbackTransactionEvent,
): ProviderCallbackTransactionState | undefined =>
  providerCallbackTransactionRules.find((rule) => rule.from === from && rule.event === event)?.to;

declare const providerCallbackTransactionBrand: unique symbol;

/**
 * Identity-owned transaction token. Implementations must not attach transports,
 * callback results, credentials, or attempt ownership data to this public shape.
 */
export interface ProviderCallbackTransaction {
  readonly [providerCallbackTransactionBrand]: true;
  readonly authSource: AuthSourceId;
  readonly inputMode: AuthInputMode;
  readonly requestedScopes: readonly Scope[];
}

export interface BeginProviderCallbackTransactionOptions {
  readonly authSource: AuthSourceId;
  readonly inputMode: AuthInputMode;
  readonly requestedScopes: readonly Scope[];
}

/**
 * A validated callback result and the provider-owned transport backing it.
 * Transport ownership transfers to the manager only after `stage` returns.
 */
export interface StageProviderCallbackResultOptions {
  readonly expectedProvider: ProviderId;
  readonly requestedScopes: readonly Scope[];
  readonly result: ProviderSession;
  readonly transport: HttpSession;
}

/**
 * Owns staged callback results until an atomic commit transfers them to the
 * committed provider store. Rollback closes every staged transport and leaves
 * all previously committed and unrelated provider sessions unchanged.
 */
export interface ProviderCallbackTransactionManager {
  begin(options: BeginProviderCallbackTransactionOptions): ProviderCallbackTransaction;
  stage(
    transaction: ProviderCallbackTransaction,
    options: StageProviderCallbackResultOptions,
  ): void;
  commit(transaction: ProviderCallbackTransaction): Promise<readonly ProviderSession[]>;
  rollback(transaction: ProviderCallbackTransaction): Promise<void>;
  getSnapshot(): readonly ProviderSession[];
}

export const providerCallbackContractViolations = [
  "INVALID_CALLBACK_REQUEST",
  "INVALID_ADAPTER_REGISTRY",
  "INVALID_REGISTRY_KEY",
  "DUPLICATE_ADAPTER",
  "INVALID_ADAPTER",
  "INVALID_ADAPTER_DESCRIPTOR",
  "ADAPTER_PROVIDER_MISMATCH",
  "ADAPTER_NOT_REGISTERED",
  "AUTH_SOURCE_NOT_SUPPORTED",
  "BINDING_NOT_ALLOWED",
  "SCOPE_NOT_SUPPORTED",
  "INVALID_PROVIDER_TRANSPORT",
  "INVALID_HTTP_SESSION_REGISTRY",
  "RESULT_PROVIDER_MISMATCH",
  "RESULT_AUTH_SOURCE_MISMATCH",
  "RESULT_SCOPE_NOT_OWNED",
  "RESULT_SCOPE_NOT_REQUESTED",
  "DUPLICATE_PROVIDER_RESULT",
  "INVALID_PROVIDER_SESSION",
  "INCOMPLETE_TRANSACTION",
  "TRANSACTION_NOT_ACTIVE",
  "STALE_TRANSACTION",
] as const;
export type ProviderCallbackContractViolation = (typeof providerCallbackContractViolations)[number];

const violationMessages: Readonly<Record<ProviderCallbackContractViolation, string>> = {
  INVALID_CALLBACK_REQUEST: "The provider callback request is invalid.",
  INVALID_ADAPTER_REGISTRY: "The provider adapter registry is invalid.",
  INVALID_REGISTRY_KEY: "The provider adapter registry key is invalid.",
  DUPLICATE_ADAPTER: "A provider adapter was registered more than once.",
  INVALID_ADAPTER: "The provider adapter is invalid.",
  INVALID_ADAPTER_DESCRIPTOR: "The provider adapter descriptor is invalid.",
  ADAPTER_PROVIDER_MISMATCH: "The adapter descriptor does not match its registry key.",
  ADAPTER_NOT_REGISTERED: "The requested provider adapter is not registered.",
  AUTH_SOURCE_NOT_SUPPORTED: "The adapter does not support the requested authentication source.",
  BINDING_NOT_ALLOWED: "The authentication source cannot create this provider session.",
  SCOPE_NOT_SUPPORTED: "The adapter does not support a requested provider scope.",
  INVALID_PROVIDER_TRANSPORT: "The provider callback transport is invalid.",
  INVALID_HTTP_SESSION_REGISTRY: "The provider HTTP session registry is invalid.",
  RESULT_PROVIDER_MISMATCH: "The callback result belongs to a different provider.",
  RESULT_AUTH_SOURCE_MISMATCH: "The callback result is bound to a different authentication source.",
  RESULT_SCOPE_NOT_OWNED: "The callback result contains a scope owned by another provider.",
  RESULT_SCOPE_NOT_REQUESTED: "The callback result exceeds the provider-specific request.",
  DUPLICATE_PROVIDER_RESULT: "A provider callback result was staged more than once.",
  INVALID_PROVIDER_SESSION: "The callback result is not a valid provider session.",
  INCOMPLETE_TRANSACTION: "The provider callback transaction is incomplete.",
  TRANSACTION_NOT_ACTIVE: "The provider callback transaction is no longer active.",
  STALE_TRANSACTION: "The provider callback transaction no longer owns the staged update.",
};

export interface ProviderCallbackContractErrorContext {
  readonly authSource?: AuthSourceId;
  readonly provider?: ProviderId;
}

export class ProviderCallbackContractError extends Error {
  readonly violation: ProviderCallbackContractViolation;
  readonly authSource: AuthSourceId | undefined;
  readonly provider: ProviderId | undefined;

  constructor(
    violation: ProviderCallbackContractViolation,
    context: ProviderCallbackContractErrorContext = {},
  ) {
    super(violationMessages[violation]);
    this.name = "ProviderCallbackContractError";
    this.violation = violation;
    this.authSource = context.authSource;
    this.provider = context.provider;
  }

  toJSON(): {
    readonly name: string;
    readonly violation: ProviderCallbackContractViolation;
    readonly authSource?: AuthSourceId;
    readonly provider?: ProviderId;
  } {
    return {
      name: this.name,
      violation: this.violation,
      ...(this.authSource === undefined ? {} : { authSource: this.authSource }),
      ...(this.provider === undefined ? {} : { provider: this.provider }),
    };
  }
}
