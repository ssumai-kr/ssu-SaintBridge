import { describe, expect, it, vi } from "vitest";
import { TransientCredentials, type ProviderCallbackContext } from "@ssu-saintbridge/auth";
import type { ProviderId } from "@ssu-saintbridge/types";

import {
  MockAuthOrchestrator,
  createMockAuthMatrix,
  mockAllProviderScopes,
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
  it("exposes a controllable authenticating state through the production state contract", async () => {
    const gate = Promise.withResolvers<void>();
    const authenticationHandler = vi.fn(() => gate.promise);
    const auth = new MockAuthOrchestrator("mock-user-a", { authenticationHandler });

    const login = auth.login({
      authSource: "smartid",
      mode: "official-browser",
      scopes: mockSmartIdScopes,
    });

    expect(auth.getSnapshot()).toEqual({
      state: "open",
      authSources: [
        {
          source: "smartid",
          inputMode: "official-browser",
          status: "authenticating",
          expiresAt: null,
        },
      ],
      providers: [],
    });
    expect(authenticationHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        authSource: "smartid",
        inputMode: "official-browser",
        requestedScopes: mockSmartIdScopes,
      }),
    );

    gate.resolve();
    await expect(login).resolves.toMatchObject({
      authSources: [expect.objectContaining({ status: "authenticated" })],
    });
  });

  it("rejects overlapping mock logins for the same source", async () => {
    const gate = Promise.withResolvers<void>();
    const auth = new MockAuthOrchestrator("mock-user-a", {
      authenticationHandler: () => gate.promise,
    });
    const first = auth.login({
      authSource: "library",
      mode: "official-browser",
      scopes: mockLibraryScopes,
    });

    await expect(
      auth.login({
        authSource: "library",
        mode: "official-browser",
        scopes: mockLibraryScopes,
      }),
    ).rejects.toMatchObject({ violation: "ATTEMPT_ALREADY_ACTIVE" });
    expect(auth.getSnapshot().authSources[0]).toMatchObject({ status: "authenticating" });

    gate.resolve();
    await expect(first).resolves.toMatchObject({
      authSources: [expect.objectContaining({ status: "authenticated" })],
    });
  });

  it("restores source and provider state after controlled reauthentication failure", async () => {
    const retryGate = Promise.withResolvers<void>();
    const failure = new Error("controlled mock reauthentication failure");
    let lmsCallbackCount = 0;
    const auth = new MockAuthOrchestrator("mock-user-a", {
      providerCallbackHandler: async (provider) => {
        if (provider !== "lms") return;
        lmsCallbackCount += 1;
        if (lmsCallbackCount === 2) await retryGate.promise;
      },
    });
    await auth.login({
      authSource: "smartid",
      mode: "official-browser",
      scopes: mockSmartIdScopes,
    });

    const retry = auth.login({
      authSource: "smartid",
      mode: "official-browser",
      scopes: mockSmartIdScopes,
    });
    expect(auth.getSnapshot()).toMatchObject({
      authSources: [expect.objectContaining({ status: "authenticating" })],
      providers: [
        expect.objectContaining({ provider: "usaint", status: "expired" }),
        expect.objectContaining({ provider: "lms", status: "expired" }),
      ],
    });

    retryGate.reject(failure);
    await expect(retry).rejects.toBe(failure);
    expect(auth.getSnapshot()).toMatchObject({
      authSources: [expect.objectContaining({ status: "authenticated" })],
      providers: [
        expect.objectContaining({ provider: "usaint", status: "ready" }),
        expect.objectContaining({ provider: "lms", status: "ready" }),
      ],
    });
  });

  it("allows SmartID and Library mock authentication to run concurrently", async () => {
    const auth = new MockAuthOrchestrator("mock-user-a");

    await Promise.all([
      auth.login({
        authSource: "smartid",
        mode: "official-browser",
        scopes: mockSmartIdScopes,
      }),
      auth.login({
        authSource: "library",
        mode: "official-browser",
        scopes: mockLibraryScopes,
      }),
    ]);

    expect(auth.getSnapshot().authSources).toEqual([
      expect.objectContaining({ source: "smartid", status: "authenticated" }),
      expect.objectContaining({ source: "library", status: "authenticated" }),
    ]);
    expect(auth.getSnapshot().providers).toHaveLength(3);
  });

  it("routes SmartID scopes through deterministic provider-scoped callbacks", async () => {
    const callbacks: Array<{
      readonly provider: ProviderId;
      readonly context: ProviderCallbackContext;
    }> = [];
    const auth = new MockAuthOrchestrator("mock-user-a", {
      providerCallbackHandler: async (provider, context) => {
        callbacks.push({ provider, context });
      },
    });

    const snapshot = await auth.login({
      authSource: "smartid",
      mode: "official-browser",
      scopes: mockAllProviderScopes,
    });

    expect(callbacks.map(({ provider }) => provider)).toEqual(["usaint", "lms", "library"]);
    expect(callbacks.map(({ context }) => context.requestedScopes)).toEqual([
      ["usaint:profile.read"],
      ["lms:courses.read"],
      ["library:loans.read"],
    ]);
    expect(new Set(callbacks.map(({ context }) => context.transport).values()).size).toBe(3);
    expect(snapshot.providers).toEqual([
      expect.objectContaining({ provider: "usaint", authenticatedBy: "smartid" }),
      expect.objectContaining({ provider: "lms", authenticatedBy: "smartid" }),
      expect.objectContaining({ provider: "library", authenticatedBy: "smartid" }),
    ]);
  });

  it("rolls back staged callback transports without damaging another auth source", async () => {
    const callbackFailure = new Error("controlled LMS callback failure");
    const transportEvents: Array<{
      readonly type: "created" | "closed";
      readonly provider: ProviderId;
      readonly transportId: string;
    }> = [];
    const auth = new MockAuthOrchestrator("mock-user-a", {
      providerCallbackHandler: async (provider, context) => {
        if (provider === "lms" && context.authSource === "smartid") throw callbackFailure;
      },
      providerTransportHandler: (event) => transportEvents.push(event),
    });
    await auth.login({
      authSource: "library",
      mode: "official-browser",
      scopes: mockLibraryScopes,
    });

    await expect(
      auth.login({
        authSource: "smartid",
        mode: "official-browser",
        scopes: mockSmartIdScopes,
      }),
    ).rejects.toBe(callbackFailure);

    expect(auth.getSnapshot()).toEqual({
      state: "open",
      authSources: [expect.objectContaining({ source: "library", status: "authenticated" })],
      providers: [
        expect.objectContaining({
          provider: "library",
          authenticatedBy: "library",
          status: "ready",
        }),
      ],
    });
    expect(transportEvents).toEqual([
      { type: "created", provider: "library", transportId: "library:0" },
      { type: "created", provider: "usaint", transportId: "usaint:1" },
      { type: "created", provider: "lms", transportId: "lms:2" },
      { type: "closed", provider: "lms", transportId: "lms:2" },
      { type: "closed", provider: "usaint", transportId: "usaint:1" },
    ]);
  });

  it("rejects a late delegated callback after a Library-native callback wins", async () => {
    const smartIdCallbackStarted = Promise.withResolvers<void>();
    const releaseSmartIdCallback = Promise.withResolvers<void>();
    const transportEvents: Array<{
      readonly type: "created" | "closed";
      readonly provider: ProviderId;
      readonly transportId: string;
    }> = [];
    const auth = new MockAuthOrchestrator("mock-user-a", {
      providerCallbackHandler: async (provider, context) => {
        if (provider === "library" && context.authSource === "smartid") {
          smartIdCallbackStarted.resolve();
          await releaseSmartIdCallback.promise;
        }
      },
      providerTransportHandler: (event) => transportEvents.push(event),
    });

    const lateSmartId = auth.login({
      authSource: "smartid",
      mode: "official-browser",
      scopes: mockLibraryScopes,
    });
    await smartIdCallbackStarted.promise;
    const libraryWinner = await auth.login({
      authSource: "library",
      mode: "official-browser",
      scopes: mockLibraryScopes,
    });
    expect(libraryWinner.authSources).toEqual([
      expect.objectContaining({ source: "smartid", status: "authenticating" }),
      expect.objectContaining({ source: "library", status: "authenticated" }),
    ]);
    releaseSmartIdCallback.resolve();

    await expect(lateSmartId).rejects.toMatchObject({ violation: "STALE_TRANSACTION" });
    expect(auth.getSnapshot()).toEqual({
      state: "open",
      authSources: [expect.objectContaining({ source: "library", status: "authenticated" })],
      providers: [expect.objectContaining({ provider: "library", authenticatedBy: "library" })],
    });
    expect(transportEvents).toEqual([
      { type: "created", provider: "library", transportId: "library:0" },
      { type: "created", provider: "library", transportId: "library:1" },
      { type: "closed", provider: "library", transportId: "library:0" },
    ]);
  });

  it("never shares callback transports between mock users", async () => {
    const userATransports: object[] = [];
    const userBTransports: object[] = [];
    const userA = new MockAuthOrchestrator("mock-user-a", {
      providerCallbackHandler: async (_provider, context) => {
        userATransports.push(context.transport);
      },
    });
    const userB = new MockAuthOrchestrator("mock-user-b", {
      providerCallbackHandler: async (_provider, context) => {
        userBTransports.push(context.transport);
      },
    });

    await Promise.all([
      userA.login({
        authSource: "smartid",
        mode: "official-browser",
        scopes: mockSmartIdScopes,
      }),
      userB.login({
        authSource: "smartid",
        mode: "official-browser",
        scopes: mockSmartIdScopes,
      }),
    ]);

    expect(userATransports).toHaveLength(2);
    expect(userBTransports).toHaveLength(2);
    expect(new Set([...userATransports, ...userBTransports]).size).toBe(4);
    expect(JSON.stringify([userA.getSnapshot(), userB.getSnapshot()])).not.toMatch(
      /transport|cookie|authorization/i,
    );
  });

  it.each([
    ["smartid", "official-browser", mockSmartIdScopes],
    ["smartid", "application-credentials", mockSmartIdScopes],
    ["library", "official-browser", mockLibraryScopes],
    ["library", "application-credentials", mockLibraryScopes],
  ] as const)("executes %s authentication through %s", async (authSource, mode, scopes) => {
    const auth = createMockAuthMatrix()["mock-user-a"];
    const credentials = new TransientCredentials({
      identifier: "mock-user",
      password: "mock-password",
    });

    const snapshot = await (mode === "official-browser"
      ? auth.login({ authSource, mode, scopes })
      : auth.login({
          authSource,
          mode,
          scopes,
          acquireCredentials: () => credentials,
        }));

    expect(snapshot.authSources).toEqual([
      expect.objectContaining({ source: authSource, inputMode: mode, status: "authenticated" }),
    ]);
    expect(snapshot.providers).not.toHaveLength(0);
    expect(credentials.released).toBe(mode === "application-credentials");
  });

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
    const callbackHandler = vi.fn(async () => undefined);
    const auth = new MockAuthOrchestrator("mock-user-a", {
      providerCallbackHandler: callbackHandler,
    });
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
    expect(callbackHandler).toHaveBeenCalledTimes(1);
    expect(callbackHandler).toHaveBeenCalledWith(
      "library",
      expect.objectContaining({ requestedScopes: ["library:loans.read"] }),
    );
    await expect(
      auth.login({
        authSource: "library",
        mode: "official-browser",
        scopes: ["usaint:profile.read"],
      }),
    ).rejects.toThrow("only request library scopes");
    expect(auth.getSnapshot()).toEqual(snapshot);
    expect(callbackHandler).toHaveBeenCalledTimes(1);
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

  it("treats logout for an absent source as an idempotent no-op", async () => {
    const auth = createMockAuthMatrix()["mock-user-a"];
    const publicSnapshot = auth.openPublicLibrary(mockPublicLibraryScopes);

    await expect(auth.logout("library")).resolves.toEqual(publicSnapshot);

    await auth.login({
      authSource: "smartid",
      mode: "official-browser",
      scopes: mockSmartIdScopes,
    });
    const loggedOut = await auth.logout("smartid");
    await expect(auth.logout("smartid")).resolves.toEqual(loggedOut);
  });

  it("discards all auth and provider state on close", async () => {
    const transportEvents: Array<{
      readonly type: "created" | "closed";
      readonly provider: ProviderId;
      readonly transportId: string;
    }> = [];
    const auth = new MockAuthOrchestrator("mock-user-a", {
      providerTransportHandler: (event) => transportEvents.push(event),
    });
    await loginAllProviders(auth);
    await auth.close();

    expect(auth.getSnapshot()).toEqual({ state: "closed", authSources: [], providers: [] });
    expect(transportEvents.filter(({ type }) => type === "created")).toHaveLength(3);
    expect(transportEvents.filter(({ type }) => type === "closed")).toHaveLength(3);
  });
});
