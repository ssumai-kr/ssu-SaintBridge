import {
  AuthenticationExecutor,
  InMemoryProviderCallbackTransactionManager,
  ProviderAdapterRegistry,
  ProviderCallbackCoordinator,
  ProviderHttpSessionRegistry,
  StatefulProviderAuthenticationExecutor,
  createPreparedProviderAuthentication,
  parseAuthLoginRequest,
  type AuthLoginRequest,
  type AuthenticationExecutionContext,
  type AuthOrchestrator,
  type ProviderAdapter,
  type ProviderCallbackContext,
} from "@ssu-saintbridge/auth";
import {
  authSnapshotSchema,
  authSourceIdSchema,
  providerDescriptorSchema,
  providerForScope,
  providerIdSchema,
  providerIds,
  providerSessionSchema,
  scopeSchema,
  scopes,
  type AuthSnapshot,
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

export type MockAuthenticationHandler = (context: AuthenticationExecutionContext) => Promise<void>;

export type MockProviderCallbackHandler = (
  provider: ProviderId,
  context: ProviderCallbackContext,
) => Promise<void>;

export interface MockProviderTransportEvent {
  readonly type: "created" | "closed";
  readonly provider: ProviderId;
  readonly transportId: string;
}

export type MockProviderTransportHandler = (event: MockProviderTransportEvent) => void;

export interface MockAuthOrchestratorOptions {
  readonly authenticationHandler?: MockAuthenticationHandler;
  readonly providerCallbackHandler?: MockProviderCallbackHandler;
  readonly providerTransportHandler?: MockProviderTransportHandler;
}

const defaultMockAuthenticationHandler: MockAuthenticationHandler = async () => undefined;
const defaultMockProviderCallbackHandler: MockProviderCallbackHandler = async () => undefined;

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

const createProviderSession = (
  provider: ProviderId,
  authenticatedBy: ProviderAuthenticationSource,
  grantedScopes: readonly Scope[],
): ProviderSession => {
  for (const scope of grantedScopes) assertAuthenticationSupportsScope(authenticatedBy, scope);
  return providerSessionSchema.parse({
    provider,
    authenticatedBy,
    status: "ready",
    grantedScopes,
    capabilities: grantedScopes.map((scope) => ({
      id: capabilityForScope(scope),
      available: true,
    })),
    expiresAt: null,
  });
};

const createProviderSessions = (
  authenticatedBy: ProviderAuthenticationSource,
  requestedScopes: readonly Scope[],
): readonly ProviderSession[] => {
  const scopesByProvider = new Map<ProviderId, Scope[]>();
  for (const scope of requestedScopes) {
    assertAuthenticationSupportsScope(authenticatedBy, scope);
    const provider = providerForScope(scope);
    const providerScopes = scopesByProvider.get(provider) ?? [];
    providerScopes.push(scope);
    scopesByProvider.set(provider, providerScopes);
  }
  return providerIds.flatMap((provider) => {
    const providerScopes = scopesByProvider.get(provider);
    return providerScopes === undefined
      ? []
      : [createProviderSession(provider, authenticatedBy, providerScopes)];
  });
};

const createMockProviderAdapter = (
  provider: ProviderId,
  callbackHandler: MockProviderCallbackHandler,
): ProviderAdapter => {
  const supportedScopes = scopes.filter((scope) => providerForScope(scope) === provider);
  return Object.freeze({
    descriptor: providerDescriptorSchema.parse({
      provider,
      supportedAuthSources: provider === "library" ? ["smartid", "library"] : ["smartid"],
      supportsPublicAccess: provider === "library",
      supportedScopes,
      capabilities: supportedScopes.map(capabilityForScope),
    }),
    openSession: async (context: ProviderCallbackContext) => {
      await callbackHandler(provider, context);
      return createProviderSession(provider, context.authSource, context.requestedScopes);
    },
  });
};

class MockProviderHttpSession {
  readonly #provider: ProviderId;
  readonly #transportId: string;
  readonly #eventHandler: MockProviderTransportHandler | undefined;
  #closed = false;

  constructor(
    provider: ProviderId,
    transportId: string,
    eventHandler: MockProviderTransportHandler | undefined,
  ) {
    this.#provider = provider;
    this.#transportId = transportId;
    this.#eventHandler = eventHandler;
  }

  async request(): Promise<never> {
    throw new Error("Mock provider transports do not perform network requests.");
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#eventHandler?.(
      Object.freeze({
        type: "closed",
        provider: this.#provider,
        transportId: this.#transportId,
      }),
    );
  }
}

interface MockAuthenticationRuntime {
  readonly executor: StatefulProviderAuthenticationExecutor<void>;
  readonly httpSessions: ProviderHttpSessionRegistry;
}

const createMockAuthenticationRuntime = (
  options: MockAuthOrchestratorOptions,
): MockAuthenticationRuntime => {
  const authenticationHandler = options.authenticationHandler ?? defaultMockAuthenticationHandler;
  const callbackHandler = options.providerCallbackHandler ?? defaultMockProviderCallbackHandler;
  const adapters = providerIds.map((provider) =>
    createMockProviderAdapter(provider, callbackHandler),
  );
  let nextTransportId = 0;
  const httpSessions = new ProviderHttpSessionRegistry(
    providerIds.map((provider) => ({
      provider,
      allowedHosts: [`${provider}.example.invalid`],
    })),
    {
      sessionFactory: ({ provider }) => {
        const transportId = `${provider}:${nextTransportId}`;
        nextTransportId += 1;
        options.providerTransportHandler?.(
          Object.freeze({ type: "created", provider, transportId }),
        );
        return new MockProviderHttpSession(provider, transportId, options.providerTransportHandler);
      },
    },
  );
  const transactions = new InMemoryProviderCallbackTransactionManager(httpSessions);
  const coordinator = new ProviderCallbackCoordinator({
    adapters: new ProviderAdapterRegistry(
      adapters.map((adapter) => ({ provider: adapter.descriptor.provider, adapter })),
    ),
    transactions,
    createTransport: transactions.createTransport,
  });
  const execute = async (context: AuthenticationExecutionContext) => {
    await authenticationHandler(context);
    return createPreparedProviderAuthentication(
      undefined,
      await coordinator.prepare({
        authSource: context.authSource,
        inputMode: context.inputMode,
        requestedScopes: context.requestedScopes,
        signal: context.signal,
      }),
    );
  };
  const executor = new StatefulProviderAuthenticationExecutor(
    new AuthenticationExecutor({
      officialBrowser: execute,
      applicationCredentials: execute,
    }),
    coordinator,
  );
  return Object.freeze({ executor, httpSessions });
};

export class MockAuthOrchestrator implements AuthOrchestrator {
  readonly userKey: MockUserKey;
  readonly #authenticationExecutor: StatefulProviderAuthenticationExecutor<void>;
  readonly #httpSessions: ProviderHttpSessionRegistry;
  readonly #visibleProvidersBySource = new Map<AuthSourceId, ReadonlySet<ProviderId>>();
  readonly #expiredProviders = new Set<ProviderId>();
  #publicLibrary: ProviderSession | undefined;
  #closed = false;

  constructor(userKey: MockUserKey, options: MockAuthOrchestratorOptions = {}) {
    this.userKey = userKey;
    const runtime = createMockAuthenticationRuntime(options);
    this.#authenticationExecutor = runtime.executor;
    this.#httpSessions = runtime.httpSessions;
  }

  async login(request: AuthLoginRequest): Promise<AuthSnapshot> {
    this.#assertOpen();
    const parsedRequest = parseAuthLoginRequest(request);
    await this.#authenticationExecutor.execute(parsedRequest);

    const providerSet = new Set(parsedRequest.scopes.map(providerForScope));
    this.#visibleProvidersBySource.set(parsedRequest.authSource, providerSet);
    for (const provider of providerSet) this.#expiredProviders.delete(provider);
    if (providerSet.has("library")) this.#publicLibrary = undefined;
    return this.getSnapshot();
  }

  async logout(authSource: AuthSourceId): Promise<AuthSnapshot> {
    this.#assertOpen();
    const parsedSource = authSourceIdSchema.parse(authSource);
    const sourceIsActive = this.#authenticationExecutor
      .getSnapshot()
      .authSources.some(({ source }) => source === parsedSource);
    if (!sourceIsActive) return this.getSnapshot();

    const ownedProviders = this.#authenticationExecutor
      .getSnapshot()
      .providers.filter(({ authenticatedBy }) => authenticatedBy === parsedSource)
      .map(({ provider }) => provider);
    this.#authenticationExecutor.remove(parsedSource);
    this.#visibleProvidersBySource.delete(parsedSource);
    for (const provider of ownedProviders) {
      this.#expiredProviders.delete(provider);
      if (this.#httpSessions.has(provider)) await this.#httpSessions.closeProvider(provider);
    }
    return this.getSnapshot();
  }

  openPublicLibrary(requestedScopes: readonly Scope[]): AuthSnapshot {
    this.#assertOpen();
    const parsedScopes = requestedScopes.map((scope) => scopeSchema.parse(scope));
    const [publicLibrary] = createProviderSessions("public", parsedScopes);
    if (publicLibrary === undefined || publicLibrary.provider !== "library") {
      throw new TypeError("Public access requires at least one public library scope.");
    }
    this.#expiredProviders.delete("library");
    this.#publicLibrary = publicLibrary;
    return this.getSnapshot();
  }

  getSnapshot(): AuthSnapshot {
    if (this.#closed) {
      return authSnapshotSchema.parse({ state: "closed", authSources: [], providers: [] });
    }

    const productionSnapshot = this.#authenticationExecutor.getSnapshot();
    let providers = productionSnapshot.providers.filter((provider) => {
      if (provider.authenticatedBy === "public") return true;
      return this.#visibleProvidersBySource.get(provider.authenticatedBy)?.has(provider.provider);
    });
    if (this.#publicLibrary !== undefined) {
      providers = [
        ...providers.filter(({ provider }) => provider !== "library"),
        this.#publicLibrary,
      ];
    }
    providers = providers.map((provider) =>
      this.#expiredProviders.has(provider.provider)
        ? providerSessionSchema.parse({ ...provider, status: "expired" })
        : provider,
    );

    return authSnapshotSchema.parse({
      state: "open",
      authSources: productionSnapshot.authSources,
      providers,
    });
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
    if (!this.getSnapshot().providers.some((session) => session.provider === parsedProvider)) {
      throw new Error("The mock provider session is not active.");
    }
    this.#expiredProviders.add(parsedProvider);
    return this.getSnapshot();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#visibleProvidersBySource.clear();
    this.#expiredProviders.clear();
    this.#publicLibrary = undefined;
    await this.#httpSessions.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("The mock auth session is closed.");
  }
}

export const createMockAuthMatrix = (): Readonly<Record<MockUserKey, MockAuthOrchestrator>> => ({
  "mock-user-a": new MockAuthOrchestrator("mock-user-a"),
  "mock-user-b": new MockAuthOrchestrator("mock-user-b"),
});
