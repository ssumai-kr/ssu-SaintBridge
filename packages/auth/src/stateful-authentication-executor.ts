import type { AuthSourceId, AuthSourceSession } from "@ssu-saintbridge/types";

import type {
  AuthenticationExecutionOptions,
  AuthenticationExecutor,
} from "./authentication-executor.js";
import type { AuthSourceAttempt, AuthSourceStateMachine } from "./auth-source-state-machine.js";
import { InMemoryAuthSourceStateMachine } from "./in-memory-auth-source-state-machine.js";
import { parseAuthLoginRequest, type AuthLoginRequest } from "./transient-credentials.js";

const rollbackPreservingOriginalError = (
  stateMachine: AuthSourceStateMachine,
  attempt: AuthSourceAttempt,
  originalError: unknown,
): never => {
  try {
    stateMachine.rollback(attempt);
  } catch {
    // Removal or a newer owner may already have invalidated this attempt.
  }
  throw originalError;
};

export class StatefulAuthenticationExecutor<Result> {
  readonly #executor: AuthenticationExecutor<Result>;
  readonly #stateMachine: AuthSourceStateMachine;

  constructor(
    executor: AuthenticationExecutor<Result>,
    stateMachine: AuthSourceStateMachine = new InMemoryAuthSourceStateMachine(),
  ) {
    this.#executor = executor;
    this.#stateMachine = stateMachine;
  }

  async execute(
    request: AuthLoginRequest,
    options: AuthenticationExecutionOptions = {},
  ): Promise<Result> {
    const parsedRequest = parseAuthLoginRequest(request);
    const attempt = this.#stateMachine.begin({
      source: parsedRequest.authSource,
      inputMode: parsedRequest.mode,
    });

    try {
      const result = await this.#executor.execute(parsedRequest, options);
      this.#stateMachine.complete(attempt);
      return result;
    } catch (error: unknown) {
      return rollbackPreservingOriginalError(this.#stateMachine, attempt, error);
    }
  }

  expire(source: AuthSourceId): AuthSourceSession {
    return this.#stateMachine.expire(source);
  }

  remove(source: AuthSourceId): void {
    this.#stateMachine.remove(source);
  }

  getSnapshot(): readonly AuthSourceSession[] {
    return this.#stateMachine.getSnapshot();
  }
}
