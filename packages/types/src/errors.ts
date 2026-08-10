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
  readonly message: string;
  readonly cause?: unknown;
}

export class SaintError extends Error {
  readonly code: SaintErrorCode;
  readonly retryable: boolean;

  constructor(options: SaintErrorOptions) {
    const payload = saintErrorPayloadSchema.parse({
      code: options.code,
      message: options.message,
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
