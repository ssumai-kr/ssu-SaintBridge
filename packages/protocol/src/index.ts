import type { SaintErrorCode } from "@ssu-saintbridge/types";

export * from "./transport/http-session.js";
export * from "./transport/upstream-url-policy.js";

export interface ProtocolStatus {
  readonly state: "anonymous" | "authenticated" | "closed";
  readonly lastError: SaintErrorCode | null;
}

export const createInitialProtocolStatus = (): ProtocolStatus => ({
  state: "anonymous",
  lastError: null,
});
