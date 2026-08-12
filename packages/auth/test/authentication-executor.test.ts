import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationExecutor,
  AuthenticationExecutionError,
  TransientCredentials,
  maximumAuthenticationExecutionTimeoutMs,
  type AuthenticationExecutionHandlers,
} from "../src/index.js";

const createHandlers = (): AuthenticationExecutionHandlers<string> => ({
  officialBrowser: vi.fn(async ({ authSource }) => `${authSource}:official-browser`),
  applicationCredentials: vi.fn(
    async ({ authSource }, { identifier }) => `${authSource}:application-credentials:${identifier}`,
  ),
});

describe("authentication executor", () => {
  it.each(["smartid", "library"] as const)(
    "dispatches %s official-browser authentication",
    async (authSource) => {
      const handlers = createHandlers();
      const executor = new AuthenticationExecutor(handlers);

      await expect(
        executor.execute({ authSource, mode: "official-browser", scopes: [] }),
      ).resolves.toBe(`${authSource}:official-browser`);
      expect(handlers.officialBrowser).toHaveBeenCalledOnce();
      expect(handlers.applicationCredentials).not.toHaveBeenCalled();
    },
  );

  it.each(["smartid", "library"] as const)(
    "dispatches %s application-credentials authentication",
    async (authSource) => {
      const handlers = createHandlers();
      const executor = new AuthenticationExecutor(handlers);
      const credentials = new TransientCredentials({
        identifier: `${authSource}-user`,
        password: "temporary-password",
      });

      await expect(
        executor.execute({
          authSource,
          mode: "application-credentials",
          scopes: [],
          acquireCredentials: () => credentials,
        }),
      ).resolves.toBe(`${authSource}:application-credentials:${authSource}-user`);
      expect(credentials.released).toBe(true);
      expect(handlers.officialBrowser).not.toHaveBeenCalled();
      expect(handlers.applicationCredentials).toHaveBeenCalledOnce();
    },
  );

  it("provides a frozen, non-sensitive execution context", async () => {
    const handlers = createHandlers();
    const executor = new AuthenticationExecutor(handlers);

    await executor.execute({
      authSource: "smartid",
      mode: "official-browser",
      scopes: ["usaint:profile.read"],
    });

    const context = vi.mocked(handlers.officialBrowser).mock.calls[0]?.[0];
    expect(context).toEqual({
      authSource: "smartid",
      inputMode: "official-browser",
      requestedScopes: ["usaint:profile.read"],
      signal: expect.any(AbortSignal),
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(JSON.stringify(context)).not.toContain("password");
  });

  it("releases credentials when the application handler fails", async () => {
    const credentials = new TransientCredentials({
      identifier: "student-id",
      password: "temporary-password",
    });
    const executor = new AuthenticationExecutor({
      officialBrowser: async () => "unused",
      applicationCredentials: async () => {
        throw new Error("adapter failed");
      },
    });

    await expect(
      executor.execute({
        authSource: "smartid",
        mode: "application-credentials",
        scopes: [],
        acquireCredentials: () => credentials,
      }),
    ).rejects.toThrow("adapter failed");
    expect(credentials.released).toBe(true);
  });

  it("rejects plain credential objects before invoking the handler", async () => {
    const handlers = createHandlers();
    const executor = new AuthenticationExecutor(handlers);

    await expect(
      executor.execute({
        authSource: "smartid",
        mode: "application-credentials",
        scopes: [],
        acquireCredentials: () =>
          ({ identifier: "student-id", password: "temporary-password" }) as never,
      }),
    ).rejects.toThrow("must return TransientCredentials");
    expect(handlers.applicationCredentials).not.toHaveBeenCalled();
  });

  it("releases acquired credentials when cancellation happens during acquisition", async () => {
    const handlers = createHandlers();
    const executor = new AuthenticationExecutor(handlers);
    const controller = new AbortController();
    const credentials = new TransientCredentials({
      identifier: "student-id",
      password: "temporary-password",
    });

    await expect(
      executor.execute(
        {
          authSource: "smartid",
          mode: "application-credentials",
          scopes: [],
          acquireCredentials: () => {
            controller.abort(new Error("cancelled"));
            return credentials;
          },
        },
        { signal: controller.signal },
      ),
    ).rejects.toThrow("cancelled");
    expect(credentials.released).toBe(true);
    expect(handlers.applicationCredentials).not.toHaveBeenCalled();
  });

  it("does not acquire credentials for an already cancelled execution", async () => {
    const handlers = createHandlers();
    const executor = new AuthenticationExecutor(handlers);
    const controller = new AbortController();
    const acquireCredentials = vi.fn(
      () => new TransientCredentials({ identifier: "student-id", password: "temporary-password" }),
    );
    controller.abort(new Error("cancelled before execution"));

    await expect(
      executor.execute(
        {
          authSource: "smartid",
          mode: "application-credentials",
          scopes: [],
          acquireCredentials,
        },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({
      authSource: "smartid",
      inputMode: "application-credentials",
      violation: "CANCELLED",
    });
    expect(acquireCredentials).not.toHaveBeenCalled();
  });

  it("signals a safe timeout to an official browser handler", async () => {
    const executor = new AuthenticationExecutor({
      officialBrowser: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
      applicationCredentials: async () => "unused",
    });

    const execution = executor.execute(
      { authSource: "smartid", mode: "official-browser", scopes: [] },
      { timeoutMs: 5 },
    );

    await expect(execution).rejects.toMatchObject({
      authSource: "smartid",
      inputMode: "official-browser",
      violation: "TIMED_OUT",
    });
  });

  it("releases credentials after a credential handler observes timeout", async () => {
    const credentials = new TransientCredentials({
      identifier: "student-id",
      password: "temporary-password",
    });
    const executor = new AuthenticationExecutor({
      officialBrowser: async () => "unused",
      applicationCredentials: ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });

    await expect(
      executor.execute(
        {
          authSource: "smartid",
          mode: "application-credentials",
          scopes: [],
          acquireCredentials: () => credentials,
        },
        { timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({ violation: "TIMED_OUT" });
    expect(credentials.released).toBe(true);
  });

  it("enforces timeout even when the credential handler ignores cancellation", async () => {
    const credentials = new TransientCredentials({
      identifier: "student-id",
      password: "temporary-password",
    });
    const executor = new AuthenticationExecutor({
      officialBrowser: async () => "unused",
      applicationCredentials: async () => new Promise<never>(() => undefined),
    });

    await expect(
      executor.execute(
        {
          authSource: "smartid",
          mode: "application-credentials",
          scopes: [],
          acquireCredentials: () => credentials,
        },
        { timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({ violation: "TIMED_OUT" });
    expect(credentials.released).toBe(true);
  });

  it("times out credential acquisition and releases credentials that arrive late", async () => {
    const credentials = new TransientCredentials({
      identifier: "student-id",
      password: "temporary-password",
    });
    const acquisition = Promise.withResolvers<TransientCredentials>();
    const handlers = createHandlers();
    const executor = new AuthenticationExecutor(handlers);

    const running = executor.execute(
      {
        authSource: "smartid",
        mode: "application-credentials",
        scopes: [],
        acquireCredentials: () => acquisition.promise,
      },
      { timeoutMs: 5 },
    );

    await expect(running).rejects.toMatchObject({ violation: "TIMED_OUT" });
    acquisition.resolve(credentials);
    await acquisition.promise;
    await Promise.resolve();
    expect(credentials.released).toBe(true);
    expect(handlers.applicationCredentials).not.toHaveBeenCalled();
  });

  it("does not serialize a caller-provided cancellation reason", async () => {
    const controller = new AbortController();
    const secret = ["do", "not", "serialize"].join("-");
    controller.abort(new Error(secret));
    const executor = new AuthenticationExecutor(createHandlers());

    let caught: unknown;
    try {
      await executor.execute(
        { authSource: "library", mode: "official-browser", scopes: [] },
        { signal: controller.signal },
      );
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AuthenticationExecutionError);
    expect(JSON.stringify(caught)).toBe(
      '{"name":"AuthenticationExecutionError","authSource":"library","inputMode":"official-browser","violation":"CANCELLED"}',
    );
    expect(JSON.stringify(caught)).not.toContain(secret);
  });

  it.each([0, 1.5, maximumAuthenticationExecutionTimeoutMs + 1])(
    "rejects an unsafe authentication timeout: %s",
    async (timeoutMs) => {
      const handlers = createHandlers();
      const executor = new AuthenticationExecutor(handlers);

      await expect(
        executor.execute(
          { authSource: "smartid", mode: "official-browser", scopes: [] },
          { timeoutMs },
        ),
      ).rejects.toBeInstanceOf(RangeError);
      expect(handlers.officialBrowser).not.toHaveBeenCalled();
    },
  );
});
