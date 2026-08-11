import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationExecutor,
  TransientCredentials,
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
    ).rejects.toThrow("cancelled before execution");
    expect(acquireCredentials).not.toHaveBeenCalled();
  });
});
