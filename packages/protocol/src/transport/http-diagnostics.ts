import { randomUUID } from "node:crypto";

import type { HttpMethod, HttpSessionViolation } from "./http-session.js";
import type { SessionCookieJarViolation } from "./session-cookie-jar.js";

export type HttpDiagnosticEvent =
  "request_completed" | "request_failed" | "request_started" | "retry_scheduled";

export type HttpDiagnosticFailure = HttpSessionViolation | `COOKIE_${SessionCookieJarViolation}`;

export type HttpDiagnosticRetryReason = "network_failure" | "upstream_status";

/**
 * Allowlisted transport metadata. URL paths, queries, header values, cookies, and bodies are absent
 * by construction and must never be added to this public diagnostic contract.
 */
export interface HttpDiagnostic {
  readonly attempt?: number;
  readonly event: HttpDiagnosticEvent;
  readonly failure?: HttpDiagnosticFailure;
  readonly host: string;
  readonly method: HttpMethod;
  readonly requestId: string;
  readonly retryReason?: HttpDiagnosticRetryReason;
  readonly status?: number;
}

export type HttpDiagnosticSink = (diagnostic: Readonly<HttpDiagnostic>) => void | Promise<void>;

export const createHttpRequestId = (): string => `req_${randomUUID()}`;

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
