import type { AuthInputMode, AuthSourceId, AuthSourceSession } from "@ssu-saintbridge/types";

export const authSourceTransitionStates = [
  "absent",
  "authenticating",
  "authenticated",
  "expired",
] as const;
export type AuthSourceTransitionState = (typeof authSourceTransitionStates)[number];

export const authSourceStableStates = ["absent", "authenticated", "expired"] as const;
export type AuthSourceStableState = (typeof authSourceStableStates)[number];

export const authSourceTransitionEvents = [
  "begin",
  "complete",
  "rollback",
  "expire",
  "remove",
] as const;
export type AuthSourceTransitionEvent = (typeof authSourceTransitionEvents)[number];

export type AuthSourceTransitionTarget = AuthSourceTransitionState | "previous";

export interface AuthSourceTransitionRule {
  readonly from: AuthSourceTransitionState;
  readonly event: AuthSourceTransitionEvent;
  readonly to: AuthSourceTransitionTarget;
}

export const authSourceTransitionRules = Object.freeze([
  Object.freeze({ from: "absent", event: "begin", to: "authenticating" }),
  Object.freeze({ from: "authenticating", event: "complete", to: "authenticated" }),
  Object.freeze({ from: "authenticating", event: "rollback", to: "previous" }),
  Object.freeze({ from: "authenticating", event: "remove", to: "absent" }),
  Object.freeze({ from: "authenticated", event: "begin", to: "authenticating" }),
  Object.freeze({ from: "authenticated", event: "expire", to: "expired" }),
  Object.freeze({ from: "authenticated", event: "remove", to: "absent" }),
  Object.freeze({ from: "expired", event: "begin", to: "authenticating" }),
  Object.freeze({ from: "expired", event: "remove", to: "absent" }),
] as const satisfies readonly AuthSourceTransitionRule[]);

export const getAuthSourceTransitionTarget = (
  from: AuthSourceTransitionState,
  event: AuthSourceTransitionEvent,
): AuthSourceTransitionTarget | undefined =>
  authSourceTransitionRules.find((rule) => rule.from === from && rule.event === event)?.to;

declare const authSourceAttemptBrand: unique symbol;

export interface AuthSourceAttempt {
  readonly [authSourceAttemptBrand]: true;
  readonly source: AuthSourceId;
  readonly inputMode: AuthInputMode;
}

export interface BeginAuthSourceAttemptOptions {
  readonly source: AuthSourceId;
  readonly inputMode: AuthInputMode;
}

export interface CompleteAuthSourceAttemptOptions {
  readonly expiresAt?: AuthSourceSession["expiresAt"];
}

export interface AuthSourceStateMachine {
  begin(options: BeginAuthSourceAttemptOptions): AuthSourceAttempt;
  complete(
    attempt: AuthSourceAttempt,
    options?: CompleteAuthSourceAttemptOptions,
  ): AuthSourceSession;
  rollback(attempt: AuthSourceAttempt): AuthSourceSession | undefined;
  expire(source: AuthSourceId): AuthSourceSession;
  remove(source: AuthSourceId): void;
  getSnapshot(): readonly AuthSourceSession[];
}

export const authSourceTransitionViolations = [
  "ATTEMPT_ALREADY_ACTIVE",
  "ATTEMPT_NOT_ACTIVE",
  "STALE_ATTEMPT",
  "INVALID_TRANSITION",
] as const;
export type AuthSourceTransitionViolation = (typeof authSourceTransitionViolations)[number];

const violationMessages: Readonly<Record<AuthSourceTransitionViolation, string>> = {
  ATTEMPT_ALREADY_ACTIVE: "An authentication attempt is already active for this source.",
  ATTEMPT_NOT_ACTIVE: "The authentication source has no active attempt.",
  STALE_ATTEMPT: "The authentication attempt no longer owns the source transition.",
  INVALID_TRANSITION: "The authentication source transition is not allowed.",
};

export class AuthSourceTransitionError extends Error {
  readonly source: AuthSourceId;
  readonly event: AuthSourceTransitionEvent;
  readonly violation: AuthSourceTransitionViolation;

  constructor(
    source: AuthSourceId,
    event: AuthSourceTransitionEvent,
    violation: AuthSourceTransitionViolation,
  ) {
    super(violationMessages[violation]);
    this.name = "AuthSourceTransitionError";
    this.source = source;
    this.event = event;
    this.violation = violation;
  }

  toJSON(): {
    readonly name: string;
    readonly source: AuthSourceId;
    readonly event: AuthSourceTransitionEvent;
    readonly violation: AuthSourceTransitionViolation;
  } {
    return {
      name: this.name,
      source: this.source,
      event: this.event,
      violation: this.violation,
    };
  }
}
