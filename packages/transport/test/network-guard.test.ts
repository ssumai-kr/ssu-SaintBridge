import { describe, expect, it } from "vitest";

import { assertTestNetworkUrlAllowed } from "./support/network-guard.js";

describe("test network guard", () => {
  it("allows loopback mock servers", () => {
    expect(assertTestNetworkUrlAllowed("http://127.0.0.1:3000").hostname).toBe("127.0.0.1");
  });

  it.each(["https://saint.ssu.ac.kr", "https://smartid.ssu.ac.kr", "file:///tmp/data"])(
    "blocks non-loopback access: %s",
    (url) => {
      expect(() => assertTestNetworkUrlAllowed(url)).toThrow(
        "External network access is blocked in tests",
      );
    },
  );
});
