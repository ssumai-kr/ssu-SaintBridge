import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationExecutor,
  StatefulAuthenticationExecutor,
  TransientCredentials,
} from "../src/index.js";

describe("stateful authentication executor", () => {
  it("exposes authenticating while execution is pending and authenticated after success", async () => {
    const pending = Promise.withResolvers<string>();
    const stateful = new StatefulAuthenticationExecutor(
      new AuthenticationExecutor({
        officialBrowser: () => pending.promise,
        applicationCredentials: async () => "unused",
      }),
    );

    const execution = stateful.execute({
      authSource: "smartid",
      mode: "official-browser",
      scopes: ["usaint:profile.read"],
    });
    expect(stateful.getSnapshot()).toEqual([
      expect.objectContaining({
        source: "smartid",
        inputMode: "official-browser",
        status: "authenticating",
      }),
    ]);

    pending.resolve("authenticated");
    await expect(execution).resolves.toBe("authenticated");
    expect(stateful.getSnapshot()).toEqual([
      expect.objectContaining({ source: "smartid", status: "authenticated" }),
    ]);
  });

  it("uses the same state lifecycle for application credentials", async () => {
    const credentials = new TransientCredentials({
      identifier: "student-id",
      password: "temporary-password",
    });
    const stateful = new StatefulAuthenticationExecutor(
      new AuthenticationExecutor({
        officialBrowser: async () => "unused",
        applicationCredentials: async (_context, values) => values.identifier,
      }),
    );

    await expect(
      stateful.execute({
        authSource: "library",
        mode: "application-credentials",
        scopes: ["library:loans.read"],
        acquireCredentials: () => credentials,
      }),
    ).resolves.toBe("student-id");

    expect(credentials.released).toBe(true);
    expect(stateful.getSnapshot()).toEqual([
      {
        source: "library",
        inputMode: "application-credentials",
        status: "authenticated",
        expiresAt: null,
      },
    ]);
    expect(JSON.stringify(stateful.getSnapshot())).not.toMatch(/student-id|temporary-password/);
  });

  it("rolls an initial authentication failure back to absent", async () => {
    const failure = new Error("authentication adapter failed");
    const stateful = new StatefulAuthenticationExecutor(
      new AuthenticationExecutor({
        officialBrowser: async () => {
          throw failure;
        },
        applicationCredentials: async () => "unused",
      }),
    );

    await expect(
      stateful.execute({ authSource: "smartid", mode: "official-browser", scopes: [] }),
    ).rejects.toBe(failure);
    expect(stateful.getSnapshot()).toEqual([]);
  });

  it("restores the previous authenticated state when reauthentication fails", async () => {
    const failure = new Error("reauthentication failed");
    const officialBrowser = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce("initial success")
      .mockRejectedValueOnce(failure);
    const stateful = new StatefulAuthenticationExecutor(
      new AuthenticationExecutor({
        officialBrowser,
        applicationCredentials: async () => "unused",
      }),
    );

    await stateful.execute({ authSource: "smartid", mode: "official-browser", scopes: [] });
    const previous = stateful.getSnapshot()[0];

    await expect(
      stateful.execute({ authSource: "smartid", mode: "official-browser", scopes: [] }),
    ).rejects.toBe(failure);
    expect(stateful.getSnapshot()[0]).toBe(previous);
  });

  it("rolls timeout and cancellation back without leaving authenticating state", async () => {
    const controller = new AbortController();
    controller.abort(new Error("caller reason must not escape"));
    const stateful = new StatefulAuthenticationExecutor(
      new AuthenticationExecutor({
        officialBrowser: async () => "unused",
        applicationCredentials: async () => new Promise<never>(() => undefined),
      }),
    );

    await expect(
      stateful.execute(
        {
          authSource: "smartid",
          mode: "application-credentials",
          scopes: [],
          acquireCredentials: () =>
            new TransientCredentials({ identifier: "student-id", password: "password" }),
        },
        { timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({ violation: "TIMED_OUT" });
    expect(stateful.getSnapshot()).toEqual([]);

    await expect(
      stateful.execute(
        { authSource: "library", mode: "official-browser", scopes: [] },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ violation: "CANCELLED" });
    expect(stateful.getSnapshot()).toEqual([]);
  });

  it("does not mutate state for an invalid login request", async () => {
    const officialBrowser = vi.fn(async () => "unused");
    const stateful = new StatefulAuthenticationExecutor(
      new AuthenticationExecutor({
        officialBrowser,
        applicationCredentials: async () => "unused",
      }),
    );

    await expect(
      stateful.execute({
        authSource: "smartid",
        mode: "embedded-form",
        scopes: [],
      } as never),
    ).rejects.toThrow("not supported");
    expect(stateful.getSnapshot()).toEqual([]);
    expect(officialBrowser).not.toHaveBeenCalled();
  });

  it("rejects overlapping execution for one source while allowing the other source", async () => {
    const smartidPending = Promise.withResolvers<string>();
    const libraryPending = Promise.withResolvers<string>();
    const stateful = new StatefulAuthenticationExecutor(
      new AuthenticationExecutor({
        officialBrowser: ({ authSource }) =>
          authSource === "smartid" ? smartidPending.promise : libraryPending.promise,
        applicationCredentials: async () => "unused",
      }),
    );

    const smartid = stateful.execute({
      authSource: "smartid",
      mode: "official-browser",
      scopes: [],
    });
    const library = stateful.execute({
      authSource: "library",
      mode: "official-browser",
      scopes: [],
    });
    await expect(
      stateful.execute({ authSource: "smartid", mode: "official-browser", scopes: [] }),
    ).rejects.toMatchObject({ violation: "ATTEMPT_ALREADY_ACTIVE" });

    libraryPending.resolve("library success");
    await expect(library).resolves.toBe("library success");
    expect(stateful.getSnapshot().map(({ source, status }) => [source, status])).toEqual([
      ["smartid", "authenticating"],
      ["library", "authenticated"],
    ]);

    smartidPending.resolve("smartid success");
    await expect(smartid).resolves.toBe("smartid success");
  });

  it("rejects success from an attempt removed while execution was pending", async () => {
    const pending = Promise.withResolvers<string>();
    const stateful = new StatefulAuthenticationExecutor(
      new AuthenticationExecutor({
        officialBrowser: () => pending.promise,
        applicationCredentials: async () => "unused",
      }),
    );
    const execution = stateful.execute({
      authSource: "smartid",
      mode: "official-browser",
      scopes: [],
    });

    stateful.remove("smartid");
    pending.resolve("late success");

    await expect(execution).rejects.toMatchObject({ violation: "STALE_ATTEMPT" });
    expect(stateful.getSnapshot()).toEqual([]);
  });

  it("preserves the original authentication error when rollback is already stale", async () => {
    const pending = Promise.withResolvers<string>();
    const originalError = new Error("primary authentication failure");
    const stateful = new StatefulAuthenticationExecutor(
      new AuthenticationExecutor({
        officialBrowser: () => pending.promise,
        applicationCredentials: async () => "unused",
      }),
    );
    const execution = stateful.execute({
      authSource: "library",
      mode: "official-browser",
      scopes: [],
    });

    stateful.remove("library");
    pending.reject(originalError);

    await expect(execution).rejects.toBe(originalError);
    expect(stateful.getSnapshot()).toEqual([]);
  });

  it("keeps a replacement attempt when the removed attempt succeeds late", async () => {
    const oldPending = Promise.withResolvers<string>();
    const currentPending = Promise.withResolvers<string>();
    const officialBrowser = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(oldPending.promise)
      .mockReturnValueOnce(currentPending.promise);
    const stateful = new StatefulAuthenticationExecutor(
      new AuthenticationExecutor({
        officialBrowser,
        applicationCredentials: async () => "unused",
      }),
    );

    const oldExecution = stateful.execute({
      authSource: "smartid",
      mode: "official-browser",
      scopes: [],
    });
    stateful.remove("smartid");
    const currentExecution = stateful.execute({
      authSource: "smartid",
      mode: "official-browser",
      scopes: [],
    });

    oldPending.resolve("late success");
    await expect(oldExecution).rejects.toMatchObject({ violation: "STALE_ATTEMPT" });
    expect(stateful.getSnapshot()[0]).toMatchObject({ status: "authenticating" });

    currentPending.resolve("current success");
    await expect(currentExecution).resolves.toBe("current success");
    expect(stateful.getSnapshot()[0]).toMatchObject({ status: "authenticated" });
  });

  it("keeps a replacement attempt when the removed attempt fails late", async () => {
    const oldPending = Promise.withResolvers<string>();
    const currentPending = Promise.withResolvers<string>();
    const oldFailure = new Error("late failure from removed attempt");
    const officialBrowser = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(oldPending.promise)
      .mockReturnValueOnce(currentPending.promise);
    const stateful = new StatefulAuthenticationExecutor(
      new AuthenticationExecutor({
        officialBrowser,
        applicationCredentials: async () => "unused",
      }),
    );

    const oldExecution = stateful.execute({
      authSource: "library",
      mode: "official-browser",
      scopes: [],
    });
    stateful.remove("library");
    const currentExecution = stateful.execute({
      authSource: "library",
      mode: "official-browser",
      scopes: [],
    });

    oldPending.reject(oldFailure);
    await expect(oldExecution).rejects.toBe(oldFailure);
    expect(stateful.getSnapshot()[0]).toMatchObject({ status: "authenticating" });

    currentPending.resolve("current success");
    await expect(currentExecution).resolves.toBe("current success");
    expect(stateful.getSnapshot()[0]).toMatchObject({ status: "authenticated" });
  });

  it("delegates explicit expiration to the state machine", async () => {
    const stateful = new StatefulAuthenticationExecutor(
      new AuthenticationExecutor({
        officialBrowser: async () => "authenticated",
        applicationCredentials: async () => "unused",
      }),
    );
    await stateful.execute({ authSource: "smartid", mode: "official-browser", scopes: [] });

    expect(stateful.expire("smartid")).toMatchObject({ status: "expired" });
    expect(stateful.getSnapshot()[0]).toMatchObject({ status: "expired" });
  });
});
