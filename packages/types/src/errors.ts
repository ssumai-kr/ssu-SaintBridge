import { z } from "zod";

import { providerIdSchema, type ProviderId } from "./providers.js";

export const saintBridgeErrorCodes = [
  "INVALID_CREDENTIALS",
  "SECOND_FACTOR_REQUIRED",
  "ACCOUNT_LOCKED",
  "AUTH_FLOW_CHANGED",
  "PROVIDER_SESSION_EXPIRED",
  "CAPABILITY_UNAVAILABLE",
  "UPSTREAM_UNAVAILABLE",
  "PARSER_MISMATCH",
  "INSUFFICIENT_SCOPE",
  "RATE_LIMITED",
] as const;

export const saintBridgeErrorCodeSchema = z.enum(saintBridgeErrorCodes);
export type SaintBridgeErrorCode = z.infer<typeof saintBridgeErrorCodeSchema>;

export const saintBridgeErrorRetryability = {
  INVALID_CREDENTIALS: false,
  SECOND_FACTOR_REQUIRED: false,
  ACCOUNT_LOCKED: false,
  AUTH_FLOW_CHANGED: false,
  PROVIDER_SESSION_EXPIRED: false,
  CAPABILITY_UNAVAILABLE: false,
  UPSTREAM_UNAVAILABLE: true,
  PARSER_MISMATCH: false,
  INSUFFICIENT_SCOPE: false,
  RATE_LIMITED: true,
} as const satisfies Readonly<Record<SaintBridgeErrorCode, boolean>>;

export const saintBridgeErrorMessages = {
  INVALID_CREDENTIALS: "The provided credentials were rejected.",
  SECOND_FACTOR_REQUIRED: "An interactive second factor is required.",
  ACCOUNT_LOCKED: "The account is locked.",
  AUTH_FLOW_CHANGED: "The upstream authentication flow no longer matches the expected contract.",
  PROVIDER_SESSION_EXPIRED: "The provider session has expired.",
  CAPABILITY_UNAVAILABLE: "The requested provider capability is unavailable.",
  UPSTREAM_UNAVAILABLE: "The upstream service is unavailable.",
  PARSER_MISMATCH: "The upstream document no longer matches the expected contract.",
  INSUFFICIENT_SCOPE: "The requested operation requires an additional scope.",
  RATE_LIMITED: "The upstream service rate limit was reached.",
} as const satisfies Readonly<Record<SaintBridgeErrorCode, string>>;

export const saintBridgeErrorPayloadSchema = z
  .object({
    code: saintBridgeErrorCodeSchema,
    message: z.string().trim().min(1),
    provider: providerIdSchema.optional(),
    retryable: z.boolean(),
  })
  .strict();

export type SaintBridgeErrorPayload = z.infer<typeof saintBridgeErrorPayloadSchema>;

export interface SaintBridgeErrorOptions {
  readonly code: SaintBridgeErrorCode;
  readonly cause?: unknown;
  readonly provider?: ProviderId;
}

export class SaintBridgeError extends Error {
  readonly code: SaintBridgeErrorCode;
  readonly provider: ProviderId | undefined;
  readonly retryable: boolean;

  constructor(options: SaintBridgeErrorOptions) {
    const payload = saintBridgeErrorPayloadSchema.parse({
      code: options.code,
      message: saintBridgeErrorMessages[options.code],
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      retryable: saintBridgeErrorRetryability[options.code],
    });

    super(payload.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SaintBridgeError";
    this.code = payload.code;
    this.provider = payload.provider;
    this.retryable = payload.retryable;
  }

  toJSON(): SaintBridgeErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.provider === undefined ? {} : { provider: this.provider }),
      retryable: this.retryable,
    };
  }
}

export const isSaintBridgeError = (value: unknown): value is SaintBridgeError =>
  value instanceof SaintBridgeError;

// Compatibility aliases for the original u-SAINT-only package surface.
export const saintErrorCodes = saintBridgeErrorCodes;
export const saintErrorCodeSchema = saintBridgeErrorCodeSchema;
export const saintErrorRetryability = saintBridgeErrorRetryability;
export const saintErrorMessages = saintBridgeErrorMessages;
export const saintErrorPayloadSchema = saintBridgeErrorPayloadSchema;
export type SaintErrorCode = SaintBridgeErrorCode;
export type SaintErrorOptions = SaintBridgeErrorOptions;
export type SaintErrorPayload = SaintBridgeErrorPayload;
export { SaintBridgeError as SaintError };
export const isSaintError = isSaintBridgeError;
