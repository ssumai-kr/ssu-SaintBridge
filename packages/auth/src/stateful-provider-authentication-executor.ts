import {
  authSnapshotSchema,
  providerSessionSchema,
  type AuthSnapshot,
  type AuthSourceId,
  type AuthSourceSession,
} from "@ssu-saintbridge/types";

import type {
  AuthenticationExecutionOptions,
  AuthenticationExecutor,
} from "./authentication-executor.js";
import type { AuthSourceAttempt, AuthSourceStateMachine } from "./auth-source-state-machine.js";
import { InMemoryAuthSourceStateMachine } from "./in-memory-auth-source-state-machine.js";
import type {
  PreparedProviderCallbacks,
  ProviderCallbackCoordinator,
} from "./provider-callback-coordinator.js";
import { parseAuthLoginRequest, type AuthLoginRequest } from "./transient-credentials.js";

/**
 * Authentication handlers prepare provider callbacks while their managed
 * browser or one-shot credential execution boundary is still active. Nothing
 * from the prepared callback transaction is public until this result is bound
 * to the matching auth-source attempt.
 */
export interface PreparedProviderAuthentication<Result> {
  readonly result: Result;
  readonly providerCallbacks: PreparedProviderCallbacks;
}

export const createPreparedProviderAuthentication = <Result>(
  result: Result,
  providerCallbacks: PreparedProviderCallbacks,
): PreparedProviderAuthentication<Result> => Object.freeze({ result, providerCallbacks });

const rollbackAttempt = (
  stateMachine: AuthSourceStateMachine,
  attempt: AuthSourceAttempt,
): void => {
  try {
    stateMachine.rollback(attempt);
  } catch {
    // Removal or a newer owner may already have invalidated this attempt.
  }
};

export class StatefulProviderAuthenticationExecutor<Result> {
  readonly #executor: AuthenticationExecutor<PreparedProviderAuthentication<Result>>;
  readonly #callbacks: ProviderCallbackCoordinator;
  readonly #stateMachine: AuthSourceStateMachine;

  constructor(
    executor: AuthenticationExecutor<PreparedProviderAuthentication<Result>>,
    callbacks: ProviderCallbackCoordinator,
    stateMachine: AuthSourceStateMachine = new InMemoryAuthSourceStateMachine(),
  ) {
    this.#executor = executor;
    this.#callbacks = callbacks;
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
    let prepared: PreparedProviderCallbacks | undefined;
    let committed = false;
    let execution: PreparedProviderAuthentication<Result>;
    let cleanup: Promise<void>;

    try {
      execution = await this.#executor.execute(parsedRequest, options);
      prepared = execution.providerCallbacks;

      // Every fallible ownership check runs before either stable store changes.
      this.#stateMachine.assertCanComplete(attempt);
      const providerCommit = this.#callbacks.commit(prepared, {
        authSource: parsedRequest.authSource,
        inputMode: parsedRequest.mode,
        requestedScopes: parsedRequest.scopes,
      });
      committed = true;

      // No await is allowed between the provider and auth-source publications.
      this.#stateMachine.complete(attempt);
      cleanup = providerCommit.cleanup;
    } catch (error: unknown) {
      rollbackAttempt(this.#stateMachine, attempt);
      if (prepared !== undefined && !committed) {
        try {
          await this.#callbacks.rollback(prepared);
        } catch {
          // The authentication, callback, or stale-attempt failure remains primary.
        }
      }
      throw error;
    }

    await cleanup;
    return execution.result;
  }

  expire(source: AuthSourceId): AuthSourceSession {
    return this.#stateMachine.expire(source);
  }

  remove(source: AuthSourceId): void {
    this.#stateMachine.remove(source);
  }

  getSnapshot(): AuthSnapshot {
    const authSources = this.#stateMachine.getSnapshot();
    const authSourceById = new Map(authSources.map((source) => [source.source, source]));
    const providers = this.#callbacks.getSnapshot().flatMap((provider) => {
      if (provider.authenticatedBy === "public") return [provider];
      const authSource = authSourceById.get(provider.authenticatedBy);
      if (authSource === undefined) return [];
      if (authSource.status === "authenticated") return [provider];
      return [providerSessionSchema.parse({ ...provider, status: "expired" })];
    });

    return authSnapshotSchema.parse({ state: "open", authSources, providers });
  }
}
