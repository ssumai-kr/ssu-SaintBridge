import type { AuthInputMode, AuthSourceId, Scope } from "@ssu-saintbridge/types";

import {
  parseAuthLoginRequest,
  TransientCredentials,
  type AuthLoginRequest,
  type CredentialValues,
} from "./transient-credentials.js";

interface AuthenticationExecutionContextBase {
  readonly authSource: AuthSourceId;
  readonly requestedScopes: readonly Scope[];
  readonly signal: AbortSignal;
}

export interface OfficialBrowserExecutionContext extends AuthenticationExecutionContextBase {
  readonly inputMode: "official-browser";
}

export interface ApplicationCredentialExecutionContext extends AuthenticationExecutionContextBase {
  readonly inputMode: "application-credentials";
}

export type AuthenticationExecutionContext =
  OfficialBrowserExecutionContext | ApplicationCredentialExecutionContext;

export interface AuthenticationExecutionHandlers<Result> {
  readonly officialBrowser: (context: OfficialBrowserExecutionContext) => Promise<Result>;
  readonly applicationCredentials: (
    context: ApplicationCredentialExecutionContext,
    credentials: Readonly<CredentialValues>,
  ) => Promise<Result>;
}

export interface AuthenticationExecutionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export const defaultAuthenticationExecutionTimeoutMs = 5 * 60 * 1_000;
export const maximumAuthenticationExecutionTimeoutMs = 30 * 60 * 1_000;

export type AuthenticationExecutionViolation = "CANCELLED" | "TIMED_OUT";

export class AuthenticationExecutionError extends Error {
  readonly authSource: AuthSourceId;
  readonly inputMode: AuthInputMode;
  readonly violation: AuthenticationExecutionViolation;

  constructor(
    authSource: AuthSourceId,
    inputMode: AuthInputMode,
    violation: AuthenticationExecutionViolation,
  ) {
    super(
      violation === "TIMED_OUT"
        ? "The authentication execution timed out before it completed."
        : "The authentication execution was cancelled before it completed.",
    );
    this.name = "AuthenticationExecutionError";
    this.authSource = authSource;
    this.inputMode = inputMode;
    this.violation = violation;
  }

  toJSON(): {
    readonly name: string;
    readonly authSource: AuthSourceId;
    readonly inputMode: AuthInputMode;
    readonly violation: AuthenticationExecutionViolation;
  } {
    return {
      name: this.name,
      authSource: this.authSource,
      inputMode: this.inputMode,
      violation: this.violation,
    };
  }
}

interface AuthenticationExecutionLifecycle {
  readonly signal: AbortSignal;
  dispose(): void;
}

const parseTimeoutMs = (timeoutMs: number | undefined): number => {
  const parsedTimeout = timeoutMs ?? defaultAuthenticationExecutionTimeoutMs;
  if (
    !Number.isSafeInteger(parsedTimeout) ||
    parsedTimeout < 1 ||
    parsedTimeout > maximumAuthenticationExecutionTimeoutMs
  ) {
    throw new RangeError(
      `Authentication timeout must be an integer between 1 and ${maximumAuthenticationExecutionTimeoutMs} milliseconds.`,
    );
  }
  return parsedTimeout;
};

const createExecutionLifecycle = (
  request: AuthLoginRequest,
  options: AuthenticationExecutionOptions,
): AuthenticationExecutionLifecycle => {
  const timeoutMs = parseTimeoutMs(options.timeoutMs);
  const controller = new AbortController();
  const cancel = (): void => {
    controller.abort(
      new AuthenticationExecutionError(request.authSource, request.mode, "CANCELLED"),
    );
  };
  const callerSignal = options.signal;
  if (callerSignal?.aborted === true) cancel();
  else callerSignal?.addEventListener("abort", cancel, { once: true });

  const timeout = setTimeout(() => {
    controller.abort(
      new AuthenticationExecutionError(request.authSource, request.mode, "TIMED_OUT"),
    );
  }, timeoutMs);
  timeout.unref();

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeout);
      callerSignal?.removeEventListener("abort", cancel);
    },
  };
};

const acquireTransientCredentials = async (
  request: Extract<AuthLoginRequest, { readonly mode: "application-credentials" }>,
  signal: AbortSignal,
): Promise<TransientCredentials> => {
  const acquisition = Promise.resolve().then(() => request.acquireCredentials());
  let rejectCancellation: (error: unknown) => void = () => undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const cancel = (): void => rejectCancellation(signal.reason);
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });

  try {
    return await Promise.race([acquisition, cancellation]);
  } catch (error: unknown) {
    if (signal.aborted) {
      void acquisition.then((credentials) => credentials.release()).catch(() => undefined);
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
};

const createContext = <Mode extends AuthInputMode>(
  request: {
    readonly authSource: AuthSourceId;
    readonly mode: Mode;
    readonly scopes: readonly Scope[];
  },
  signal: AbortSignal,
): Readonly<
  AuthenticationExecutionContextBase & {
    readonly inputMode: Mode;
  }
> =>
  Object.freeze({
    authSource: request.authSource,
    inputMode: request.mode,
    requestedScopes: request.scopes,
    signal,
  });

export class AuthenticationExecutor<Result> {
  readonly #handlers: AuthenticationExecutionHandlers<Result>;

  constructor(handlers: AuthenticationExecutionHandlers<Result>) {
    this.#handlers = Object.freeze({ ...handlers });
  }

  async execute(
    request: AuthLoginRequest,
    options: AuthenticationExecutionOptions = {},
  ): Promise<Result> {
    const parsedRequest = parseAuthLoginRequest(request);
    const lifecycle = createExecutionLifecycle(parsedRequest, options);
    const signal = lifecycle.signal;

    try {
      signal.throwIfAborted();
      if (parsedRequest.mode === "official-browser") {
        const context = createContext(parsedRequest, signal);
        return await this.#handlers.officialBrowser(context);
      }

      const credentials = await acquireTransientCredentials(parsedRequest, signal);
      if (!(credentials instanceof TransientCredentials)) {
        throw new TypeError("The credential provider must return TransientCredentials.");
      }
      if (signal.aborted) {
        credentials.release();
        signal.throwIfAborted();
      }

      const context = createContext(parsedRequest, signal);
      return await credentials.withCredentials((values) =>
        this.#handlers.applicationCredentials(context, values),
      );
    } finally {
      lifecycle.dispose();
    }
  }
}
