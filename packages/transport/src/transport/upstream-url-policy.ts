export const officialUpstreamHosts = ["saint.ssu.ac.kr", "smartid.ssu.ac.kr"] as const;

export type UpstreamUrlPolicyViolation =
  | "INVALID_URL"
  | "NON_HTTPS"
  | "EMBEDDED_CREDENTIALS"
  | "UNEXPECTED_PORT"
  | "HOST_NOT_ALLOWED"
  | "FRAGMENT_NOT_ALLOWED";

const violationMessages: Readonly<Record<UpstreamUrlPolicyViolation, string>> = {
  INVALID_URL: "The upstream URL is invalid.",
  NON_HTTPS: "The upstream URL must use HTTPS.",
  EMBEDDED_CREDENTIALS: "Credentials must not be embedded in an upstream URL.",
  UNEXPECTED_PORT: "The upstream URL uses an unexpected port.",
  HOST_NOT_ALLOWED: "The upstream URL host is not allowed.",
  FRAGMENT_NOT_ALLOWED: "Fragments are not allowed in upstream URLs.",
};

export class UpstreamUrlPolicyError extends Error {
  readonly violation: UpstreamUrlPolicyViolation;

  constructor(violation: UpstreamUrlPolicyViolation) {
    super(violationMessages[violation]);
    this.name = "UpstreamUrlPolicyError";
    this.violation = violation;
  }

  toJSON(): { readonly name: string; readonly violation: UpstreamUrlPolicyViolation } {
    return { name: this.name, violation: this.violation };
  }
}

export interface UpstreamUrlPolicyOptions {
  readonly allowedHosts: readonly string[];
}

const hostnamePattern =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

const normalizeAllowedHost = (host: string): string => {
  const normalized = host.trim().toLowerCase();
  if (normalized !== host.toLowerCase() || !hostnamePattern.test(normalized)) {
    throw new TypeError("Allowed hosts must be plain DNS hostnames without paths or ports.");
  }
  return normalized;
};

export class UpstreamUrlPolicy {
  readonly #allowedHosts: ReadonlySet<string>;

  constructor(options: UpstreamUrlPolicyOptions) {
    if (options.allowedHosts.length === 0) {
      throw new TypeError("At least one upstream host must be allowed.");
    }
    this.#allowedHosts = new Set(options.allowedHosts.map(normalizeAllowedHost));
  }

  assertAllowed(input: string | URL): URL {
    let url: URL;
    try {
      url = new URL(input.toString());
    } catch {
      throw new UpstreamUrlPolicyError("INVALID_URL");
    }

    if (url.protocol !== "https:") {
      throw new UpstreamUrlPolicyError("NON_HTTPS");
    }
    if (url.username.length > 0 || url.password.length > 0) {
      throw new UpstreamUrlPolicyError("EMBEDDED_CREDENTIALS");
    }
    if (url.port.length > 0) {
      throw new UpstreamUrlPolicyError("UNEXPECTED_PORT");
    }
    if (!this.#allowedHosts.has(url.hostname.toLowerCase())) {
      throw new UpstreamUrlPolicyError("HOST_NOT_ALLOWED");
    }
    if (url.hash.length > 0) {
      throw new UpstreamUrlPolicyError("FRAGMENT_NOT_ALLOWED");
    }

    return url;
  }

  resolveRedirect(base: string | URL, location: string): URL {
    const allowedBase = this.assertAllowed(base);
    let redirect: URL;
    try {
      redirect = new URL(location, allowedBase);
    } catch {
      throw new UpstreamUrlPolicyError("INVALID_URL");
    }
    return this.assertAllowed(redirect);
  }
}

export const createOfficialUpstreamUrlPolicy = (): UpstreamUrlPolicy =>
  new UpstreamUrlPolicy({ allowedHosts: officialUpstreamHosts });
