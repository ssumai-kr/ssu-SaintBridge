import type { ProviderAdapter } from "@ssu-saintbridge/auth";
import { providerDescriptorSchema } from "@ssu-saintbridge/types";

export const libraryProviderDescriptor = providerDescriptorSchema.parse({
  provider: "library",
  supportedAuthSources: ["smartid", "library"],
  supportsPublicAccess: true,
  supportedScopes: ["library:catalog.read", "library:seats.read", "library:loans.read"],
  capabilities: ["catalog.read", "seats.read", "loans.read"],
});

export type LibraryProviderAdapter = ProviderAdapter & {
  readonly descriptor: typeof libraryProviderDescriptor;
};
