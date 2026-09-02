import {
  ProviderAdapterRegistry,
  ProviderCallbackContractError,
  createProviderCallbackPlan,
  type ProviderCallbackContractViolation,
} from "../src/index.js";
import {
  createProviderAdapter,
  createProviderDescriptor,
  libraryAdapter,
  lmsAdapter,
  usaintAdapter,
} from "./support/provider-adapter-fixtures.js";
import { describe, expect, it } from "vitest";

const fullRegistry = (): ProviderAdapterRegistry =>
  new ProviderAdapterRegistry([
    { provider: "usaint", adapter: usaintAdapter },
    { provider: "lms", adapter: lmsAdapter },
    { provider: "library", adapter: libraryAdapter },
  ]);

const expectViolation = (
  action: () => unknown,
  violation: ProviderCallbackContractViolation,
): void => {
  try {
    action();
    throw new Error("Expected provider callback planning to fail.");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ProviderCallbackContractError);
    expect(error).toMatchObject({ violation });
  }
};

describe("provider callback plan", () => {
  it("groups scopes by provider in canonical order while preserving local scope order", () => {
    const plan = createProviderCallbackPlan(
      {
        authSource: "smartid",
        inputMode: "official-browser",
        requestedScopes: [
          "library:loans.read",
          "lms:tasks.read",
          "usaint:profile.read",
          "lms:courses.read",
        ],
      },
      fullRegistry(),
    );

    expect(plan).toEqual({
      authSource: "smartid",
      inputMode: "official-browser",
      callbacks: [
        { provider: "usaint", requestedScopes: ["usaint:profile.read"] },
        {
          provider: "lms",
          requestedScopes: ["lms:tasks.read", "lms:courses.read"],
        },
        { provider: "library", requestedScopes: ["library:loans.read"] },
      ],
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.callbacks)).toBe(true);
    expect(
      plan.callbacks.every(
        (callback) => Object.isFrozen(callback) && Object.isFrozen(callback.requestedScopes),
      ),
    ).toBe(true);
  });

  it("does not include unrequested providers or runtime adapter objects", () => {
    const plan = createProviderCallbackPlan(
      {
        authSource: "smartid",
        inputMode: "application-credentials",
        requestedScopes: ["lms:courses.read"],
      },
      fullRegistry(),
    );
    const serialized = JSON.stringify(plan);

    expect(plan.callbacks).toEqual([{ provider: "lms", requestedScopes: ["lms:courses.read"] }]);
    expect(serialized).not.toContain("openSession");
    expect(serialized).not.toContain("transport");
  });

  it("rejects Library authentication plans for u-SAINT and LMS", () => {
    for (const requestedScope of ["usaint:profile.read", "lms:courses.read"] as const) {
      expectViolation(
        () =>
          createProviderCallbackPlan(
            {
              authSource: "library",
              inputMode: "official-browser",
              requestedScopes: [requestedScope],
            },
            fullRegistry(),
          ),
        "BINDING_NOT_ALLOWED",
      );
    }
  });

  it("rejects adapters that do not declare the requested authentication source", () => {
    const libraryNativeOnly = createProviderAdapter(
      createProviderDescriptor({
        provider: "library",
        supportedAuthSources: ["library"],
        supportedScopes: ["library:loans.read"],
      }),
    );
    const registry = new ProviderAdapterRegistry([
      { provider: "library", adapter: libraryNativeOnly },
    ]);

    expectViolation(
      () =>
        createProviderCallbackPlan(
          {
            authSource: "smartid",
            inputMode: "official-browser",
            requestedScopes: ["library:loans.read"],
          },
          registry,
        ),
      "AUTH_SOURCE_NOT_SUPPORTED",
    );
  });

  it("rejects unregistered adapters and descriptor-unsupported scopes", () => {
    const missingLms = new ProviderAdapterRegistry([
      { provider: "usaint", adapter: usaintAdapter },
    ]);
    expectViolation(
      () =>
        createProviderCallbackPlan(
          {
            authSource: "smartid",
            inputMode: "official-browser",
            requestedScopes: ["lms:courses.read"],
          },
          missingLms,
        ),
      "ADAPTER_NOT_REGISTERED",
    );

    const limitedLms = createProviderAdapter(
      createProviderDescriptor({
        provider: "lms",
        supportedAuthSources: ["smartid"],
        supportedScopes: ["lms:courses.read"],
      }),
    );
    expectViolation(
      () =>
        createProviderCallbackPlan(
          {
            authSource: "smartid",
            inputMode: "official-browser",
            requestedScopes: ["lms:tasks.read"],
          },
          new ProviderAdapterRegistry([{ provider: "lms", adapter: limitedLms }]),
        ),
      "SCOPE_NOT_SUPPORTED",
    );
  });

  it("rejects duplicate or malformed callback requests", () => {
    expectViolation(
      () =>
        createProviderCallbackPlan(
          {
            authSource: "smartid",
            inputMode: "official-browser",
            requestedScopes: ["lms:courses.read", "lms:courses.read"],
          },
          fullRegistry(),
        ),
      "INVALID_CALLBACK_REQUEST",
    );
    expectViolation(
      () =>
        createProviderCallbackPlan(
          {
            authSource: "smartid",
            inputMode: "official-browser",
            requestedScopes: ["unknown:scope"],
          } as unknown as Parameters<typeof createProviderCallbackPlan>[0],
          fullRegistry(),
        ),
      "INVALID_CALLBACK_REQUEST",
    );
  });

  it("does not accept an unvalidated registry-shaped object", () => {
    expectViolation(
      () =>
        createProviderCallbackPlan(
          {
            authSource: "smartid",
            inputMode: "official-browser",
            requestedScopes: ["lms:courses.read"],
          },
          {
            get: () => lmsAdapter,
          } as unknown as ProviderAdapterRegistry,
        ),
      "INVALID_ADAPTER_REGISTRY",
    );
  });
});
