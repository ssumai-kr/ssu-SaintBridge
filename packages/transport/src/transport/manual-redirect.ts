import {
  HttpSessionError,
  type HttpRequestHeaders,
  type HttpSession,
  type HttpSessionRequest,
  type HttpSessionResponse,
} from "./http-session.js";
import { createOfficialUpstreamUrlPolicy, type UpstreamUrlPolicy } from "./upstream-url-policy.js";

export const defaultMaxRedirects = 10;
export const maximumMaxRedirects = 20;

export interface ManualRedirectOptions {
  readonly maxRedirects?: number;
  readonly urlPolicy?: UpstreamUrlPolicy;
}

const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const crossOriginSensitiveHeaders = new Set([
  "authorization",
  "cookie",
  "origin",
  "proxy-authorization",
  "x-csrf-token",
  "x-xsrf-token",
]);

const redirectMethod = (
  status: number,
  method: HttpSessionRequest["method"],
): HttpSessionRequest["method"] => {
  if (status === 303 && method !== "HEAD") return "GET";
  if ((status === 301 || status === 302) && method === "POST") return "GET";
  return method;
};

const redirectHeaders = (
  headers: HttpRequestHeaders | undefined,
  dropBody: boolean,
  crossOrigin: boolean,
): HttpRequestHeaders | undefined => {
  if (headers === undefined) return undefined;
  const filtered = Object.entries(headers).filter(([name]) => {
    const normalized = name.toLowerCase();
    if (normalized === "content-length") return false;
    if (dropBody && normalized === "content-type") return false;
    if (crossOrigin && crossOriginSensitiveHeaders.has(normalized)) return false;
    return true;
  });
  return filtered.length === 0 ? undefined : Object.fromEntries(filtered);
};

export const requestFollowingRedirects = async (
  session: HttpSession,
  initialRequest: HttpSessionRequest,
  options: ManualRedirectOptions = {},
): Promise<HttpSessionResponse> => {
  const maxRedirects = options.maxRedirects ?? defaultMaxRedirects;
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > maximumMaxRedirects) {
    throw new TypeError(`maxRedirects must be an integer between 0 and ${maximumMaxRedirects}.`);
  }

  const urlPolicy = options.urlPolicy ?? createOfficialUpstreamUrlPolicy();
  let request: HttpSessionRequest = {
    ...initialRequest,
    url: urlPolicy.assertAllowed(initialRequest.url),
  };
  let redirects = 0;

  while (true) {
    const response = await session.request(request);
    if (!redirectStatuses.has(response.status)) return response;
    if (redirects >= maxRedirects) {
      throw new HttpSessionError("REDIRECT_LIMIT_EXCEEDED");
    }

    const location = response.headers.location?.[0];
    if (location === undefined || location.trim().length === 0) {
      throw new HttpSessionError("MISSING_REDIRECT_LOCATION");
    }

    const nextUrl = urlPolicy.resolveRedirect(response.url, location);
    const nextMethod = redirectMethod(response.status, request.method);
    const dropBody = nextMethod !== request.method;
    const headers = redirectHeaders(
      request.headers,
      dropBody,
      nextUrl.origin !== request.url.origin,
    );

    request = {
      method: nextMethod,
      url: nextUrl,
      ...(headers === undefined ? {} : { headers }),
      ...(dropBody || request.body === undefined ? {} : { body: request.body }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    };
    redirects += 1;
  }
};
