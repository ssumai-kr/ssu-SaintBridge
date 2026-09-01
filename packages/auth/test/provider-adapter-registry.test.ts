import type {
  ProviderAdapterRegistryInput,
  ProviderCallbackContractViolation,
} from "../src/index.js";
import { ProviderAdapterRegistry, ProviderCallbackContractError } from "../src/index.js";
import {
  createProviderAdapter,
  createProviderDescriptor,
  libraryAdapter,
  lmsAdapter,
  usaintAdapter,
} from "./support/provider-adapter-fixtures.js";
import { describe, expect, it } from "vitest";

const expectViolation = (
  action: () => unknown,
  violation: ProviderCallbackContractViolation,
): void => {
  try {
    action();
    throw new Error("Expected provider adapter registry validation to fail.");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ProviderCallbackContractError);
    expect(error).toMatchObject({ violation });
  }
};

describe("provider adapter registry", () => {
  it("validates adapters and exposes canonical provider metadata only", () => {
    const registry = new ProviderAdapterRegistry([
      { provider: "library", adapter: libraryAdapter },
      { provider: "lms", adapter: lmsAdapter },
      { provider: "usaint", adapter: usaintAdapter },
    ]);

    expect(registry.has("usaint")).toBe(true);
    expect(registry.get("lms").descriptor.provider).toBe("lms");
    expect(registry.get("lms")).not.toBe(lmsAdapter);
    expect(Object.isFrozen(registry.get("lms"))).toBe(true);
    expect(JSON.parse(JSON.stringify(registry))).toEqual({
      providers: ["usaint", "lms", "library"],
    });
    expect(JSON.stringify(registry)).not.toContain("openSession");
  });

  it("rejects invalid and duplicate registry keys", () => {
    expectViolation(
      () =>
        new ProviderAdapterRegistry([
          { provider: "unknown", adapter: usaintAdapter },
        ] as unknown as ProviderAdapterRegistryInput),
      "INVALID_REGISTRY_KEY",
    );
    expectViolation(
      () =>
        new ProviderAdapterRegistry([
          { provider: "usaint", adapter: usaintAdapter },
          { provider: "usaint", adapter: usaintAdapter },
        ]),
      "DUPLICATE_ADAPTER",
    );
  });

  it("rejects descriptor and registry-key mismatches", () => {
    expectViolation(
      () => new ProviderAdapterRegistry([{ provider: "usaint", adapter: lmsAdapter }]),
      "ADAPTER_PROVIDER_MISMATCH",
    );
  });

  it("rejects malformed adapters without exposing their input", () => {
    const secret = ["never", "serialize", "this"].join("-");
    const malformedDescriptor = {
      provider: "lms",
      supportedAuthSources: ["smartid"],
      supportsPublicAccess: false,
      supportedScopes: ["usaint:profile.read"],
      capabilities: [secret],
    };

    try {
      new ProviderAdapterRegistry([
        {
          provider: "lms",
          adapter: {
            descriptor: malformedDescriptor,
            openSession: async () => {
              throw new Error(secret);
            },
          },
        },
      ] as unknown as ProviderAdapterRegistryInput);
      throw new Error("Expected malformed adapter validation to fail.");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(ProviderCallbackContractError);
      expect(error).toMatchObject({ violation: "INVALID_ADAPTER_DESCRIPTOR", provider: "lms" });
      expect(JSON.stringify(error)).not.toContain(secret);
    }

    expectViolation(
      () =>
        new ProviderAdapterRegistry([
          {
            provider: "library",
            adapter: { descriptor: libraryAdapter.descriptor },
          },
        ] as unknown as ProviderAdapterRegistryInput),
      "INVALID_ADAPTER",
    );
  });

  it("rejects access to an unregistered adapter", () => {
    const registry = new ProviderAdapterRegistry([{ provider: "usaint", adapter: usaintAdapter }]);

    expectViolation(() => registry.get("lms"), "ADAPTER_NOT_REGISTERED");
    expect(registry.has("lms")).toBe(false);
  });

  it("copies validated descriptors instead of trusting later adapter mutation", () => {
    const mutableAdapter = {
      descriptor: {
        ...createProviderDescriptor({
          provider: "library",
          supportedAuthSources: ["library"],
          supportedScopes: ["library:loans.read"],
        }),
      },
      openSession: createProviderAdapter(libraryAdapter.descriptor).openSession,
    };
    const registry = new ProviderAdapterRegistry([
      { provider: "library", adapter: mutableAdapter },
    ] as ProviderAdapterRegistryInput);

    mutableAdapter.descriptor = { ...mutableAdapter.descriptor, provider: "usaint" };

    expect(registry.get("library").descriptor.provider).toBe("library");
  });
});
