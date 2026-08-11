import { describe, expect, it } from "vitest";
import { TransientCredentials } from "@ssu-saintbridge/auth";

import {
  createMockAuthMatrix,
  mockLibraryScopes,
  mockPublicLibraryScopes,
  mockSmartIdScopes,
} from "../src/index.js";

const loginAllProviders = async (
  auth: ReturnType<typeof createMockAuthMatrix>["mock-user-a"],
): Promise<void> => {
  await auth.login({
    authSource: "smartid",
    mode: "official-browser",
    scopes: mockSmartIdScopes,
  });
  await auth.login({
    authSource: "library",
    mode: "application-credentials",
    scopes: mockLibraryScopes,
    acquireCredentials: () =>
      new TransientCredentials({ identifier: "mock-user", password: "mock-password" }),
  });
};

describe("mock auth matrix", () => {
  it("represents two users, two auth sources, and three provider sessions", async () => {
    const matrix = createMockAuthMatrix();
    await Promise.all(Object.values(matrix).map(loginAllProviders));

    expect(matrix["mock-user-a"].getSnapshot().authSources).toHaveLength(2);
    expect(matrix["mock-user-a"].getSnapshot().providers).toHaveLength(3);
    expect(matrix["mock-user-b"].getSnapshot().authSources).toHaveLength(2);
    expect(matrix["mock-user-b"].getSnapshot().providers).toHaveLength(3);
  });

  it("expires SmartID without damaging library auth or another user", async () => {
    const matrix = createMockAuthMatrix();
    await Promise.all(Object.values(matrix).map(loginAllProviders));

    matrix["mock-user-a"].expireAuthSource("smartid");
    expect(
      matrix["mock-user-a"].getSnapshot().providers.find(({ provider }) => provider === "usaint")
        ?.status,
    ).toBe("expired");
    expect(
      matrix["mock-user-a"].getSnapshot().providers.find(({ provider }) => provider === "lms")
        ?.status,
    ).toBe("expired");
    expect(
      matrix["mock-user-a"].getSnapshot().providers.find(({ provider }) => provider === "library"),
    ).toMatchObject({ authenticatedBy: "library", status: "ready" });
    expect(
      matrix["mock-user-b"].getSnapshot().providers.find(({ provider }) => provider === "usaint")
        ?.status,
    ).toBe("ready");
  });

  it("allows library auth to activate only the library provider", async () => {
    const auth = createMockAuthMatrix()["mock-user-a"];
    const snapshot = await auth.login({
      authSource: "library",
      mode: "official-browser",
      scopes: ["library:loans.read"],
    });

    expect(snapshot.authSources).toEqual([
      {
        source: "library",
        inputMode: "official-browser",
        status: "authenticated",
        expiresAt: null,
      },
    ]);
    expect(snapshot.providers).toEqual([
      expect.objectContaining({ provider: "library", authenticatedBy: "library" }),
    ]);
    await expect(
      auth.login({
        authSource: "library",
        mode: "official-browser",
        scopes: ["usaint:profile.read"],
      }),
    ).rejects.toThrow("only request library scopes");
  });

  it("consumes application credentials once without retaining them", async () => {
    const auth = createMockAuthMatrix()["mock-user-a"];
    const credentials = new TransientCredentials({
      identifier: "mock-user",
      password: "mock-password",
    });
    const snapshot = await auth.login({
      authSource: "smartid",
      mode: "application-credentials",
      scopes: mockSmartIdScopes,
      acquireCredentials: () => credentials,
    });

    expect(credentials.released).toBe(true);
    expect(snapshot.authSources).toEqual([
      expect.objectContaining({ source: "smartid", inputMode: "application-credentials" }),
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("mock-password");
  });

  it("does not mutate auth state when credential acquisition fails", async () => {
    const auth = createMockAuthMatrix()["mock-user-a"];

    await expect(
      auth.login({
        authSource: "smartid",
        mode: "application-credentials",
        scopes: mockSmartIdScopes,
        acquireCredentials: () => {
          throw new Error("credential input cancelled");
        },
      }),
    ).rejects.toThrow("credential input cancelled");
    expect(auth.getSnapshot()).toEqual({ state: "open", authSources: [], providers: [] });
  });

  it("represents public library access without an auth source", () => {
    const auth = createMockAuthMatrix()["mock-user-a"];
    const snapshot = auth.openPublicLibrary(mockPublicLibraryScopes);

    expect(snapshot.authSources).toEqual([]);
    expect(snapshot.providers).toEqual([
      expect.objectContaining({ provider: "library", authenticatedBy: "public" }),
    ]);
  });

  it("logs out one auth source without closing another", async () => {
    const auth = createMockAuthMatrix()["mock-user-a"];
    await loginAllProviders(auth);
    const snapshot = await auth.logout("library");

    expect(snapshot.authSources.map(({ source }) => source)).toEqual(["smartid"]);
    expect(snapshot.providers.map(({ provider }) => provider).sort()).toEqual(["lms", "usaint"]);
  });

  it("discards all auth and provider state on close", async () => {
    const auth = createMockAuthMatrix()["mock-user-a"];
    await loginAllProviders(auth);
    await auth.close();

    expect(auth.getSnapshot()).toEqual({ state: "closed", authSources: [], providers: [] });
  });
});
