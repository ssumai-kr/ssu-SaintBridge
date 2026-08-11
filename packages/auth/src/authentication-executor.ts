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
}

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
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();

    if (parsedRequest.mode === "official-browser") {
      const context = createContext(parsedRequest, signal);
      return this.#handlers.officialBrowser(context);
    }

    const credentials = await parsedRequest.acquireCredentials();
    if (!(credentials instanceof TransientCredentials)) {
      throw new TypeError("The credential provider must return TransientCredentials.");
    }
    if (signal.aborted) {
      credentials.release();
      signal.throwIfAborted();
    }

    const context = createContext(parsedRequest, signal);
    return credentials.withCredentials((values) =>
      this.#handlers.applicationCredentials(context, values),
    );
  }
}
