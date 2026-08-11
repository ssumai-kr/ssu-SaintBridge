import { inspect } from "node:util";

import {
  applicationCredentialLoginMetadataSchema,
  interactiveBrowserLoginRequestSchema,
  type ApplicationCredentialLoginMetadata,
  type InteractiveBrowserLoginRequest,
} from "@ssu-saintbridge/types";

export interface CredentialValues {
  readonly identifier: string;
  readonly password: string;
}

export type TransientCredentialsOptions = CredentialValues;

export class TransientCredentials {
  #identifier: string;
  #password: string;
  #released = false;

  constructor(options: TransientCredentialsOptions) {
    if (options.identifier.length === 0 || options.identifier.length > 512) {
      throw new TypeError("The credential identifier must contain between 1 and 512 characters.");
    }
    if (options.password.length === 0 || options.password.length > 4_096) {
      throw new TypeError("The credential password must contain between 1 and 4096 characters.");
    }
    this.#identifier = options.identifier;
    this.#password = options.password;
  }

  get released(): boolean {
    return this.#released;
  }

  async withCredentials<Result>(
    consumer: (credentials: Readonly<CredentialValues>) => Promise<Result>,
  ): Promise<Result> {
    if (this.#released) throw new Error("The transient credentials have already been released.");
    const credentials = Object.freeze({
      identifier: this.#identifier,
      password: this.#password,
    });
    this.#released = true;
    try {
      return await consumer(credentials);
    } finally {
      this.#identifier = "";
      this.#password = "";
    }
  }

  release(): void {
    this.#released = true;
    this.#identifier = "";
    this.#password = "";
  }

  toJSON(): { readonly released: boolean; readonly redacted: true } {
    return { released: this.#released, redacted: true };
  }

  toString(): string {
    return "TransientCredentials([REDACTED])";
  }

  [inspect.custom](): string {
    return this.toString();
  }
}

export type CredentialProvider = () => TransientCredentials | Promise<TransientCredentials>;

export interface ApplicationCredentialLoginRequest extends ApplicationCredentialLoginMetadata {
  readonly acquireCredentials: CredentialProvider;
}

export type AuthLoginRequest = InteractiveBrowserLoginRequest | ApplicationCredentialLoginRequest;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const credentialRequestKeys = new Set(["acquireCredentials", "authSource", "mode", "scopes"]);

export const parseAuthLoginRequest = (value: unknown): AuthLoginRequest => {
  if (!isRecord(value)) throw new TypeError("The authentication request must be an object.");
  if (value.mode === "official-browser") return interactiveBrowserLoginRequestSchema.parse(value);
  if (value.mode !== "application-credentials") {
    throw new TypeError("The authentication input mode is not supported.");
  }
  if (Object.keys(value).some((key) => !credentialRequestKeys.has(key))) {
    throw new TypeError("The credential login request contains an unsupported field.");
  }
  if (typeof value.acquireCredentials !== "function") {
    throw new TypeError("Credential login requires an acquireCredentials provider.");
  }
  const acquireCredentials = value.acquireCredentials as CredentialProvider;
  const metadata = applicationCredentialLoginMetadataSchema.parse({
    authSource: value.authSource,
    mode: value.mode,
    scopes: value.scopes,
  });
  return Object.freeze({ ...metadata, acquireCredentials });
};
