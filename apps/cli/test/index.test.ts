import { describe, expect, it } from "vitest";

import { getCliInfo } from "../src/index.js";

describe("cli package", () => {
  it("exposes CLI metadata", () => {
    expect(getCliInfo().name).toBe("ssu-saintbridge");
  });
});
