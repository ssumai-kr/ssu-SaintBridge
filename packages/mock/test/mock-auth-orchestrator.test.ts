import { describe, expect, it } from "vitest";

import { createMockAuthMatrix, mockAllProviderScopes } from "../src/index.js";

describe("mock auth matrix", () => {
  it("represents two users with three independent provider sessions", async () => {
    const matrix = createMockAuthMatrix();
    await Promise.all(
      Object.values(matrix).map(async (auth) => auth.login({ scopes: mockAllProviderScopes })),
    );

    expect(matrix["mock-user-a"].getSnapshot().providers).toHaveLength(3);
    expect(matrix["mock-user-b"].getSnapshot().providers).toHaveLength(3);

    matrix["mock-user-a"].expireProvider("lms");
    expect(
      matrix["mock-user-a"].getSnapshot().providers.find(({ provider }) => provider === "lms")
        ?.status,
    ).toBe("expired");
    expect(
      matrix["mock-user-a"].getSnapshot().providers.find(({ provider }) => provider === "usaint")
        ?.status,
    ).toBe("ready");
    expect(
      matrix["mock-user-b"].getSnapshot().providers.find(({ provider }) => provider === "lms")
        ?.status,
    ).toBe("ready");
  });

  it("activates only providers required by requested scopes", async () => {
    const auth = createMockAuthMatrix()["mock-user-a"];
    const snapshot = await auth.login({ scopes: ["library:catalog.read"] });

    expect(snapshot.providers.map(({ provider }) => provider)).toEqual(["library"]);
  });

  it("discards all provider state on close", async () => {
    const auth = createMockAuthMatrix()["mock-user-a"];
    await auth.login({ scopes: mockAllProviderScopes });
    await auth.close();

    expect(auth.getSnapshot()).toEqual({ state: "closed", providers: [] });
  });
});
