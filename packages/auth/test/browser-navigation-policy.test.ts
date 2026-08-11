import { describe, expect, it } from "vitest";

import {
  BrowserNavigationPolicy,
  BrowserNavigationPolicyError,
  BrowserNavigationPolicyRegistry,
  type BrowserNavigationPolicyOptions,
  type BrowserNavigationPolicyViolation,
} from "../src/index.js";

const configurations = [
  {
    authSource: "smartid",
    entryUrl: "https://login.smartid.example.invalid/start",
    allowedHosts: ["login.smartid.example.invalid", "callback.smartid.example.invalid"],
  },
  {
    authSource: "library",
    entryUrl: "https://login.library.example.invalid/start",
    allowedHosts: ["login.library.example.invalid"],
  },
] as const satisfies readonly BrowserNavigationPolicyOptions[];

const expectViolation = (
  action: () => unknown,
  authSource: "smartid" | "library",
  violation: BrowserNavigationPolicyViolation,
): void => {
  try {
    action();
    throw new Error("Expected the browser navigation policy to reject the input.");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(BrowserNavigationPolicyError);
    expect(error).toMatchObject({ authSource, violation });
  }
};

describe("browser navigation policy", () => {
  it("keeps SmartID and Library host allowlists separate", () => {
    const registry = new BrowserNavigationPolicyRegistry(configurations);

    expect(
      registry.get("smartid").assertNavigation("https://callback.smartid.example.invalid/done")
        .hostname,
    ).toBe("callback.smartid.example.invalid");
    expect(
      registry.get("library").assertNavigation("https://login.library.example.invalid/account")
        .hostname,
    ).toBe("login.library.example.invalid");
    expectViolation(
      () =>
        registry.get("smartid").assertNavigation("https://login.library.example.invalid/account"),
      "smartid",
      "HOST_NOT_ALLOWED",
    );
    expectViolation(
      () => registry.get("library").assertNavigation("https://login.smartid.example.invalid/start"),
      "library",
      "HOST_NOT_ALLOWED",
    );
  });

  it("resolves relative and cross-host navigation within one source policy", () => {
    const policy = new BrowserNavigationPolicy(configurations[0]);

    expect(policy.resolveNavigation(policy.entryUrl, "/continue?flow=mock").toString()).toBe(
      "https://login.smartid.example.invalid/continue?flow=mock",
    );
    expect(
      policy.resolveNavigation(policy.entryUrl, "https://callback.smartid.example.invalid/complete")
        .hostname,
    ).toBe("callback.smartid.example.invalid");
  });

  it.each([
    ["http://login.smartid.example.invalid", "NON_HTTPS"],
    ["ftp://login.smartid.example.invalid/resource", "NON_HTTPS"],
    ["https://mock-user:mock-password@login.smartid.example.invalid", "EMBEDDED_CREDENTIALS"],
    ["https://login.smartid.example.invalid:8443", "UNEXPECTED_PORT"],
    ["https://login.smartid.example.invalid/#token", "FRAGMENT_NOT_ALLOWED"],
    ["https://login.smartid.example.invalid.evil.example", "HOST_NOT_ALLOWED"],
  ] as const)("rejects unsafe browser navigation: %s", (url, violation) => {
    const policy = new BrowserNavigationPolicy(configurations[0]);
    expectViolation(() => policy.assertNavigation(url), "smartid", violation);
  });

  it("serializes only redacted policy metadata", () => {
    const secret = ["never", "serialize", "this"].join("-");
    const policy = new BrowserNavigationPolicy(configurations[0]);

    try {
      policy.assertNavigation(
        `https://mock-user:${secret}@login.smartid.example.invalid/private?token=${secret}`,
      );
      throw new Error("Expected navigation to be rejected.");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(BrowserNavigationPolicyError);
      const serialized = JSON.stringify(error);
      expect(serialized).toBe(
        '{"name":"BrowserNavigationPolicyError","authSource":"smartid","violation":"EMBEDDED_CREDENTIALS"}',
      );
      expect(serialized).not.toContain(secret);
    }
  });

  it("returns a new entry URL object instead of mutable policy state", () => {
    const policy = new BrowserNavigationPolicy(configurations[0]);
    const first = policy.entryUrl;
    first.pathname = "/changed-by-caller";

    expect(policy.entryUrl.pathname).toBe("/start");
  });

  it("rejects an entry URL outside its own allowlist", () => {
    expect(
      () =>
        new BrowserNavigationPolicy({
          authSource: "smartid",
          entryUrl: "https://unexpected.example.invalid/start",
          allowedHosts: ["login.smartid.example.invalid"],
        }),
    ).toThrow(BrowserNavigationPolicyError);
  });

  it("requires exactly one configuration for each authentication source", () => {
    expect(() => new BrowserNavigationPolicyRegistry([configurations[0]])).toThrow(
      "policy for library is required",
    );
    expect(
      () => new BrowserNavigationPolicyRegistry([configurations[0], configurations[0]]),
    ).toThrow("policy for smartid is duplicated");
  });
});
