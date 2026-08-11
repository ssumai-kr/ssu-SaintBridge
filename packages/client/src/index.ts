import type { AuthSnapshot, ProviderId, SourceRef } from "@ssu-saintbridge/types";

export interface SaintBridgeClientOptions {
  readonly baseUrl: string;
  readonly getAccessToken: () => string | Promise<string>;
}

export interface ProviderStatusResponse {
  readonly auth: AuthSnapshot;
  readonly supportedProviders: readonly ProviderId[];
  readonly source: SourceRef;
}
