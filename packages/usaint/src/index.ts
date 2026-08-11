import type { ProviderAdapter } from "@ssu-saintbridge/auth";
import { providerDescriptorSchema } from "@ssu-saintbridge/types";

export const usaintProviderDescriptor = providerDescriptorSchema.parse({
  provider: "usaint",
  supportedScopes: [
    "usaint:profile.read",
    "usaint:timetable.read",
    "usaint:courses.read",
    "usaint:grades.read",
    "usaint:graduation.read",
  ],
  capabilities: [
    "profile.read",
    "timetable.read",
    "courses.read",
    "grades.read",
    "graduation.read",
  ],
});

export type UsaintProviderAdapter = ProviderAdapter & {
  readonly descriptor: typeof usaintProviderDescriptor;
};
