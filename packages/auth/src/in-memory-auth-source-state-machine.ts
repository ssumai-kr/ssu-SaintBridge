import {
  authInputModeSchema,
  authSourceIdSchema,
  authSourceIds,
  authSourceSessionSchema,
  type AuthSourceId,
  type AuthSourceSession,
} from "@ssu-saintbridge/types";

import {
  AuthSourceTransitionError,
  getAuthSourceTransitionTarget,
  type AuthSourceAttempt,
  type AuthSourceStateMachine,
  type AuthSourceTransitionEvent,
  type AuthSourceTransitionState,
  type AuthSourceTransitionTarget,
  type BeginAuthSourceAttemptOptions,
  type CompleteAuthSourceAttemptOptions,
} from "./auth-source-state-machine.js";

interface TrackedAuthSourceAttempt {
  readonly token: AuthSourceAttempt;
  readonly source: AuthSourceId;
  readonly previous: AuthSourceSession | undefined;
}

const createSession = (
  source: AuthSourceId,
  inputMode: AuthSourceSession["inputMode"],
  status: AuthSourceSession["status"],
  expiresAt: AuthSourceSession["expiresAt"],
): AuthSourceSession =>
  authSourceSessionSchema.parse({
    source,
    inputMode,
    status,
    expiresAt,
  });

const readAttemptSource = (attempt: AuthSourceAttempt): AuthSourceId => {
  if (typeof attempt !== "object" || attempt === null) {
    throw new TypeError("The authentication attempt must be an opaque attempt token.");
  }
  return authSourceIdSchema.parse((attempt as Readonly<{ source?: unknown }>).source);
};

export class InMemoryAuthSourceStateMachine implements AuthSourceStateMachine {
  readonly #sessions = new Map<AuthSourceId, AuthSourceSession>();
  readonly #activeAttempts = new Map<AuthSourceId, TrackedAuthSourceAttempt>();
  readonly #knownAttempts = new WeakMap<AuthSourceAttempt, TrackedAuthSourceAttempt>();

  begin(options: BeginAuthSourceAttemptOptions): AuthSourceAttempt {
    const source = authSourceIdSchema.parse(options.source);
    const inputMode = authInputModeSchema.parse(options.inputMode);

    if (this.#activeAttempts.has(source)) {
      throw new AuthSourceTransitionError(source, "begin", "ATTEMPT_ALREADY_ACTIVE");
    }
    this.#assertTransition(source, "begin", "authenticating");

    const token = Object.freeze({ source, inputMode }) as AuthSourceAttempt;
    const tracked = Object.freeze({
      token,
      source,
      previous: this.#sessions.get(source),
    });
    this.#knownAttempts.set(token, tracked);
    this.#activeAttempts.set(source, tracked);
    this.#sessions.set(source, createSession(source, inputMode, "authenticating", null));
    return token;
  }

  assertCanComplete(attempt: AuthSourceAttempt): void {
    const tracked = this.#requireActiveAttempt(attempt, "complete");
    this.#assertTransition(tracked.source, "complete", "authenticated");
  }

  complete(
    attempt: AuthSourceAttempt,
    options: CompleteAuthSourceAttemptOptions = {},
  ): AuthSourceSession {
    this.assertCanComplete(attempt);
    const tracked = this.#requireActiveAttempt(attempt, "complete");

    const session = createSession(
      tracked.source,
      tracked.token.inputMode,
      "authenticated",
      options.expiresAt ?? null,
    );
    this.#sessions.set(tracked.source, session);
    this.#activeAttempts.delete(tracked.source);
    return session;
  }

  rollback(attempt: AuthSourceAttempt): AuthSourceSession | undefined {
    const tracked = this.#requireActiveAttempt(attempt, "rollback");
    this.#assertTransition(tracked.source, "rollback", "previous");

    if (tracked.previous === undefined) {
      this.#sessions.delete(tracked.source);
    } else {
      this.#sessions.set(tracked.source, tracked.previous);
    }
    this.#activeAttempts.delete(tracked.source);
    return tracked.previous;
  }

  expire(source: AuthSourceId): AuthSourceSession {
    const parsedSource = authSourceIdSchema.parse(source);
    this.#assertTransition(parsedSource, "expire", "expired");

    const current = this.#sessions.get(parsedSource);
    if (current === undefined) {
      throw new AuthSourceTransitionError(parsedSource, "expire", "INVALID_TRANSITION");
    }
    const expired = createSession(parsedSource, current.inputMode, "expired", current.expiresAt);
    this.#sessions.set(parsedSource, expired);
    return expired;
  }

  remove(source: AuthSourceId): void {
    const parsedSource = authSourceIdSchema.parse(source);
    this.#assertTransition(parsedSource, "remove", "absent");
    this.#activeAttempts.delete(parsedSource);
    this.#sessions.delete(parsedSource);
  }

  getSnapshot(): readonly AuthSourceSession[] {
    return Object.freeze(
      authSourceIds.flatMap((source) => {
        const session = this.#sessions.get(source);
        return session === undefined ? [] : [session];
      }),
    );
  }

  #requireActiveAttempt(
    attempt: AuthSourceAttempt,
    event: "complete" | "rollback",
  ): TrackedAuthSourceAttempt {
    const source = readAttemptSource(attempt);
    const tracked = this.#knownAttempts.get(attempt);
    if (tracked === undefined) {
      const violation = this.#activeAttempts.has(source) ? "STALE_ATTEMPT" : "ATTEMPT_NOT_ACTIVE";
      throw new AuthSourceTransitionError(source, event, violation);
    }
    if (this.#activeAttempts.get(tracked.source) !== tracked) {
      throw new AuthSourceTransitionError(tracked.source, event, "STALE_ATTEMPT");
    }
    return tracked;
  }

  #assertTransition(
    source: AuthSourceId,
    event: AuthSourceTransitionEvent,
    expectedTarget: AuthSourceTransitionTarget,
  ): void {
    const current = this.#sessions.get(source)?.status ?? "absent";
    const from: AuthSourceTransitionState | undefined =
      current === "unsupported" ? undefined : current;
    if (from === undefined || getAuthSourceTransitionTarget(from, event) !== expectedTarget) {
      throw new AuthSourceTransitionError(source, event, "INVALID_TRANSITION");
    }
  }
}
