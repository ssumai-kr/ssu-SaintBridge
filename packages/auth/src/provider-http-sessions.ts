import {
  FetchHttpSession,
  HttpSessionError,
  UpstreamUrlPolicy,
  type HttpSession,
  type HttpSessionRequest,
  type HttpSessionResponse,
} from "@ssu-saintbridge/transport";
import { providerIdSchema, providerIds, type ProviderId } from "@ssu-saintbridge/types";

export type ProviderHttpSessionRegistryViolation =
  | "CLOSED"
  | "DUPLICATE_PROVIDER"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_SESSION_NOT_ACTIVE"
  | "DUPLICATE_STAGED_PROVIDER"
  | "SESSION_NOT_STAGED"
  | "SESSION_PROVIDER_MISMATCH"
  | "INVALID_SESSION_FACTORY_RESULT"
  | "SESSION_FACTORY_REUSED_TRANSPORT";

const violationMessages: Readonly<Record<ProviderHttpSessionRegistryViolation, string>> = {
  CLOSED: "The provider HTTP session registry is closed.",
  DUPLICATE_PROVIDER: "A provider HTTP session was configured more than once.",
  PROVIDER_NOT_CONFIGURED: "The requested provider HTTP session is not configured.",
  PROVIDER_SESSION_NOT_ACTIVE: "The requested provider HTTP session is not active.",
  DUPLICATE_STAGED_PROVIDER: "A provider HTTP session was staged more than once.",
  SESSION_NOT_STAGED: "The provider HTTP session is not staged by this registry.",
  SESSION_PROVIDER_MISMATCH: "The staged HTTP session belongs to a different provider.",
  INVALID_SESSION_FACTORY_RESULT: "The provider HTTP session factory returned an invalid session.",
  SESSION_FACTORY_REUSED_TRANSPORT:
    "The provider HTTP session factory reused an existing transport.",
};

export class ProviderHttpSessionRegistryError extends Error {
  readonly violation: ProviderHttpSessionRegistryViolation;

  constructor(violation: ProviderHttpSessionRegistryViolation) {
    super(violationMessages[violation]);
    this.name = "ProviderHttpSessionRegistryError";
    this.violation = violation;
  }

  toJSON(): { readonly name: string; readonly violation: ProviderHttpSessionRegistryViolation } {
    return { name: this.name, violation: this.violation };
  }
}

export interface ProviderHttpSessionConfig {
  readonly provider: ProviderId;
  readonly allowedHosts: readonly string[];
}

export interface ProviderHttpSessionFactoryContext extends ProviderHttpSessionConfig {
  readonly urlPolicy: UpstreamUrlPolicy;
}

export type ProviderHttpSessionFactory = (
  context: ProviderHttpSessionFactoryContext,
) => HttpSession;

export interface ProviderHttpSessionRegistryOptions {
  readonly sessionFactory?: ProviderHttpSessionFactory;
}

export interface StagedProviderHttpSession {
  readonly provider: ProviderId;
  readonly transport: HttpSession;
}

const defaultSessionFactory: ProviderHttpSessionFactory = ({ urlPolicy }) =>
  new FetchHttpSession({ urlPolicy });

const parseFactoryResult = (value: unknown): HttpSession => {
  if (typeof value !== "object" || value === null) {
    throw new ProviderHttpSessionRegistryError("INVALID_SESSION_FACTORY_RESULT");
  }
  try {
    const session = value as Partial<HttpSession>;
    if (typeof session.request !== "function" || typeof session.close !== "function") {
      throw new ProviderHttpSessionRegistryError("INVALID_SESSION_FACTORY_RESULT");
    }
    return session as HttpSession;
  } catch (error: unknown) {
    if (error instanceof ProviderHttpSessionRegistryError) throw error;
    throw new ProviderHttpSessionRegistryError("INVALID_SESSION_FACTORY_RESULT");
  }
};

class ManagedProviderHttpSession implements HttpSession {
  readonly #inner: HttpSession;
  readonly #onClose: (session: ManagedProviderHttpSession) => void;
  #closed = false;

  constructor(inner: HttpSession, onClose: (session: ManagedProviderHttpSession) => void) {
    this.#inner = inner;
    this.#onClose = onClose;
  }

  request(request: HttpSessionRequest): Promise<HttpSessionResponse> {
    if (this.#closed) return Promise.reject(new HttpSessionError("CLOSED"));
    return this.#inner.request(request);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#inner.close();
    } finally {
      this.#onClose(this);
    }
  }

  toJSON(): { readonly closed: boolean } {
    return { closed: this.#closed };
  }
}

/**
 * Owns provider-isolated transports for one local user. New transports remain
 * staged until an atomic commit; rollback closes them without touching active
 * sessions belonging to other providers or previous authentication attempts.
 */
export class ProviderHttpSessionRegistry {
  readonly #configs: ReadonlyMap<ProviderId, ProviderHttpSessionFactoryContext>;
  readonly #sessionFactory: ProviderHttpSessionFactory;
  readonly #issuedInnerSessions = new WeakSet<object>();
  readonly #providerBySession = new WeakMap<HttpSession, ProviderId>();
  readonly #stagedSessions = new Map<HttpSession, ProviderId>();
  readonly #activeSessions = new Map<ProviderId, HttpSession>();
  #closed = false;

  constructor(
    configs: readonly ProviderHttpSessionConfig[],
    options: ProviderHttpSessionRegistryOptions = {},
  ) {
    const providers = configs.map(({ provider }) => providerIdSchema.parse(provider));
    if (new Set(providers).size !== providers.length) {
      throw new ProviderHttpSessionRegistryError("DUPLICATE_PROVIDER");
    }

    this.#configs = new Map(
      configs.map((config) => {
        const provider = providerIdSchema.parse(config.provider);
        const allowedHosts = Object.freeze([...config.allowedHosts]);
        return [
          provider,
          Object.freeze({
            provider,
            allowedHosts,
            urlPolicy: new UpstreamUrlPolicy({ allowedHosts }),
          }),
        ];
      }),
    );
    this.#sessionFactory = options.sessionFactory ?? defaultSessionFactory;
  }

  createStaged(provider: ProviderId): HttpSession {
    this.#assertOpen();
    const parsedProvider = providerIdSchema.parse(provider);
    const context = this.#configs.get(parsedProvider);
    if (context === undefined) {
      throw new ProviderHttpSessionRegistryError("PROVIDER_NOT_CONFIGURED");
    }

    let factoryResult: unknown;
    try {
      factoryResult = this.#sessionFactory(context);
    } catch {
      throw new ProviderHttpSessionRegistryError("INVALID_SESSION_FACTORY_RESULT");
    }
    const inner = parseFactoryResult(factoryResult);
    if (this.#issuedInnerSessions.has(inner)) {
      throw new ProviderHttpSessionRegistryError("SESSION_FACTORY_REUSED_TRANSPORT");
    }
    this.#issuedInnerSessions.add(inner);

    const managed = new ManagedProviderHttpSession(inner, (session) => this.#forget(session));
    this.#providerBySession.set(managed, parsedProvider);
    this.#stagedSessions.set(managed, parsedProvider);
    return managed;
  }

  assertStaged(provider: ProviderId, transport: HttpSession): void {
    this.#assertOpen();
    const parsedProvider = providerIdSchema.parse(provider);
    const ownedProvider = this.#providerBySession.get(transport);
    if (ownedProvider === undefined || this.#stagedSessions.get(transport) === undefined) {
      throw new ProviderHttpSessionRegistryError("SESSION_NOT_STAGED");
    }
    if (ownedProvider !== parsedProvider) {
      throw new ProviderHttpSessionRegistryError("SESSION_PROVIDER_MISMATCH");
    }
  }

  commitStaged(replacements: readonly StagedProviderHttpSession[]): Promise<void> {
    this.#assertOpen();
    const providers = replacements.map(({ provider }) => providerIdSchema.parse(provider));
    if (new Set(providers).size !== providers.length) {
      throw new ProviderHttpSessionRegistryError("DUPLICATE_STAGED_PROVIDER");
    }
    for (const replacement of replacements) {
      this.assertStaged(replacement.provider, replacement.transport);
    }

    const replaced: HttpSession[] = [];
    for (const replacement of replacements) {
      const provider = providerIdSchema.parse(replacement.provider);
      const previous = this.#activeSessions.get(provider);
      if (previous !== undefined) replaced.push(previous);
      this.#stagedSessions.delete(replacement.transport);
      this.#activeSessions.set(provider, replacement.transport);
    }

    return Promise.resolve()
      .then(() => Promise.allSettled(replaced.map(async (session) => session.close())))
      .then(() => undefined);
  }

  async discardStaged(transport: HttpSession): Promise<void> {
    this.#assertOpen();
    if (!this.#stagedSessions.has(transport)) {
      throw new ProviderHttpSessionRegistryError("SESSION_NOT_STAGED");
    }
    await transport.close();
  }

  get(provider: ProviderId): HttpSession {
    this.#assertOpen();
    const parsedProvider = providerIdSchema.parse(provider);
    if (!this.#configs.has(parsedProvider)) {
      throw new ProviderHttpSessionRegistryError("PROVIDER_NOT_CONFIGURED");
    }
    const session = this.#activeSessions.get(parsedProvider);
    if (session === undefined) {
      throw new ProviderHttpSessionRegistryError("PROVIDER_SESSION_NOT_ACTIVE");
    }
    return session;
  }

  has(provider: ProviderId): boolean {
    return !this.#closed && this.#activeSessions.has(providerIdSchema.parse(provider));
  }

  isConfigured(provider: ProviderId): boolean {
    return !this.#closed && this.#configs.has(providerIdSchema.parse(provider));
  }

  async closeProvider(provider: ProviderId): Promise<void> {
    this.#assertOpen();
    const parsedProvider = providerIdSchema.parse(provider);
    if (!this.#configs.has(parsedProvider)) {
      throw new ProviderHttpSessionRegistryError("PROVIDER_NOT_CONFIGURED");
    }
    const session = this.#activeSessions.get(parsedProvider);
    if (session === undefined) {
      throw new ProviderHttpSessionRegistryError("PROVIDER_SESSION_NOT_ACTIVE");
    }
    this.#activeSessions.delete(parsedProvider);
    await session.close();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const sessions = new Set([...this.#activeSessions.values(), ...this.#stagedSessions.keys()]);
    this.#activeSessions.clear();
    this.#stagedSessions.clear();
    await Promise.all([...sessions].map(async (session) => session.close()));
  }

  toJSON(): {
    readonly closed: boolean;
    readonly providers: readonly ProviderId[];
  } {
    return {
      closed: this.#closed,
      providers: this.#closed
        ? []
        : Object.freeze(providerIds.filter((provider) => this.#activeSessions.has(provider))),
    };
  }

  #assertOpen(): void {
    if (this.#closed) throw new ProviderHttpSessionRegistryError("CLOSED");
  }

  #forget(session: HttpSession): void {
    this.#stagedSessions.delete(session);
    const provider = this.#providerBySession.get(session);
    if (provider !== undefined && this.#activeSessions.get(provider) === session) {
      this.#activeSessions.delete(provider);
    }
  }
}
