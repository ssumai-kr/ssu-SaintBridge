import {
  authInputModeSchema,
  authSourceIdSchema,
  providerForScope,
  providerIds,
  scopeSchema,
  type AuthInputMode,
  type AuthSourceId,
  type ProviderId,
  type Scope,
} from "@ssu-saintbridge/types";

import { ProviderAdapterRegistry } from "./provider-adapter-registry.js";
import {
  ProviderCallbackContractError,
  isProviderCallbackBindingAllowed,
} from "./provider-callback-transaction.js";

export interface CreateProviderCallbackPlanOptions {
  readonly authSource: AuthSourceId;
  readonly inputMode: AuthInputMode;
  readonly requestedScopes: readonly Scope[];
}

export interface ProviderCallbackPlanEntry {
  readonly provider: ProviderId;
  readonly requestedScopes: readonly Scope[];
}

export interface ProviderCallbackPlan {
  readonly authSource: AuthSourceId;
  readonly inputMode: AuthInputMode;
  readonly callbacks: readonly ProviderCallbackPlanEntry[];
}

const parsePlanOptions = (
  options: CreateProviderCallbackPlanOptions,
): Readonly<{
  readonly authSource: AuthSourceId;
  readonly inputMode: AuthInputMode;
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
  return Object.freeze({
    authSource: authSourceResult.data,
    inputMode: inputModeResult.data,
    requestedScopes: requestedScopesResult.data,
  });
};

export const createProviderCallbackPlan = (
  options: CreateProviderCallbackPlanOptions,
  registry: ProviderAdapterRegistry,
): ProviderCallbackPlan => {
  if (!(registry instanceof ProviderAdapterRegistry)) {
    throw new ProviderCallbackContractError("INVALID_ADAPTER_REGISTRY");
  }
  const parsed = parsePlanOptions(options);
  const scopesByProvider = new Map<ProviderId, Scope[]>();

  for (const scope of parsed.requestedScopes) {
    const provider = providerForScope(scope);
    if (!isProviderCallbackBindingAllowed(parsed.authSource, provider)) {
      throw new ProviderCallbackContractError("BINDING_NOT_ALLOWED", {
        authSource: parsed.authSource,
        provider,
      });
    }
    const providerScopes = scopesByProvider.get(provider) ?? [];
    providerScopes.push(scope);
    scopesByProvider.set(provider, providerScopes);
  }

  const callbacks = providerIds.flatMap((provider): readonly ProviderCallbackPlanEntry[] => {
    const requestedScopes = scopesByProvider.get(provider);
    if (requestedScopes === undefined) return [];

    const adapter = registry.get(provider);
    if (!adapter.descriptor.supportedAuthSources.includes(parsed.authSource)) {
      throw new ProviderCallbackContractError("AUTH_SOURCE_NOT_SUPPORTED", {
        authSource: parsed.authSource,
        provider,
      });
    }
    if (requestedScopes.some((scope) => !adapter.descriptor.supportedScopes.includes(scope))) {
      throw new ProviderCallbackContractError("SCOPE_NOT_SUPPORTED", {
        authSource: parsed.authSource,
        provider,
      });
    }

    return [
      Object.freeze({
        provider,
        requestedScopes: Object.freeze([...requestedScopes]),
      }),
    ];
  });

  return Object.freeze({
    authSource: parsed.authSource,
    inputMode: parsed.inputMode,
    callbacks: Object.freeze(callbacks),
  });
};
