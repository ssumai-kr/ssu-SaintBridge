import {
  providerDescriptorSchema,
  type AuthSourceId,
  type ProviderDescriptor,
  type ProviderId,
  type Scope,
} from "@ssu-saintbridge/types";

import type { ProviderAdapter } from "../../src/index.js";

const capabilitiesForScopes = (scopes: readonly Scope[]): readonly string[] =>
  scopes.map((scope) => scope.slice(scope.indexOf(":") + 1));

export const createProviderDescriptor = (options: {
  readonly provider: ProviderId;
  readonly supportedAuthSources: readonly AuthSourceId[];
  readonly supportedScopes: readonly Scope[];
}): ProviderDescriptor =>
  providerDescriptorSchema.parse({
    provider: options.provider,
    supportedAuthSources: options.supportedAuthSources,
    supportsPublicAccess: options.provider === "library",
    supportedScopes: options.supportedScopes,
    capabilities: capabilitiesForScopes(options.supportedScopes),
  });

export const createProviderAdapter = (descriptor: ProviderDescriptor): ProviderAdapter => ({
  descriptor,
  openSession: async () => {
    throw new Error("The provider adapter fixture must not be invoked while planning callbacks.");
  },
});

export const usaintAdapter = createProviderAdapter(
  createProviderDescriptor({
    provider: "usaint",
    supportedAuthSources: ["smartid"],
    supportedScopes: ["usaint:profile.read", "usaint:timetable.read"],
  }),
);

export const lmsAdapter = createProviderAdapter(
  createProviderDescriptor({
    provider: "lms",
    supportedAuthSources: ["smartid"],
    supportedScopes: ["lms:courses.read", "lms:tasks.read"],
  }),
);

export const libraryAdapter = createProviderAdapter(
  createProviderDescriptor({
    provider: "library",
    supportedAuthSources: ["smartid", "library"],
    supportedScopes: ["library:catalog.read", "library:loans.read"],
  }),
);
