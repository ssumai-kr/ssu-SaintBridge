import {
  AuthenticationExecutor,
  type AuthLoginRequest,
  type AuthenticationExecutionContext,
  type AuthOrchestrator,
} from "@ssu-saintbridge/auth";
import {
  authSnapshotSchema,
  authSourceIdSchema,
  providerForScope,
  providerIdSchema,
  providerSessionSchema,
  scopeSchema,
  type AuthSnapshot,
  type AuthInputMode,
  type AuthSourceId,
  type ProviderAuthenticationSource,
  type ProviderId,
  type ProviderSession,
  type Scope,
} from "@ssu-saintbridge/types";

export const mockUserKeys = ["mock-user-a", "mock-user-b"] as const;
export type MockUserKey = (typeof mockUserKeys)[number];

export const mockSmartIdScopes = [
  "usaint:profile.read",
  "lms:courses.read",
] as const satisfies readonly Scope[];
export const mockLibraryScopes = ["library:loans.read"] as const satisfies readonly Scope[];
export const mockPublicLibraryScopes = [
  "library:catalog.read",
  "library:seats.read",
] as const satisfies readonly Scope[];
export const mockAllProviderScopes = [
  ...mockSmartIdScopes,
  ...mockLibraryScopes,
] as const satisfies readonly Scope[];

const publicLibraryScopeSet = new Set<Scope>(mockPublicLibraryScopes);

interface MockAuthenticationExecution {
  readonly authSource: AuthSourceId;
  readonly inputMode: AuthInputMode;
  readonly requestedScopes: readonly Scope[];
}

const completeMockAuthentication = (
  context: AuthenticationExecutionContext,
): Readonly<MockAuthenticationExecution> =>
  Object.freeze({
    authSource: context.authSource,
    inputMode: context.inputMode,
    requestedScopes: context.requestedScopes,
  });

const createMockAuthenticationExecutor = (): AuthenticationExecutor<MockAuthenticationExecution> =>
  new AuthenticationExecutor({
    officialBrowser: async (context) => completeMockAuthentication(context),
    applicationCredentials: async (context) => completeMockAuthentication(context),
  });

const capabilityForScope = (scope: Scope): string => scope.slice(scope.indexOf(":") + 1);

const assertAuthenticationSupportsScope = (
  authenticatedBy: ProviderAuthenticationSource,
  scope: Scope,
): void => {
  const provider = providerForScope(scope);
  if (authenticatedBy === "library" && provider !== "library") {
    throw new TypeError("Library authentication can only request library scopes.");
  }
  if (authenticatedBy === "public" && !publicLibraryScopeSet.has(scope)) {
    throw new TypeError("Public library access only supports public library scopes.");
  }
};

const createProviderSessions = (
  authenticatedBy: ProviderAuthenticationSource,
  scopes: readonly Scope[],
): readonly ProviderSession[] => {
  const grouped = new Map<ProviderId, Scope[]>();
  for (const scope of scopes) {
    assertAuthenticationSupportsScope(authenticatedBy, scope);
    const provider = providerForScope(scope);
    const providerScopes = grouped.get(provider) ?? [];
    providerScopes.push(scope);
    grouped.set(provider, providerScopes);
  }

  return [...grouped.entries()].map(([provider, grantedScopes]) =>
    providerSessionSchema.parse({
      provider,
      authenticatedBy,
      status: "ready",
      grantedScopes,
      capabilities: grantedScopes.map((scope) => ({
        id: capabilityForScope(scope),
        available: true,
      })),
      expiresAt: null,
    }),
  );
};

export class MockAuthOrchestrator implements AuthOrchestrator {
  readonly userKey: MockUserKey;
  readonly #authenticationExecutor = createMockAuthenticationExecutor();
  #snapshot: AuthSnapshot = authSnapshotSchema.parse({
    state: "open",
    authSources: [],
    providers: [],
  });

  constructor(userKey: MockUserKey) {
    this.userKey = userKey;
  }

  async login(request: AuthLoginRequest): Promise<AuthSnapshot> {
    this.#assertOpen();
    const execution = await this.#authenticationExecutor.execute(request);
    const authSource = execution.authSource;
    const scopes = execution.requestedScopes;

    const openedProviders = createProviderSessions(authSource, scopes);
    const openedProviderIds = new Set(openedProviders.map(({ provider }) => provider));
    this.#snapshot = authSnapshotSchema.parse({
      state: "open",
      authSources: [
        ...this.#snapshot.authSources.filter(({ source }) => source !== authSource),
        {
          source: authSource,
          inputMode: execution.inputMode,
          status: "authenticated",
          expiresAt: null,
        },
      ],
      providers: [
        ...this.#snapshot.providers.filter(
          (session) =>
            session.authenticatedBy !== authSource && !openedProviderIds.has(session.provider),
        ),
        ...openedProviders,
      ],
    });
    return this.#snapshot;
  }

  async logout(authSource: AuthSourceId): Promise<AuthSnapshot> {
    this.#assertOpen();
    const parsedSource = authSourceIdSchema.parse(authSource);
    this.#snapshot = authSnapshotSchema.parse({
      state: "open",
      authSources: this.#snapshot.authSources.filter(({ source }) => source !== parsedSource),
      providers: this.#snapshot.providers.filter(
        ({ authenticatedBy }) => authenticatedBy !== parsedSource,
      ),
    });
    return this.#snapshot;
  }

  openPublicLibrary(scopes: readonly Scope[]): AuthSnapshot {
    this.#assertOpen();
    const parsedScopes = scopes.map((scope) => scopeSchema.parse(scope));
    const [publicLibrary] = createProviderSessions("public", parsedScopes);
    if (publicLibrary === undefined || publicLibrary.provider !== "library") {
      throw new TypeError("Public access requires at least one public library scope.");
    }
    this.#snapshot = authSnapshotSchema.parse({
      state: "open",
      authSources: this.#snapshot.authSources,
      providers: [
        ...this.#snapshot.providers.filter(({ provider }) => provider !== "library"),
        publicLibrary,
      ],
    });
    return this.#snapshot;
  }

  getSnapshot(): AuthSnapshot {
    return this.#snapshot;
  }

  expireAuthSource(authSource: AuthSourceId): AuthSnapshot {
    this.#assertOpen();
    const parsedSource = authSourceIdSchema.parse(authSource);
    if (!this.#snapshot.authSources.some(({ source }) => source === parsedSource)) {
      throw new Error("The mock authentication source is not active.");
    }
    this.#snapshot = authSnapshotSchema.parse({
      state: "open",
      authSources: this.#snapshot.authSources.map((source) =>
        source.source === parsedSource ? { ...source, status: "expired" } : source,
      ),
      providers: this.#snapshot.providers.map((provider) =>
        provider.authenticatedBy === parsedSource
          ? providerSessionSchema.parse({ ...provider, status: "expired" })
          : provider,
      ),
    });
    return this.#snapshot;
  }

  expireProvider(provider: ProviderId): AuthSnapshot {
    this.#assertOpen();
    const parsedProvider = providerIdSchema.parse(provider);
    const sessions = this.#snapshot.providers.map((session) =>
      session.provider === parsedProvider
        ? providerSessionSchema.parse({ ...session, status: "expired" })
        : session,
    );
    if (!sessions.some((session) => session.provider === parsedProvider)) {
      throw new Error("The mock provider session is not active.");
    }
    this.#snapshot = authSnapshotSchema.parse({
      state: "open",
      authSources: this.#snapshot.authSources,
      providers: sessions,
    });
    return this.#snapshot;
  }

  async close(): Promise<void> {
    this.#snapshot = authSnapshotSchema.parse({
      state: "closed",
      authSources: [],
      providers: [],
    });
  }

  #assertOpen(): void {
    if (this.#snapshot.state === "closed") throw new Error("The mock auth session is closed.");
  }
}

export const createMockAuthMatrix = (): Readonly<Record<MockUserKey, MockAuthOrchestrator>> => ({
  "mock-user-a": new MockAuthOrchestrator("mock-user-a"),
  "mock-user-b": new MockAuthOrchestrator("mock-user-b"),
});
