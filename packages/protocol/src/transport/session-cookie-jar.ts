import { CookieJar } from "tough-cookie";

import { createOfficialUpstreamUrlPolicy, type UpstreamUrlPolicy } from "./upstream-url-policy.js";

export const maxSetCookieHeaders = 64;
export const maxSetCookieHeaderLength = 8_192;

export type SessionCookieJarViolation = "CLOSED" | "INVALID_SET_COOKIE" | "LIMIT_EXCEEDED";

const violationMessages: Readonly<Record<SessionCookieJarViolation, string>> = {
  CLOSED: "The session cookie jar is closed.",
  INVALID_SET_COOKIE: "The upstream response contained an invalid Set-Cookie header.",
  LIMIT_EXCEEDED: "The upstream response exceeded the Set-Cookie safety limit.",
};

export class SessionCookieJarError extends Error {
  readonly violation: SessionCookieJarViolation;

  constructor(violation: SessionCookieJarViolation) {
    super(violationMessages[violation]);
    this.name = "SessionCookieJarError";
    this.violation = violation;
  }

  toJSON(): { readonly name: string; readonly violation: SessionCookieJarViolation } {
    return { name: this.name, violation: this.violation };
  }
}

export interface SessionCookieJarOptions {
  readonly urlPolicy?: UpstreamUrlPolicy;
}

/**
 * Per-session, in-memory cookie storage. Cookie values are intentionally not serializable or exposed.
 */
export class SessionCookieJar {
  readonly #jar: CookieJar;
  readonly #urlPolicy: UpstreamUrlPolicy;
  #closed = false;

  constructor(options: SessionCookieJarOptions = {}) {
    this.#urlPolicy = options.urlPolicy ?? createOfficialUpstreamUrlPolicy();
    this.#jar = new CookieJar(undefined, {
      allowSecureOnLocal: false,
      allowSpecialUseDomain: false,
      looseMode: false,
      prefixSecurity: "strict",
      rejectPublicSuffixes: true,
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  async getCookieHeader(url: string | URL): Promise<string | null> {
    this.#assertOpen();
    const allowedUrl = this.#urlPolicy.assertAllowed(url);
    const header = await this.#jar.getCookieString(allowedUrl.toString());
    return header.length === 0 ? null : header;
  }

  async storeFromResponse(url: string | URL, setCookieHeaders: readonly string[]): Promise<void> {
    this.#assertOpen();
    const allowedUrl = this.#urlPolicy.assertAllowed(url);

    if (
      setCookieHeaders.length > maxSetCookieHeaders ||
      setCookieHeaders.some((header) => header.length > maxSetCookieHeaderLength)
    ) {
      throw new SessionCookieJarError("LIMIT_EXCEEDED");
    }

    try {
      for (const header of setCookieHeaders) {
        await this.#jar.setCookie(header, allowedUrl);
      }
    } catch {
      throw new SessionCookieJarError("INVALID_SET_COOKIE");
    }
  }

  async clear(): Promise<void> {
    this.#assertOpen();
    await this.#jar.removeAllCookies();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#jar.removeAllCookies();
    this.#closed = true;
  }

  toJSON(): { readonly closed: boolean } {
    return { closed: this.#closed };
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new SessionCookieJarError("CLOSED");
    }
  }
}
