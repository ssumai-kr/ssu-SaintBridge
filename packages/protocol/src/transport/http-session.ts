export const httpMethods = ["GET", "HEAD", "POST"] as const;
export type HttpMethod = (typeof httpMethods)[number];

export type HttpRequestHeaders = Readonly<Record<string, string>>;
export type HttpResponseHeaders = Readonly<Record<string, readonly string[]>>;
export type HttpRequestBody = string | Uint8Array;

export interface HttpSessionRequest {
  readonly method: HttpMethod;
  readonly url: URL;
  readonly headers?: HttpRequestHeaders;
  readonly body?: HttpRequestBody;
  readonly signal?: AbortSignal;
}

export interface HttpSessionResponse {
  readonly status: number;
  readonly url: URL;
  readonly headers: HttpResponseHeaders;
  readonly body: Uint8Array;
}

/**
 * Cookie and redirect aware transport boundary used by the SSO and Web Dynpro layers.
 * Implementations must keep cookies private and return redirects without following them implicitly.
 */
export interface HttpSession {
  request(request: HttpSessionRequest): Promise<HttpSessionResponse>;
  close(): Promise<void>;
}
