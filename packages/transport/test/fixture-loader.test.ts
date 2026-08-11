import { describe, expect, it } from "vitest";

import { loadFixtureJson, resolveFixturePath } from "./support/fixture-loader.js";

describe("fixture loader", () => {
  it("loads a fixture from the repository fixture root", async () => {
    await expect(loadFixtureJson("mock/health.json")).resolves.toEqual({ ok: true });
  });

  it.each(["", "../package.json", "/tmp/untrusted.json"])(
    "rejects a path outside the fixture root: %s",
    (path) => {
      expect(() => resolveFixturePath(path)).toThrow();
    },
  );
});
