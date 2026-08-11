import type { HttpSession } from "@ssu-saintbridge/transport";
import type {
  AuthSourceId,
  AuthSnapshot,
  BrowserLoginRequest,
  ProviderDescriptor,
  ProviderId,
  ProviderSession,
  Scope,
} from "@ssu-saintbridge/types";

export type { BrowserLoginRequest } from "@ssu-saintbridge/types";

export interface ProviderCallbackContext {
  readonly authSource: AuthSourceId;
  readonly requestedScopes: readonly Scope[];
  readonly transport: HttpSession;
}

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  openSession(context: ProviderCallbackContext): Promise<ProviderSession>;
}

export interface AuthOrchestrator {
  login(request: BrowserLoginRequest): Promise<AuthSnapshot>;
  logout(authSource: AuthSourceId): Promise<AuthSnapshot>;
  getSnapshot(): AuthSnapshot;
  close(): Promise<void>;
}

export type ProviderAdapterRegistry = Readonly<Partial<Record<ProviderId, ProviderAdapter>>>;
