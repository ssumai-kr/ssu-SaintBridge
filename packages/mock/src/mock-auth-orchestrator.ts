import {
  AuthenticationExecutor,
  StatefulAuthenticationExecutor,
  parseAuthLoginRequest,
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

export type MockAuthenticationHandler = (context: AuthenticationExecutionContext) => Promise<void>;

export interface MockAuthOrchestratorOptions {
  readonly authenticationHandler?: MockAuthenticationHandler;
}

const completeMockAuthentication = (
  context: AuthenticationExecutionContext,
): Readonly<MockAuthenticationExecution> =>
  Object.freeze({
    authSource: context.authSource,
    inputMode: context.inputMode,
    requestedScopes: context.requestedScopes,
  });

const defaultMockAuthenticationHandler: MockAuthenticationHandler = async () => undefined;

const createMockAuthenticationExecutor = (
  authenticationHandler: MockAuthenticationHandler,
): StatefulAuthenticationExecutor<MockAuthenticationExecution> =>
  new StatefulAuthenticationExecutor(
    new AuthenticationExecutor({
      officialBrowser: async (context) => {
        await authenticationHandler(context);
        return completeMockAuthentication(context);
      },
      applicationCredentials: async (context) => {
        await authenticationHandler(context);
        return completeMockAuthentication(context);
      },
    }),
  );

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
  readonly #authenticationExecutor: StatefulAuthenticationExecutor<MockAuthenticationExecution>;
  #providers: readonly ProviderSession[] = Object.freeze([]);
  #closed = false;

  constructor(userKey: MockUserKey, options: MockAuthOrchestratorOptions = {}) {
    this.userKey = userKey;
    this.#authenticationExecutor = createMockAuthenticationExecutor(
      options.authenticationHandler ?? defaultMockAuthenticationHandler,
    );
  }

  async login(request: AuthLoginRequest): Promise<AuthSnapshot> {
    this.#assertOpen();
    const parsedRequest = parseAuthLoginRequest(request);
    const openedProviders = createProviderSessions(parsedRequest.authSource, parsedRequest.scopes);
    const execution = await this.#authenticationExecutor.execute(parsedRequest);
    const authSource = execution.authSource;

    const openedProviderIds = new Set(openedProviders.map(({ provider }) => provider));
    this.#providers = Object.freeze([
      ...this.#providers.filter(
        (session) =>
          session.authenticatedBy !== authSource && !openedProviderIds.has(session.provider),
      ),
      ...openedProviders,
    ]);
    return this.getSnapshot();
  }

  async logout(authSource: AuthSourceId): Promise<AuthSnapshot> {
    this.#assertOpen();
    const parsedSource = authSourceIdSchema.parse(authSource);
    this.#authenticationExecutor.remove(parsedSource);
    this.#providers = Object.freeze(
      this.#providers.filter(({ authenticatedBy }) => authenticatedBy !== parsedSource),
    );
    return this.getSnapshot();
  }

  openPublicLibrary(scopes: readonly Scope[]): AuthSnapshot {
    this.#assertOpen();
    const parsedScopes = scopes.map((scope) => scopeSchema.parse(scope));
    const [publicLibrary] = createProviderSessions("public", parsedScopes);
    if (publicLibrary === undefined || publicLibrary.provider !== "library") {
      throw new TypeError("Public access requires at least one public library scope.");
    }
    this.#providers = Object.freeze([
      ...this.#providers.filter(({ provider }) => provider !== "library"),
      publicLibrary,
    ]);
    return this.getSnapshot();
  }

  getSnapshot(): AuthSnapshot {
    if (this.#closed) {
      return authSnapshotSchema.parse({ state: "closed", authSources: [], providers: [] });
    }

    const authSources = this.#authenticationExecutor.getSnapshot();
    const authSourceById = new Map(authSources.map((source) => [source.source, source]));
    const providers = this.#providers.flatMap((provider) => {
      if (provider.authenticatedBy === "public") return [provider];
      const authSource = authSourceById.get(provider.authenticatedBy);
      if (authSource === undefined) return [];
      if (authSource.status === "authenticated") return [provider];
      return [providerSessionSchema.parse({ ...provider, status: "expired" })];
    });

    return authSnapshotSchema.parse({ state: "open", authSources, providers });
  }

  expireAuthSource(authSource: AuthSourceId): AuthSnapshot {
    this.#assertOpen();
    const parsedSource = authSourceIdSchema.parse(authSource);
    this.#authenticationExecutor.expire(parsedSource);
    return this.getSnapshot();
  }

  expireProvider(provider: ProviderId): AuthSnapshot {
    this.#assertOpen();
    const parsedProvider = providerIdSchema.parse(provider);
    const sessions = this.#providers.map((session) =>
      session.provider === parsedProvider
        ? providerSessionSchema.parse({ ...session, status: "expired" })
        : session,
    );
    if (!sessions.some((session) => session.provider === parsedProvider)) {
      throw new Error("The mock provider session is not active.");
    }
    this.#providers = Object.freeze(sessions);
    return this.getSnapshot();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    for (const { source } of this.#authenticationExecutor.getSnapshot()) {
      this.#authenticationExecutor.remove(source);
    }
    this.#providers = Object.freeze([]);
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("The mock auth session is closed.");
  }
}

export const createMockAuthMatrix = (): Readonly<Record<MockUserKey, MockAuthOrchestrator>> => ({
  "mock-user-a": new MockAuthOrchestrator("mock-user-a"),
  "mock-user-b": new MockAuthOrchestrator("mock-user-b"),
});
