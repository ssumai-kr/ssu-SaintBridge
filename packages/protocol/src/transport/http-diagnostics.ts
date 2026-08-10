import { randomUUID } from "node:crypto";

import type { HttpSessionViolation } from "./http-session.js";
import type { SessionCookieJarViolation } from "./session-cookie-jar.js";

export type HttpDiagnosticEvent =
  "request_completed" | "request_failed" | "request_started" | "retry_scheduled";

export type HttpDiagnosticFailure = HttpSessionViolation | `COOKIE_${SessionCookieJarViolation}`;

export type HttpDiagnosticRetryReason = "network_failure" | "upstream_status";

export type HttpDiagnosticStatusCategory = "1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "unknown";

/**
 * Allowlisted transport metadata. URL paths, queries, header values, cookies, and bodies are absent
 * by construction and must never be added to this public diagnostic contract.
 */
export interface HttpDiagnostic {
  readonly attempt?: number;
  readonly event: HttpDiagnosticEvent;
  readonly failure?: HttpDiagnosticFailure;
  readonly requestId: string;
  readonly retryReason?: HttpDiagnosticRetryReason;
  readonly statusCategory?: HttpDiagnosticStatusCategory;
}

export type HttpDiagnosticSink = (diagnostic: Readonly<HttpDiagnostic>) => void | Promise<void>;

export const createHttpRequestId = (): string => `req_${randomUUID()}`;

export const toHttpStatusCategory = (status: number): HttpDiagnosticStatusCategory => {
  if (status >= 100 && status < 200) return "1xx";
  if (status >= 200 && status < 300) return "2xx";
  if (status >= 300 && status < 400) return "3xx";
  if (status >= 400 && status < 500) return "4xx";
  if (status >= 500 && status < 600) return "5xx";
  return "unknown";
};

export const emitHttpDiagnostic = (
  sink: HttpDiagnosticSink | undefined,
  diagnostic: HttpDiagnostic,
): void => {
  if (sink === undefined) return;

  const safeDiagnostic = Object.freeze({ ...diagnostic });
  try {
    const result = sink(safeDiagnostic);
    if (result !== undefined) result.catch(() => undefined);
  } catch {
    // Diagnostics are observational and must not alter transport behavior.
  }
};
