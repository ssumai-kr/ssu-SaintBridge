import {
  providerDescriptorSchema,
  providerIdSchema,
  providerIds,
  type ProviderId,
} from "@ssu-saintbridge/types";

import type {
  ProviderAdapter,
  ProviderAdapterRegistration,
  ProviderAdapterRegistryInput,
  ProviderCallbackContext,
} from "./contracts.js";
import { ProviderCallbackContractError } from "./provider-callback-transaction.js";

const parseRegistryKey = (value: unknown): ProviderId => {
  const result = providerIdSchema.safeParse(value);
  if (!result.success) {
    throw new ProviderCallbackContractError("INVALID_REGISTRY_KEY");
  }
  return result.data;
};

const validateAdapter = (provider: ProviderId, value: unknown): ProviderAdapter => {
  if (typeof value !== "object" || value === null) {
    throw new ProviderCallbackContractError("INVALID_ADAPTER", { provider });
  }

  let descriptorValue: unknown;
  let openSessionValue: unknown;
  try {
    const candidate = value as Readonly<{
      descriptor?: unknown;
      openSession?: unknown;
    }>;
    descriptorValue = candidate.descriptor;
    openSessionValue = candidate.openSession;
  } catch {
    throw new ProviderCallbackContractError("INVALID_ADAPTER", { provider });
  }

  if (typeof openSessionValue !== "function") {
    throw new ProviderCallbackContractError("INVALID_ADAPTER", { provider });
  }

  const descriptorResult = providerDescriptorSchema.safeParse(descriptorValue);
  if (!descriptorResult.success) {
    throw new ProviderCallbackContractError("INVALID_ADAPTER_DESCRIPTOR", { provider });
  }
  if (descriptorResult.data.provider !== provider) {
    throw new ProviderCallbackContractError("ADAPTER_PROVIDER_MISMATCH", { provider });
  }

  const openSession = openSessionValue.bind(value) as ProviderAdapter["openSession"];
  return Object.freeze({
    descriptor: descriptorResult.data,
    openSession: (context: ProviderCallbackContext) => openSession(context),
  });
};

const readRegistration = (
  value: unknown,
): Readonly<{ readonly provider: unknown; readonly adapter: unknown }> => {
  if (typeof value !== "object" || value === null) {
    throw new ProviderCallbackContractError("INVALID_REGISTRY_KEY");
  }
  try {
    const registration = value as Partial<ProviderAdapterRegistration>;
    return { provider: registration.provider, adapter: registration.adapter };
  } catch {
    throw new ProviderCallbackContractError("INVALID_REGISTRY_KEY");
  }
};

/** A validated, immutable provider adapter lookup for one orchestrator. */
export class ProviderAdapterRegistry {
  readonly #adapters: ReadonlyMap<ProviderId, ProviderAdapter>;

  constructor(registrations: ProviderAdapterRegistryInput) {
    if (!Array.isArray(registrations)) {
      throw new ProviderCallbackContractError("INVALID_ADAPTER_REGISTRY");
    }

    const adapters = new Map<ProviderId, ProviderAdapter>();
    for (const registrationValue of registrations as readonly unknown[]) {
      const registration = readRegistration(registrationValue);
      const provider = parseRegistryKey(registration.provider);
      if (adapters.has(provider)) {
        throw new ProviderCallbackContractError("DUPLICATE_ADAPTER", { provider });
      }
      adapters.set(provider, validateAdapter(provider, registration.adapter));
    }
    this.#adapters = adapters;
  }

  get(provider: ProviderId): ProviderAdapter {
    const parsedProvider = parseRegistryKey(provider);
    const adapter = this.#adapters.get(parsedProvider);
    if (adapter === undefined) {
      throw new ProviderCallbackContractError("ADAPTER_NOT_REGISTERED", {
        provider: parsedProvider,
      });
    }
    return adapter;
  }

  has(provider: ProviderId): boolean {
    return this.#adapters.has(parseRegistryKey(provider));
  }

  toJSON(): { readonly providers: readonly ProviderId[] } {
    return {
      providers: Object.freeze(providerIds.filter((provider) => this.#adapters.has(provider))),
    };
  }
}
