import { z } from "zod";

export const saintErrorCodes = [
  "INVALID_CREDENTIALS",
  "SECOND_FACTOR_REQUIRED",
  "ACCOUNT_LOCKED",
  "SSO_FLOW_CHANGED",
  "PORTAL_SESSION_EXPIRED",
  "APPLICATION_CONTEXT_EXPIRED",
  "UPSTREAM_UNAVAILABLE",
  "PARSER_MISMATCH",
  "RATE_LIMITED",
] as const;

export const saintErrorCodeSchema = z.enum(saintErrorCodes);
export type SaintErrorCode = z.infer<typeof saintErrorCodeSchema>;

export const saintErrorRetryability = {
  INVALID_CREDENTIALS: false,
  SECOND_FACTOR_REQUIRED: false,
  ACCOUNT_LOCKED: false,
  SSO_FLOW_CHANGED: false,
  PORTAL_SESSION_EXPIRED: false,
  APPLICATION_CONTEXT_EXPIRED: true,
  UPSTREAM_UNAVAILABLE: true,
  PARSER_MISMATCH: false,
  RATE_LIMITED: true,
} as const satisfies Readonly<Record<SaintErrorCode, boolean>>;

export const saintErrorMessages = {
  INVALID_CREDENTIALS: "The provided credentials were rejected.",
  SECOND_FACTOR_REQUIRED: "An interactive second factor is required.",
  ACCOUNT_LOCKED: "The account is locked.",
  SSO_FLOW_CHANGED: "The upstream SSO flow no longer matches the expected contract.",
  PORTAL_SESSION_EXPIRED: "The upstream portal session has expired.",
  APPLICATION_CONTEXT_EXPIRED: "The upstream application context has expired.",
  UPSTREAM_UNAVAILABLE: "The upstream service is unavailable.",
  PARSER_MISMATCH: "The upstream document no longer matches the expected contract.",
  RATE_LIMITED: "The upstream service rate limit was reached.",
} as const satisfies Readonly<Record<SaintErrorCode, string>>;

export const saintErrorPayloadSchema = z
  .object({
    code: saintErrorCodeSchema,
    message: z.string().trim().min(1),
    retryable: z.boolean(),
  })
  .strict();

export type SaintErrorPayload = z.infer<typeof saintErrorPayloadSchema>;

export interface SaintErrorOptions {
  readonly code: SaintErrorCode;
  readonly cause?: unknown;
}

export class SaintError extends Error {
  readonly code: SaintErrorCode;
  readonly retryable: boolean;

  constructor(options: SaintErrorOptions) {
    const payload = saintErrorPayloadSchema.parse({
      code: options.code,
      message: saintErrorMessages[options.code],
      retryable: saintErrorRetryability[options.code],
    });

    super(payload.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SaintError";
    this.code = payload.code;
    this.retryable = payload.retryable;
  }

  toJSON(): SaintErrorPayload {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

export const isSaintError = (value: unknown): value is SaintError => value instanceof SaintError;
