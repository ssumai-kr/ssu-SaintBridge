import { describe, expect, it } from "vitest";

import {
  createOfficialUpstreamUrlPolicy,
  UpstreamUrlPolicy,
  UpstreamUrlPolicyError,
  type UpstreamUrlPolicyViolation,
} from "../src/index.js";

const expectViolation = (action: () => unknown, violation: UpstreamUrlPolicyViolation): void => {
  try {
    action();
    throw new Error("Expected the URL policy to reject the input.");
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(UpstreamUrlPolicyError);
    expect((error as UpstreamUrlPolicyError).violation).toBe(violation);
  }
};

const unsafeAllowlistCases: readonly [readonly string[]][] = [
  [[]],
  [["*.ssu.ac.kr"]],
  [["saint.ssu.ac.kr/path"]],
  [["saint.ssu.ac.kr:443"]],
];

describe("UpstreamUrlPolicy", () => {
  it.each([
    "https://saint.ssu.ac.kr/irj/portal",
    "https://smartid.ssu.ac.kr/",
    "https://saint.ssu.ac.kr:443/irj/portal?command=login",
  ])("allows an official HTTPS URL: %s", (url) => {
    expect(createOfficialUpstreamUrlPolicy().assertAllowed(url).hostname).toMatch(/\.ssu\.ac\.kr$/);
  });

  it("resolves and validates relative redirects", () => {
    const redirect = createOfficialUpstreamUrlPolicy().resolveRedirect(
      "https://saint.ssu.ac.kr/irj/portal",
      "/irj/portal/callback?ticket=mock",
    );

    expect(redirect.toString()).toBe("https://saint.ssu.ac.kr/irj/portal/callback?ticket=mock");
  });

  it("allows redirects between the two explicitly allowed hosts", () => {
    const redirect = createOfficialUpstreamUrlPolicy().resolveRedirect(
      "https://saint.ssu.ac.kr/irj/portal",
      "https://smartid.ssu.ac.kr/login",
    );

    expect(redirect.hostname).toBe("smartid.ssu.ac.kr");
  });

  it.each(["http://saint.ssu.ac.kr", "ftp://saint.ssu.ac.kr/resource"])(
    "rejects a non-HTTPS URL: %s",
    (url) =>
      expectViolation(() => createOfficialUpstreamUrlPolicy().assertAllowed(url), "NON_HTTPS"),
  );

  it.each([
    "https://ssu.ac.kr",
    "https://saint.ssu.ac.kr.evil.example",
    "https://evil-saint.ssu.ac.kr",
    "https://127.0.0.1",
  ])("rejects a host that is not an exact allowlist match: %s", (url) => {
    expectViolation(() => createOfficialUpstreamUrlPolicy().assertAllowed(url), "HOST_NOT_ALLOWED");
  });

  it("rejects embedded credentials without serializing them", () => {
    const sensitiveUrl = "https://mock-user:mock-password@saint.ssu.ac.kr/irj/portal";

    expectViolation(
      () => createOfficialUpstreamUrlPolicy().assertAllowed(sensitiveUrl),
      "EMBEDDED_CREDENTIALS",
    );
    try {
      createOfficialUpstreamUrlPolicy().assertAllowed(sensitiveUrl);
    } catch (error: unknown) {
      expect(JSON.stringify(error)).not.toContain("mock-password");
    }
  });

  it("rejects an unexpected port", () => {
    expectViolation(
      () => createOfficialUpstreamUrlPolicy().assertAllowed("https://saint.ssu.ac.kr:8443"),
      "UNEXPECTED_PORT",
    );
  });

  it("rejects a URL fragment", () => {
    expectViolation(
      () => createOfficialUpstreamUrlPolicy().assertAllowed("https://saint.ssu.ac.kr/#token"),
      "FRAGMENT_NOT_ALLOWED",
    );
  });

  it.each(["not a URL", "/relative-only"])("rejects an invalid absolute URL: %s", (url) => {
    expectViolation(() => createOfficialUpstreamUrlPolicy().assertAllowed(url), "INVALID_URL");
  });

  it("rejects malformed redirect locations", () => {
    expectViolation(
      () =>
        createOfficialUpstreamUrlPolicy().resolveRedirect(
          "https://saint.ssu.ac.kr/irj/portal",
          "https://[invalid",
        ),
      "INVALID_URL",
    );
  });

  it.each(unsafeAllowlistCases)("rejects an unsafe allowlist configuration: %j", (allowedHosts) => {
    expect(() => new UpstreamUrlPolicy({ allowedHosts })).toThrow(TypeError);
  });

  it("normalizes configured host casing", () => {
    const policy = new UpstreamUrlPolicy({ allowedHosts: ["SAINT.SSU.AC.KR"] });
    expect(policy.assertAllowed("https://saint.ssu.ac.kr").hostname).toBe("saint.ssu.ac.kr");
  });
});
