import { describe, expect, it } from "vitest";

import { getServiceInfo } from "../src/index.js";

describe("server package", () => {
  it("exposes service metadata", () => {
    expect(getServiceInfo()).toEqual({
      name: "@ssu-saintbridge/server",
      auth: { state: "open", authSources: [], providers: [] },
    });
  });
});
