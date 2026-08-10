import { describe, expect, it } from "vitest";

import { createInitialProtocolStatus } from "../src/index.js";

describe("protocol package", () => {
  it("starts anonymously", () => {
    expect(createInitialProtocolStatus()).toEqual({ state: "anonymous", lastError: null });
  });
});
