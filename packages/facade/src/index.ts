import type { AuthOrchestrator } from "@ssu-saintbridge/auth";
import type { LibraryProviderAdapter } from "@ssu-saintbridge/library";
import type { LmsProviderAdapter } from "@ssu-saintbridge/lms";
import { authSnapshotSchema, type AuthSnapshot } from "@ssu-saintbridge/types";
import type { UsaintProviderAdapter } from "@ssu-saintbridge/usaint";

export interface SaintBridgeAdapterRegistry {
  readonly auth: AuthOrchestrator;
  readonly usaint: UsaintProviderAdapter;
  readonly lms: LmsProviderAdapter;
  readonly library: LibraryProviderAdapter;
}

export const createInitialBridgeStatus = (): AuthSnapshot =>
  authSnapshotSchema.parse({ state: "signed-out", providers: [] });
