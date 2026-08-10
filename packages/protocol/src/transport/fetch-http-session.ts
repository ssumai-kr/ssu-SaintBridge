import {
  HttpSessionError,
  type HttpRequestBody,
  type HttpResponseHeaders,
  type HttpSession,
  type HttpSessionRequest,
  type HttpSessionResponse,
} from "./http-session.js";
import { SessionCookieJar, SessionCookieJarError } from "./session-cookie-jar.js";
import { createOfficialUpstreamUrlPolicy, type UpstreamUrlPolicy } from "./upstream-url-policy.js";

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchHttpSessionOptions {
  readonly fetchImplementation?: FetchImplementation;
  readonly maxResponseBytes?: number;
  readonly maxRetries?: number;
  readonly requestTimeoutMs?: number;
  readonly retryBaseDelayMs?: number;
  readonly urlPolicy?: UpstreamUrlPolicy;
}

export const defaultRequestTimeoutMs = 30_000;
export const maximumRequestTimeoutMs = 120_000;
export const defaultMaxResponseBytes = 5 * 1024 * 1024;
export const maximumMaxResponseBytes = 20 * 1024 * 1024;
export const defaultMaxRetries = 1;
export const maximumMaxRetries = 2;
export const defaultRetryBaseDelayMs = 100;
export const maximumRetryBaseDelayMs = 1_000;

type AbortSource = "caller" | "closed" | "timeout";

interface ActiveRequest {
  readonly controller: AbortController;
  abortSource: AbortSource | null;
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
const retryableMethods = new Set<HttpSessionRequest["method"]>(["GET", "HEAD"]);
const retryableStatuses = new Set([502, 503, 504]);

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

const assertIntegerLimit = (name: string, value: number, maximum: number): number => {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return value;
};

const assertNonNegativeIntegerLimit = (name: string, value: number, maximum: number): number => {
  if (!Number.isInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${name} must be a non-negative integer no greater than ${maximum}.`);
  }
  return value;
};

const abortActiveRequest = (request: ActiveRequest, source: AbortSource): void => {
  if (request.abortSource !== null) return;
  request.abortSource = source;
  request.controller.abort();
};

const isAborted = (signal: AbortSignal | undefined): boolean => signal?.aborted === true;

interface AbortWaiter {
  readonly dispose: () => void;
  readonly promise: Promise<never>;
}

const createAbortWaiter = (signal: AbortSignal): AbortWaiter => {
  let rejectAborted: () => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    rejectAborted = (): void => reject(new Error("The HTTP operation was aborted."));
  });

  if (signal.aborted) rejectAborted();
  else signal.addEventListener("abort", rejectAborted, { once: true });

  return {
    dispose: () => signal.removeEventListener("abort", rejectAborted),
    promise,
  };
};

const runUntilAborted = async <Result>(
  operation: Promise<Result>,
  signal: AbortSignal,
): Promise<Result> => {
  const aborted = createAbortWaiter(signal);
  try {
    return await Promise.race([operation, aborted.promise]);
  } finally {
    aborted.dispose();
  }
};

const waitForRetryDelay = async (delayMs: number, signal: AbortSignal): Promise<void> => {
  const aborted = createAbortWaiter(signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, delayMs);
  });

  try {
    await Promise.race([elapsed, aborted.promise]);
  } finally {
    aborted.dispose();
    if (timer !== undefined) clearTimeout(timer);
  }
};

const responseExceedsDeclaredLimit = (response: Response, maximumBytes: number): boolean => {
  const contentLength = response.headers.get("content-length");
  return (
    contentLength !== null &&
    /^\d+$/.test(contentLength) &&
    BigInt(contentLength) > BigInt(maximumBytes)
  );
};

const cancelResponseBody = (response: Response): void => {
  response.body?.cancel().catch(() => undefined);
};

const readResponseBody = async (
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<Uint8Array> => {
  if (responseExceedsDeclaredLimit(response, maximumBytes)) {
    cancelResponseBody(response);
    throw new HttpSessionError("RESPONSE_TOO_LARGE");
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let completed = false;

  const aborted = createAbortWaiter(signal);
  try {
    while (true) {
      const result = await Promise.race([reader.read(), aborted.promise]);
      if (result.done) {
        completed = true;
        break;
      }

      totalBytes += result.value.byteLength;
      if (totalBytes > maximumBytes) {
        reader.cancel().catch(() => undefined);
        throw new HttpSessionError("RESPONSE_TOO_LARGE");
      }
      chunks.push(result.value);
    }
  } finally {
    aborted.dispose();
    if (!completed) reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};

/** Node fetch transport with manual redirects and private per-session cookies. */
export class FetchHttpSession implements HttpSession {
  readonly #activeRequests = new Set<ActiveRequest>();
  readonly #cookieJar: SessionCookieJar;
  readonly #fetch: FetchImplementation;
  readonly #maxResponseBytes: number;
  readonly #maxRetries: number;
  readonly #requestTimeoutMs: number;
  readonly #retryBaseDelayMs: number;
  readonly #urlPolicy: UpstreamUrlPolicy;
  #closed = false;

  constructor(options: FetchHttpSessionOptions = {}) {
    this.#urlPolicy = options.urlPolicy ?? createOfficialUpstreamUrlPolicy();
    this.#fetch = options.fetchImplementation ?? globalThis.fetch.bind(globalThis);
    this.#requestTimeoutMs = assertIntegerLimit(
      "requestTimeoutMs",
      options.requestTimeoutMs ?? defaultRequestTimeoutMs,
      maximumRequestTimeoutMs,
    );
    this.#maxResponseBytes = assertIntegerLimit(
      "maxResponseBytes",
      options.maxResponseBytes ?? defaultMaxResponseBytes,
      maximumMaxResponseBytes,
    );
    this.#maxRetries = assertNonNegativeIntegerLimit(
      "maxRetries",
      options.maxRetries ?? defaultMaxRetries,
      maximumMaxRetries,
    );
    this.#retryBaseDelayMs = assertNonNegativeIntegerLimit(
      "retryBaseDelayMs",
      options.retryBaseDelayMs ?? defaultRetryBaseDelayMs,
      maximumRetryBaseDelayMs,
    );
    this.#cookieJar = new SessionCookieJar({ urlPolicy: this.#urlPolicy });
  }

  async request(request: HttpSessionRequest): Promise<HttpSessionResponse> {
    if (this.#closed) throw new HttpSessionError("CLOSED");
    if ((request.method === "GET" || request.method === "HEAD") && request.body !== undefined) {
      throw new HttpSessionError("INVALID_REQUEST_BODY");
    }
    if (isAborted(request.signal)) throw new HttpSessionError("REQUEST_ABORTED");

    const url = this.#urlPolicy.assertAllowed(request.url);
    const activeRequest: ActiveRequest = {
      controller: new AbortController(),
      abortSource: null,
    };
    const abortFromCaller = (): void => abortActiveRequest(activeRequest, "caller");
    request.signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (isAborted(request.signal)) abortFromCaller();
    this.#activeRequests.add(activeRequest);
    const timeout = setTimeout(
      () => abortActiveRequest(activeRequest, "timeout"),
      this.#requestTimeoutMs,
    );
    timeout.unref();

    try {
      const cookieHeader = await this.#cookieJar.getCookieHeader(url);
      if (activeRequest.controller.signal.aborted) {
        throw new Error("The HTTP operation was aborted.");
      }
      const headers = createRequestHeaders(request, cookieHeader);
      const body = createRequestBody(request.body);

      const response = await this.#fetchWithRetry(
        url,
        {
          method: request.method,
          headers,
          redirect: "manual",
          credentials: "omit",
          cache: "no-store",
          signal: activeRequest.controller.signal,
          ...(body === undefined ? {} : { body }),
        },
        request.method,
        activeRequest.controller.signal,
      );
      await this.#cookieJar.storeFromResponse(url, response.headers.getSetCookie());
      if (activeRequest.controller.signal.aborted) {
        cancelResponseBody(response);
        throw new Error("The HTTP operation was aborted.");
      }
      const bodyBytes = await readResponseBody(
        response,
        this.#maxResponseBytes,
        activeRequest.controller.signal,
      );

      return {
        status: response.status,
        url,
        headers: collectResponseHeaders(response.headers),
        body: bodyBytes,
      };
    } catch (error: unknown) {
      if (this.#closed || activeRequest.abortSource === "closed") {
        throw new HttpSessionError("CLOSED");
      }
      if (activeRequest.abortSource === "timeout") {
        throw new HttpSessionError("REQUEST_TIMEOUT");
      }
      if (activeRequest.abortSource === "caller") {
        throw new HttpSessionError("REQUEST_ABORTED");
      }
      if (error instanceof HttpSessionError || error instanceof SessionCookieJarError) {
        throw error;
      }
      throw new HttpSessionError("NETWORK_FAILURE");
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortFromCaller);
      this.#activeRequests.delete(activeRequest);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const request of this.#activeRequests) abortActiveRequest(request, "closed");
    await this.#cookieJar.close();
  }

  toJSON(): { readonly closed: boolean } {
    return { closed: this.#closed };
  }

  async #fetchWithRetry(
    url: URL,
    init: RequestInit,
    method: HttpSessionRequest["method"],
    signal: AbortSignal,
  ): Promise<Response> {
    let retriesUsed = 0;

    while (true) {
      let response: Response;
      try {
        response = await runUntilAborted(this.#fetch(url, init), signal);
      } catch (error: unknown) {
        if (!this.#canRetry(method, retriesUsed, signal)) throw error;
        await this.#waitBeforeRetry(retriesUsed, signal);
        retriesUsed += 1;
        continue;
      }

      if (!retryableStatuses.has(response.status) || !this.#canRetry(method, retriesUsed, signal)) {
        return response;
      }

      cancelResponseBody(response);
      await this.#waitBeforeRetry(retriesUsed, signal);
      retriesUsed += 1;
    }
  }

  #canRetry(
    method: HttpSessionRequest["method"],
    retriesUsed: number,
    signal: AbortSignal,
  ): boolean {
    return retryableMethods.has(method) && retriesUsed < this.#maxRetries && !signal.aborted;
  }

  async #waitBeforeRetry(retriesUsed: number, signal: AbortSignal): Promise<void> {
    const delayMs = this.#retryBaseDelayMs * 2 ** retriesUsed;
    await waitForRetryDelay(delayMs, signal);
  }
}
