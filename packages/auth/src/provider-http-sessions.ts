import { FetchHttpSession, UpstreamUrlPolicy, type HttpSession } from "@ssu-saintbridge/transport";
import { providerIdSchema, type ProviderId } from "@ssu-saintbridge/types";

export type ProviderHttpSessionRegistryViolation =
  "CLOSED" | "DUPLICATE_PROVIDER" | "PROVIDER_NOT_CONFIGURED";

const violationMessages: Readonly<Record<ProviderHttpSessionRegistryViolation, string>> = {
  CLOSED: "The provider HTTP session registry is closed.",
  DUPLICATE_PROVIDER: "A provider HTTP session was configured more than once.",
  PROVIDER_NOT_CONFIGURED: "The requested provider HTTP session is not configured.",
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

const defaultSessionFactory: ProviderHttpSessionFactory = ({ urlPolicy }) =>
  new FetchHttpSession({ urlPolicy });

/**
 * Owns one private transport per provider for one local user session.
 * Create a separate registry for every user; registries never share cookie jars.
 */
export class ProviderHttpSessionRegistry {
  readonly #sessions = new Map<ProviderId, HttpSession>();
  #closed = false;

  constructor(
    configs: readonly ProviderHttpSessionConfig[],
    options: ProviderHttpSessionRegistryOptions = {},
  ) {
    const providers = configs.map(({ provider }) => providerIdSchema.parse(provider));
    if (new Set(providers).size !== providers.length) {
      throw new ProviderHttpSessionRegistryError("DUPLICATE_PROVIDER");
    }

    const prepared = configs.map((config) => ({
      provider: providerIdSchema.parse(config.provider),
      allowedHosts: Object.freeze([...config.allowedHosts]),
      urlPolicy: new UpstreamUrlPolicy({ allowedHosts: config.allowedHosts }),
    }));
    const sessionFactory = options.sessionFactory ?? defaultSessionFactory;
    for (const context of prepared) {
      this.#sessions.set(context.provider, sessionFactory(context));
    }
  }

  get(provider: ProviderId): HttpSession {
    if (this.#closed) throw new ProviderHttpSessionRegistryError("CLOSED");
    const session = this.#sessions.get(providerIdSchema.parse(provider));
    if (session === undefined) {
      throw new ProviderHttpSessionRegistryError("PROVIDER_NOT_CONFIGURED");
    }
    return session;
  }

  has(provider: ProviderId): boolean {
    return !this.#closed && this.#sessions.has(providerIdSchema.parse(provider));
  }

  async closeProvider(provider: ProviderId): Promise<void> {
    if (this.#closed) throw new ProviderHttpSessionRegistryError("CLOSED");
    const parsedProvider = providerIdSchema.parse(provider);
    const session = this.#sessions.get(parsedProvider);
    if (session === undefined) {
      throw new ProviderHttpSessionRegistryError("PROVIDER_NOT_CONFIGURED");
    }
    this.#sessions.delete(parsedProvider);
    await session.close();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const sessions = [...this.#sessions.values()];
    this.#sessions.clear();
    await Promise.all(sessions.map(async (session) => session.close()));
  }

  toJSON(): { readonly closed: boolean; readonly providers: readonly ProviderId[] } {
    return {
      closed: this.#closed,
      providers: this.#closed ? [] : Object.freeze([...this.#sessions.keys()].sort()),
    };
  }
}
