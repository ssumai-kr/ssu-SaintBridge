export const httpMethods = ["GET", "HEAD", "POST"] as const;
export type HttpMethod = (typeof httpMethods)[number];

export type HttpRequestHeaders = Readonly<Record<string, string>>;
export type HttpResponseHeaders = Readonly<Record<string, readonly string[]>>;
export type HttpRequestBody = string | Uint8Array;

export type HttpSessionViolation =
  | "CLOSED"
  | "FORBIDDEN_REQUEST_HEADER"
  | "INVALID_REQUEST_BODY"
  | "NETWORK_FAILURE"
  | "MISSING_REDIRECT_LOCATION"
  | "REDIRECT_LIMIT_EXCEEDED"
  | "REQUEST_ABORTED"
  | "REQUEST_TIMEOUT"
  | "RESPONSE_TOO_LARGE";

const violationMessages: Readonly<Record<HttpSessionViolation, string>> = {
  CLOSED: "The HTTP session is closed.",
  FORBIDDEN_REQUEST_HEADER: "The request contains a transport-managed or unsafe header.",
  INVALID_REQUEST_BODY: "The HTTP method does not allow a request body.",
  NETWORK_FAILURE: "The upstream network request failed.",
  MISSING_REDIRECT_LOCATION: "The upstream redirect response did not contain a Location header.",
  REDIRECT_LIMIT_EXCEEDED: "The upstream redirect limit was exceeded.",
  REQUEST_ABORTED: "The HTTP request was aborted by the caller.",
  REQUEST_TIMEOUT: "The upstream HTTP request timed out.",
  RESPONSE_TOO_LARGE: "The upstream response body exceeded the size limit.",
};

export class HttpSessionError extends Error {
  readonly violation: HttpSessionViolation;

  constructor(violation: HttpSessionViolation) {
    super(violationMessages[violation]);
    this.name = "HttpSessionError";
    this.violation = violation;
  }

  toJSON(): { readonly name: string; readonly violation: HttpSessionViolation } {
    return { name: this.name, violation: this.violation };
  }
}

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
