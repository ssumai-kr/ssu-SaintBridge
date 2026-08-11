import { z } from "zod";

export const providerIds = ["usaint", "lms", "library"] as const;
export const providerIdSchema = z.enum(providerIds);
export type ProviderId = z.infer<typeof providerIdSchema>;

export const authSourceIds = ["smartid", "library"] as const;
export const authSourceIdSchema = z.enum(authSourceIds);
export type AuthSourceId = z.infer<typeof authSourceIdSchema>;

export const providerAuthenticationSources = ["public", ...authSourceIds] as const;
export const providerAuthenticationSourceSchema = z.enum(providerAuthenticationSources);
export type ProviderAuthenticationSource = z.infer<typeof providerAuthenticationSourceSchema>;

export const providerStatuses = ["ready", "expired", "limited", "unsupported"] as const;
export const providerStatusSchema = z.enum(providerStatuses);
export type ProviderStatus = z.infer<typeof providerStatusSchema>;

export const authSourceStatuses = [
  "authenticating",
  "authenticated",
  "expired",
  "unsupported",
] as const;
export const authSourceStatusSchema = z.enum(authSourceStatuses);
export type AuthSourceStatus = z.infer<typeof authSourceStatusSchema>;

export const authLifecycleStates = ["open", "closed"] as const;
export const authLifecycleStateSchema = z.enum(authLifecycleStates);
export type AuthLifecycleState = z.infer<typeof authLifecycleStateSchema>;

export const authInputModes = ["official-browser", "application-credentials"] as const;
export const authInputModeSchema = z.enum(authInputModes);
export type AuthInputMode = z.infer<typeof authInputModeSchema>;

export const scopes = [
  "usaint:profile.read",
  "usaint:timetable.read",
  "usaint:courses.read",
  "usaint:grades.read",
  "usaint:graduation.read",
  "lms:courses.read",
  "lms:tasks.read",
  "lms:announcements.read",
  "lms:progress.read",
  "lms:attendance.read",
  "lms:grades.read",
  "library:catalog.read",
  "library:seats.read",
  "library:loans.read",
] as const;
export const scopeSchema = z.enum(scopes);
export type Scope = z.infer<typeof scopeSchema>;

export const sensitiveScopes = [
  "usaint:grades.read",
  "usaint:graduation.read",
  "lms:progress.read",
  "lms:attendance.read",
  "lms:grades.read",
  "library:loans.read",
] as const satisfies readonly Scope[];

const sensitiveScopeSet = new Set<Scope>(sensitiveScopes);

export const providerForScope = (scope: Scope): ProviderId =>
  providerIdSchema.parse(scope.slice(0, scope.indexOf(":")));

export const isSensitiveScope = (scope: Scope): boolean => sensitiveScopeSet.has(scope);

const scopedAuthRequestIssues = (request: {
  readonly authSource: AuthSourceId;
  readonly scopes: readonly Scope[];
}): readonly string[] => {
  const issues: string[] = [];
  if (new Set(request.scopes).size !== request.scopes.length) {
    issues.push("Requested scopes must be unique.");
  }
  if (
    request.authSource === "library" &&
    request.scopes.some((scope) => providerForScope(scope) !== "library")
  ) {
    issues.push("Library authentication can only request library scopes.");
  }
  return issues;
};

const addScopedAuthRequestIssues = (
  request: { readonly authSource: AuthSourceId; readonly scopes: readonly Scope[] },
  addIssue: (message: string) => void,
): void => {
  for (const message of scopedAuthRequestIssues(request)) addIssue(message);
};

export const interactiveBrowserLoginRequestSchema = z
  .object({
    authSource: authSourceIdSchema,
    mode: z.literal("official-browser"),
    scopes: z.array(scopeSchema).readonly(),
  })
  .strict()
  .superRefine((request, context) =>
    addScopedAuthRequestIssues(request, (message) => context.addIssue({ code: "custom", message })),
  )
  .readonly();
export type InteractiveBrowserLoginRequest = z.infer<typeof interactiveBrowserLoginRequestSchema>;

export const applicationCredentialLoginMetadataSchema = z
  .object({
    authSource: authSourceIdSchema,
    mode: z.literal("application-credentials"),
    scopes: z.array(scopeSchema).readonly(),
  })
  .strict()
  .superRefine((request, context) =>
    addScopedAuthRequestIssues(request, (message) => context.addIssue({ code: "custom", message })),
  )
  .readonly();
export type ApplicationCredentialLoginMetadata = z.infer<
  typeof applicationCredentialLoginMetadataSchema
>;

export const authLoginMetadataSchema = z.discriminatedUnion("mode", [
  interactiveBrowserLoginRequestSchema,
  applicationCredentialLoginMetadataSchema,
]);
export type AuthLoginMetadata = z.infer<typeof authLoginMetadataSchema>;

// Compatibility aliases for the original interactive-only contract.
export const browserLoginRequestSchema = interactiveBrowserLoginRequestSchema;
export type BrowserLoginRequest = InteractiveBrowserLoginRequest;

export const providerCapabilityIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(100)
  .regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/);
export type ProviderCapabilityId = z.infer<typeof providerCapabilityIdSchema>;

export const providerCapabilitySchema = z
  .object({
    id: providerCapabilityIdSchema,
    available: z.boolean(),
  })
  .strict()
  .readonly();
export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;

const isoTimestampSchema = z.string().datetime({ offset: true });

export const providerSessionSchema = z
  .object({
    provider: providerIdSchema,
    authenticatedBy: providerAuthenticationSourceSchema,
    status: providerStatusSchema,
    grantedScopes: z.array(scopeSchema).readonly(),
    capabilities: z.array(providerCapabilitySchema).readonly(),
    expiresAt: isoTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((session, context) => {
    const uniqueScopes = new Set(session.grantedScopes);
    if (uniqueScopes.size !== session.grantedScopes.length) {
      context.addIssue({ code: "custom", message: "Provider session scopes must be unique." });
    }
    if ([...uniqueScopes].some((scope) => providerForScope(scope) !== session.provider)) {
      context.addIssue({
        code: "custom",
        message: "Provider session scopes must belong to the same provider.",
      });
    }
    if (session.authenticatedBy === "public" && session.provider !== "library") {
      context.addIssue({
        code: "custom",
        message: "Only the library provider supports unauthenticated public sessions.",
      });
    }
    if (session.authenticatedBy === "library" && session.provider !== "library") {
      context.addIssue({
        code: "custom",
        message: "Library authentication can only create library provider sessions.",
      });
    }

    const capabilityIds = session.capabilities.map(({ id }) => id);
    if (new Set(capabilityIds).size !== capabilityIds.length) {
      context.addIssue({ code: "custom", message: "Provider capabilities must be unique." });
    }
    if (
      session.status === "limited" &&
      !session.capabilities.some((capability) => !capability.available)
    ) {
      context.addIssue({
        code: "custom",
        message: "A limited provider must describe at least one unavailable capability.",
      });
    }
    if (
      session.status === "unsupported" &&
      (session.grantedScopes.length > 0 ||
        session.capabilities.some((capability) => capability.available))
    ) {
      context.addIssue({
        code: "custom",
        message: "An unsupported provider cannot grant scopes or available capabilities.",
      });
    }
  })
  .readonly();
export type ProviderSession = z.infer<typeof providerSessionSchema>;

export const authSourceSessionSchema = z
  .object({
    source: authSourceIdSchema,
    inputMode: authInputModeSchema,
    status: authSourceStatusSchema,
    expiresAt: isoTimestampSchema.nullable(),
  })
  .strict()
  .readonly();
export type AuthSourceSession = z.infer<typeof authSourceSessionSchema>;

export const authSnapshotSchema = z
  .object({
    state: authLifecycleStateSchema,
    authSources: z.array(authSourceSessionSchema).readonly(),
    providers: z.array(providerSessionSchema).readonly(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const authSources = snapshot.authSources.map(({ source }) => source);
    if (new Set(authSources).size !== authSources.length) {
      context.addIssue({ code: "custom", message: "Authentication sources must be unique." });
    }
    const providers = snapshot.providers.map(({ provider }) => provider);
    if (new Set(providers).size !== providers.length) {
      context.addIssue({ code: "custom", message: "Provider sessions must be unique." });
    }
    if (snapshot.state === "closed" && (snapshot.authSources.length > 0 || providers.length > 0)) {
      context.addIssue({
        code: "custom",
        message: "A closed authentication lifecycle cannot expose active state.",
      });
    }
    for (const provider of snapshot.providers) {
      if (provider.authenticatedBy === "public") continue;
      const authSource = snapshot.authSources.find(
        ({ source }) => source === provider.authenticatedBy,
      );
      if (authSource === undefined) {
        context.addIssue({
          code: "custom",
          message: "An authenticated provider must reference an authentication source.",
        });
      } else if (
        (provider.status === "ready" || provider.status === "limited") &&
        authSource.status !== "authenticated"
      ) {
        context.addIssue({
          code: "custom",
          message: "A ready provider requires an authenticated source.",
        });
      }
    }
  })
  .readonly();
export type AuthSnapshot = z.infer<typeof authSnapshotSchema>;

const sourceUrlSchema = z
  .string()
  .url()
  .superRefine((value, context) => {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "Public source URLs must be credential-free HTTPS URLs without query or fragment.",
      });
    }
  });

export const sourceRefSchema = z
  .object({
    provider: providerIdSchema,
    sourceId: z.string().trim().min(1).max(200),
    fetchedAt: isoTimestampSchema,
    sourceUrl: sourceUrlSchema.optional(),
  })
  .strict()
  .readonly();
export type SourceRef = z.infer<typeof sourceRefSchema>;

export const providerDescriptorSchema = z
  .object({
    provider: providerIdSchema,
    supportedAuthSources: z.array(authSourceIdSchema).readonly(),
    supportsPublicAccess: z.boolean(),
    supportedScopes: z.array(scopeSchema).readonly(),
    capabilities: z.array(providerCapabilityIdSchema).readonly(),
  })
  .strict()
  .superRefine((descriptor, context) => {
    if (
      descriptor.supportedScopes.some((scope) => providerForScope(scope) !== descriptor.provider)
    ) {
      context.addIssue({ code: "custom", message: "Descriptor scopes must match its provider." });
    }
    if (
      descriptor.provider !== "library" &&
      (descriptor.supportsPublicAccess || descriptor.supportedAuthSources.includes("library"))
    ) {
      context.addIssue({
        code: "custom",
        message: "Only the library provider supports public or library-native authentication.",
      });
    }
    if (new Set(descriptor.supportedAuthSources).size !== descriptor.supportedAuthSources.length) {
      context.addIssue({ code: "custom", message: "Descriptor auth sources must be unique." });
    }
    if (new Set(descriptor.supportedScopes).size !== descriptor.supportedScopes.length) {
      context.addIssue({ code: "custom", message: "Descriptor scopes must be unique." });
    }
    if (new Set(descriptor.capabilities).size !== descriptor.capabilities.length) {
      context.addIssue({ code: "custom", message: "Descriptor capabilities must be unique." });
    }
  })
  .readonly();
export type ProviderDescriptor = z.infer<typeof providerDescriptorSchema>;
