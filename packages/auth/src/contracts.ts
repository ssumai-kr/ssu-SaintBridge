import type { HttpSession } from "@ssu-saintbridge/transport";
import type {
  AuthSnapshot,
  ProviderDescriptor,
  ProviderId,
  ProviderSession,
  Scope,
} from "@ssu-saintbridge/types";

export interface BrowserLoginRequest {
  readonly scopes: readonly Scope[];
}

export interface ProviderCallbackContext {
  readonly requestedScopes: readonly Scope[];
  readonly transport: HttpSession;
}

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  openSession(context: ProviderCallbackContext): Promise<ProviderSession>;
}

export interface AuthOrchestrator {
  login(request: BrowserLoginRequest): Promise<AuthSnapshot>;
  getSnapshot(): AuthSnapshot;
  close(): Promise<void>;
}

export type ProviderAdapterRegistry = Readonly<Partial<Record<ProviderId, ProviderAdapter>>>;
