import { UpstreamUrlPolicy, UpstreamUrlPolicyError } from "@ssu-saintbridge/transport";
import { authSourceIds, authSourceIdSchema, type AuthSourceId } from "@ssu-saintbridge/types";

export type BrowserNavigationPolicyViolation = UpstreamUrlPolicyError["violation"];

export class BrowserNavigationPolicyError extends Error {
  readonly authSource: AuthSourceId;
  readonly violation: BrowserNavigationPolicyViolation;

  constructor(authSource: AuthSourceId, cause: UpstreamUrlPolicyError) {
    super("The browser navigation was rejected by the authentication source policy.", { cause });
    this.name = "BrowserNavigationPolicyError";
    this.authSource = authSource;
    this.violation = cause.violation;
  }

  toJSON(): {
    readonly name: string;
    readonly authSource: AuthSourceId;
    readonly violation: BrowserNavigationPolicyViolation;
  } {
    return {
      name: this.name,
      authSource: this.authSource,
      violation: this.violation,
    };
  }
}

export interface BrowserNavigationPolicyOptions {
  readonly authSource: AuthSourceId;
  readonly entryUrl: string | URL;
  readonly allowedHosts: readonly string[];
}

export class BrowserNavigationPolicy {
  readonly authSource: AuthSourceId;
  readonly #entryUrl: string;
  readonly #urlPolicy: UpstreamUrlPolicy;

  constructor(options: BrowserNavigationPolicyOptions) {
    this.authSource = authSourceIdSchema.parse(options.authSource);
    this.#urlPolicy = new UpstreamUrlPolicy({ allowedHosts: options.allowedHosts });
    this.#entryUrl = this.#assertAllowed(options.entryUrl).toString();
  }

  get entryUrl(): URL {
    return new URL(this.#entryUrl);
  }

  assertNavigation(input: string | URL): URL {
    return this.#assertAllowed(input);
  }

  resolveNavigation(base: string | URL, destination: string): URL {
    try {
      return this.#urlPolicy.resolveRedirect(base, destination);
    } catch (error: unknown) {
      if (error instanceof UpstreamUrlPolicyError) {
        throw new BrowserNavigationPolicyError(this.authSource, error);
      }
      throw error;
    }
  }

  #assertAllowed(input: string | URL): URL {
    try {
      return this.#urlPolicy.assertAllowed(input);
    } catch (error: unknown) {
      if (error instanceof UpstreamUrlPolicyError) {
        throw new BrowserNavigationPolicyError(this.authSource, error);
      }
      throw error;
    }
  }
}

export class BrowserNavigationPolicyRegistry {
  readonly #policies: ReadonlyMap<AuthSourceId, BrowserNavigationPolicy>;

  constructor(configurations: readonly BrowserNavigationPolicyOptions[]) {
    const policies = new Map<AuthSourceId, BrowserNavigationPolicy>();
    for (const configuration of configurations) {
      const policy = new BrowserNavigationPolicy(configuration);
      if (policies.has(policy.authSource)) {
        throw new TypeError(`Browser navigation policy for ${policy.authSource} is duplicated.`);
      }
      policies.set(policy.authSource, policy);
    }
    for (const authSource of authSourceIds) {
      if (!policies.has(authSource)) {
        throw new TypeError(`Browser navigation policy for ${authSource} is required.`);
      }
    }
    this.#policies = policies;
  }

  get(authSource: AuthSourceId): BrowserNavigationPolicy {
    const parsedSource = authSourceIdSchema.parse(authSource);
    const policy = this.#policies.get(parsedSource);
    if (policy === undefined) {
      throw new TypeError(`Browser navigation policy for ${parsedSource} is unavailable.`);
    }
    return policy;
  }
}
