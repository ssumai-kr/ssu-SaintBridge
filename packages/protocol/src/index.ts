import type { SaintErrorCode } from "@ssu-saintbridge/types";

export * from "./transport/fetch-http-session.js";
export * from "./transport/http-session.js";
export * from "./transport/http-text-decoder.js";
export * from "./transport/manual-redirect.js";
export * from "./transport/upstream-url-policy.js";

export interface ProtocolStatus {
  readonly state: "anonymous" | "authenticated" | "closed";
  readonly lastError: SaintErrorCode | null;
}

export const createInitialProtocolStatus = (): ProtocolStatus => ({
  state: "anonymous",
  lastError: null,
});
