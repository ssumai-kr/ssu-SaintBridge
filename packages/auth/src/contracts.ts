import type { HttpSession } from "@ssu-saintbridge/transport";
import type {
  AuthSourceId,
  AuthSnapshot,
  AuthInputMode,
  ProviderDescriptor,
  ProviderId,
  ProviderSession,
  Scope,
} from "@ssu-saintbridge/types";

import type { AuthLoginRequest } from "./transient-credentials.js";

export interface ProviderCallbackContext {
  readonly authSource: AuthSourceId;
  readonly inputMode: AuthInputMode;
  readonly requestedScopes: readonly Scope[];
  readonly transport: HttpSession;
  readonly signal: AbortSignal;
}

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  openSession(context: ProviderCallbackContext): Promise<ProviderSession>;
}

export interface AuthOrchestrator {
  login(request: AuthLoginRequest): Promise<AuthSnapshot>;
  logout(authSource: AuthSourceId): Promise<AuthSnapshot>;
  getSnapshot(): AuthSnapshot;
  close(): Promise<void>;
}

export interface ProviderAdapterRegistration {
  readonly provider: ProviderId;
  readonly adapter: ProviderAdapter;
}

/**
 * Ordered input keeps duplicate registrations observable until validation.
 * A validated registry may use a keyed representation internally.
 */
export type ProviderAdapterRegistryInput = readonly ProviderAdapterRegistration[];
