import type { ProviderAdapter } from "@ssu-saintbridge/auth";
import { providerDescriptorSchema } from "@ssu-saintbridge/types";

export const lmsProviderDescriptor = providerDescriptorSchema.parse({
  provider: "lms",
  supportedAuthSources: ["smartid"],
  supportsPublicAccess: false,
  supportedScopes: [
    "lms:courses.read",
    "lms:tasks.read",
    "lms:announcements.read",
    "lms:progress.read",
    "lms:attendance.read",
    "lms:grades.read",
  ],
  capabilities: [
    "courses.read",
    "tasks.read",
    "announcements.read",
    "progress.read",
    "attendance.read",
    "grades.read",
  ],
});

export type LmsProviderAdapter = ProviderAdapter & {
  readonly descriptor: typeof lmsProviderDescriptor;
};
