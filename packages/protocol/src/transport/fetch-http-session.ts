import {
  HttpSessionError,
  type HttpRequestBody,
  type HttpResponseHeaders,
  type HttpSession,
  type HttpSessionRequest,
  type HttpSessionResponse,
} from "./http-session.js";
import { SessionCookieJar } from "./session-cookie-jar.js";
import { createOfficialUpstreamUrlPolicy, type UpstreamUrlPolicy } from "./upstream-url-policy.js";

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchHttpSessionOptions {
  readonly fetchImplementation?: FetchImplementation;
  readonly urlPolicy?: UpstreamUrlPolicy;
}

const forbiddenRequestHeaders = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "proxy-authorization",
  "set-cookie",
  "transfer-encoding",
  "upgrade",
]);

const createRequestHeaders = (
  request: HttpSessionRequest,
  cookieHeader: string | null,
): Headers => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (forbiddenRequestHeaders.has(name.toLowerCase())) {
      throw new HttpSessionError("FORBIDDEN_REQUEST_HEADER");
    }
    headers.set(name, value);
  }
  if (cookieHeader !== null) headers.set("cookie", cookieHeader);
  return headers;
};

const createRequestBody = (body: HttpRequestBody | undefined): RequestInit["body"] => {
  if (body === undefined || typeof body === "string") return body;
  return Buffer.from(body);
};

const collectResponseHeaders = (headers: Headers): HttpResponseHeaders => {
  const collected: Record<string, readonly string[]> = {};
  for (const [name, value] of headers.entries()) {
    if (name.toLowerCase() === "set-cookie") continue;
    collected[name.toLowerCase()] = Object.freeze([value]);
  }
  return Object.freeze(collected);
};

/** Node fetch transport with manual redirects and private per-session cookies. */
export class FetchHttpSession implements HttpSession {
  readonly #cookieJar: SessionCookieJar;
  readonly #fetch: FetchImplementation;
  readonly #urlPolicy: UpstreamUrlPolicy;
  #closed = false;

  constructor(options: FetchHttpSessionOptions = {}) {
    this.#urlPolicy = options.urlPolicy ?? createOfficialUpstreamUrlPolicy();
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.#cookieJar = new SessionCookieJar({ urlPolicy: this.#urlPolicy });
  }

  async request(request: HttpSessionRequest): Promise<HttpSessionResponse> {
    if (this.#closed) throw new HttpSessionError("CLOSED");
    if ((request.method === "GET" || request.method === "HEAD") && request.body !== undefined) {
      throw new HttpSessionError("INVALID_REQUEST_BODY");
    }

    const url = this.#urlPolicy.assertAllowed(request.url);
    const cookieHeader = await this.#cookieJar.getCookieHeader(url);
    const headers = createRequestHeaders(request, cookieHeader);
    const body = createRequestBody(request.body);

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: request.method,
        headers,
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        ...(body === undefined ? {} : { body }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
    } catch {
      throw new HttpSessionError("NETWORK_FAILURE");
    }

    await this.#cookieJar.storeFromResponse(url, response.headers.getSetCookie());

    let bodyBytes: Uint8Array;
    try {
      bodyBytes = new Uint8Array(await response.arrayBuffer());
    } catch {
      throw new HttpSessionError("NETWORK_FAILURE");
    }

    return {
      status: response.status,
      url,
      headers: collectResponseHeaders(response.headers),
      body: bodyBytes,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#cookieJar.close();
    this.#closed = true;
  }

  toJSON(): { readonly closed: boolean } {
    return { closed: this.#closed };
  }
}
