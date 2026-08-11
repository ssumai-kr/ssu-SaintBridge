import type { AuthOrchestrator, BrowserLoginRequest } from "@ssu-saintbridge/auth";
import {
  authSnapshotSchema,
  providerForScope,
  providerIdSchema,
  providerSessionSchema,
  scopeSchema,
  type AuthSnapshot,
  type ProviderId,
  type ProviderSession,
  type Scope,
} from "@ssu-saintbridge/types";

export const mockUserKeys = ["mock-user-a", "mock-user-b"] as const;
export type MockUserKey = (typeof mockUserKeys)[number];

export const mockAllProviderScopes = [
  "usaint:profile.read",
  "lms:courses.read",
  "library:catalog.read",
] as const satisfies readonly Scope[];

const capabilityForScope = (scope: Scope): string => scope.slice(scope.indexOf(":") + 1);

const createProviderSessions = (scopes: readonly Scope[]): readonly ProviderSession[] => {
  const grouped = new Map<ProviderId, Scope[]>();
  for (const scope of scopes) {
    const provider = providerForScope(scope);
    const providerScopes = grouped.get(provider) ?? [];
    providerScopes.push(scope);
    grouped.set(provider, providerScopes);
  }

  return [...grouped.entries()].map(([provider, grantedScopes]) =>
    providerSessionSchema.parse({
      provider,
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
  #snapshot: AuthSnapshot = authSnapshotSchema.parse({ state: "signed-out", providers: [] });

  constructor(userKey: MockUserKey) {
    this.userKey = userKey;
  }

  async login(request: BrowserLoginRequest): Promise<AuthSnapshot> {
    if (this.#snapshot.state === "closed") throw new Error("The mock auth session is closed.");
    const scopes = request.scopes.map((scope) => scopeSchema.parse(scope));
    if (new Set(scopes).size !== scopes.length) {
      throw new TypeError("Requested scopes must be unique.");
    }
    this.#snapshot = authSnapshotSchema.parse({
      state: "identity-authenticated",
      providers: createProviderSessions(scopes),
    });
    return this.#snapshot;
  }

  getSnapshot(): AuthSnapshot {
    return this.#snapshot;
  }

  expireProvider(provider: ProviderId): AuthSnapshot {
    const parsedProvider = providerIdSchema.parse(provider);
    if (this.#snapshot.state !== "identity-authenticated") {
      throw new Error("The mock identity is not authenticated.");
    }
    const sessions = this.#snapshot.providers.map((session) =>
      session.provider === parsedProvider
        ? providerSessionSchema.parse({ ...session, status: "expired" })
        : session,
    );
    if (!sessions.some((session) => session.provider === parsedProvider)) {
      throw new Error("The mock provider session is not active.");
    }
    this.#snapshot = authSnapshotSchema.parse({
      state: "identity-authenticated",
      providers: sessions,
    });
    return this.#snapshot;
  }

  async close(): Promise<void> {
    this.#snapshot = authSnapshotSchema.parse({ state: "closed", providers: [] });
  }
}

export const createMockAuthMatrix = (): Readonly<Record<MockUserKey, MockAuthOrchestrator>> => ({
  "mock-user-a": new MockAuthOrchestrator("mock-user-a"),
  "mock-user-b": new MockAuthOrchestrator("mock-user-b"),
});
