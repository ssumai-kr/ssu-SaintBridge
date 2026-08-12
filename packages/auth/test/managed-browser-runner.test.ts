import type { Browser, BrowserContext, Download, Frame, Page, Request, Route } from "playwright";
import { describe, expect, it, vi } from "vitest";

import {
  AuthenticationExecutor,
  BrowserNavigationPolicyError,
  BrowserNavigationPolicyRegistry,
  ManagedBrowserError,
  ManagedBrowserRunner,
  type ManagedBrowserLaunch,
  type OfficialBrowserExecutionContext,
} from "../src/index.js";

const policies = new BrowserNavigationPolicyRegistry([
  {
    authSource: "smartid",
    entryUrl: "https://login.smartid.example.invalid/start",
    allowedHosts: ["login.smartid.example.invalid", "callback.smartid.example.invalid"],
  },
  {
    authSource: "library",
    entryUrl: "https://login.library.example.invalid/start",
    allowedHosts: ["login.library.example.invalid"],
  },
]);

const execution = (
  authSource: "smartid" | "library" = "smartid",
  signal = new AbortController().signal,
): OfficialBrowserExecutionContext => ({
  authSource,
  inputMode: "official-browser",
  requestedScopes: [],
  signal,
});

type ContextEvent = "download" | "framenavigated" | "page";
type ContextListener = (...values: never[]) => unknown;

interface BrowserHarness {
  readonly abort: ReturnType<typeof vi.fn>;
  readonly browserClose: ReturnType<typeof vi.fn>;
  readonly contextClose: ReturnType<typeof vi.fn>;
  readonly continueRoute: ReturnType<typeof vi.fn>;
  readonly launchBrowser: ManagedBrowserLaunch;
  readonly launchMock: ReturnType<typeof vi.fn>;
  readonly newContext: ReturnType<typeof vi.fn>;
  readonly page: Page;
  emit(event: ContextEvent, value: unknown): void;
}

const createBrowserHarness = (): BrowserHarness => {
  const listeners = new Map<ContextEvent, ContextListener[]>();
  let routeHandler: ((route: Route, request: Request) => Promise<unknown> | unknown) | undefined;
  let currentUrl = "about:blank";

  const continueRoute = vi.fn(async () => undefined);
  const abort = vi.fn(async () => undefined);
  const primaryFrame = {
    page: () => page,
    parentFrame: () => null,
    url: () => currentUrl,
  } as unknown as Frame;
  const createRequest = (url: string, frame = primaryFrame): Request =>
    ({
      frame: () => frame,
      isNavigationRequest: () => true,
      url: () => url,
    }) as unknown as Request;
  const goto = vi.fn(async (url: string) => {
    if (routeHandler === undefined) throw new Error("Route handler was not installed.");
    abort.mockClear();
    await routeHandler({ abort, continue: continueRoute } as unknown as Route, createRequest(url));
    if (abort.mock.calls.length > 0) return new Promise<never>(() => undefined);
    currentUrl = url;
    for (const listener of listeners.get("framenavigated") ?? []) {
      listener(primaryFrame as never);
    }
    return null;
  });
  const page = {
    close: vi.fn(async () => undefined),
    goto,
  } as unknown as Page;
  const contextClose = vi.fn(async () => undefined);
  const context = {
    close: contextClose,
    newPage: vi.fn(async () => page),
    on: vi.fn((event: ContextEvent, listener: ContextListener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return context;
    }),
    route: vi.fn(
      async (
        _url: string,
        handler: (route: Route, request: Request) => Promise<unknown> | unknown,
      ) => {
        routeHandler = handler;
      },
    ),
  } as unknown as BrowserContext;
  const newContext = vi.fn(async () => context);
  const browserClose = vi.fn(async () => undefined);
  const browser = { close: browserClose, newContext } as unknown as Browser;
  const launchMock = vi.fn(async () => browser);

  return {
    abort,
    browserClose,
    contextClose,
    continueRoute,
    launchBrowser: launchMock,
    launchMock,
    newContext,
    page,
    emit: (event, value) => {
      for (const listener of listeners.get(event) ?? []) listener(value as never);
    },
  };
};

describe("managed browser runner", () => {
  it("launches a visible browser with an isolated non-persistent context", async () => {
    const harness = createBrowserHarness();
    const runner = new ManagedBrowserRunner({
      navigationPolicies: policies,
      launchBrowser: harness.launchBrowser,
    });

    await expect(
      runner.run(execution(), async (context) => {
        expect(Object.isFrozen(context)).toBe(true);
        expect(context).toMatchObject({
          authSource: "smartid",
          inputMode: "official-browser",
          page: harness.page,
        });
        return "completed";
      }),
    ).resolves.toBe("completed");
    expect(harness.launchMock).toHaveBeenCalledWith({ headless: false });
    expect(harness.newContext).toHaveBeenCalledWith({
      acceptDownloads: false,
      bypassCSP: false,
      ignoreHTTPSErrors: false,
      serviceWorkers: "block",
    });
    expect(harness.contextClose).toHaveBeenCalledOnce();
    expect(harness.browserClose).toHaveBeenCalledOnce();
  });

  it("uses the entry URL belonging to the requested authentication source", async () => {
    const harness = createBrowserHarness();
    const runner = new ManagedBrowserRunner({
      navigationPolicies: policies,
      launchBrowser: harness.launchBrowser,
    });

    await runner.run(execution("library"), async ({ page }) => page.url?.() ?? "completed");

    expect(harness.page.goto).toHaveBeenCalledWith("https://login.library.example.invalid/start", {
      waitUntil: "domcontentloaded",
    });
  });

  it("fails closed when the primary page navigates outside its source policy", async () => {
    const harness = createBrowserHarness();
    const runner = new ManagedBrowserRunner({
      navigationPolicies: policies,
      launchBrowser: harness.launchBrowser,
    });

    await expect(
      runner.run(execution(), async ({ page }) => {
        await page.goto("https://login.library.example.invalid/account");
        return "unreachable";
      }),
    ).rejects.toMatchObject({ authSource: "smartid", violation: "HOST_NOT_ALLOWED" });
    expect(harness.contextClose).toHaveBeenCalledOnce();
    expect(harness.browserClose).toHaveBeenCalledOnce();
  });

  it("rejects and closes popup pages", async () => {
    const harness = createBrowserHarness();
    const runner = new ManagedBrowserRunner({
      navigationPolicies: policies,
      launchBrowser: harness.launchBrowser,
    });
    const popup = { close: vi.fn(async () => undefined) } as unknown as Page;

    await expect(
      runner.run(execution(), async () => {
        harness.emit("page", popup);
        return new Promise<never>(() => undefined);
      }),
    ).rejects.toBeInstanceOf(ManagedBrowserError);
    expect(popup.close).toHaveBeenCalledOnce();
  });

  it("rejects and cancels downloads", async () => {
    const harness = createBrowserHarness();
    const runner = new ManagedBrowserRunner({
      navigationPolicies: policies,
      launchBrowser: harness.launchBrowser,
    });
    const download = { cancel: vi.fn(async () => undefined) } as unknown as Download;

    await expect(
      runner.run(execution(), async () => {
        harness.emit("download", download);
        return new Promise<never>(() => undefined);
      }),
    ).rejects.toMatchObject({ authSource: "smartid", violation: "DOWNLOAD_NOT_ALLOWED" });
    expect(download.cancel).toHaveBeenCalledOnce();
  });

  it("closes the isolated context and browser when the task fails", async () => {
    const harness = createBrowserHarness();
    const runner = new ManagedBrowserRunner({
      navigationPolicies: policies,
      launchBrowser: harness.launchBrowser,
    });

    await expect(
      runner.run(execution(), async () => {
        throw new Error("login adapter failed");
      }),
    ).rejects.toThrow("login adapter failed");
    expect(harness.contextClose).toHaveBeenCalledOnce();
    expect(harness.browserClose).toHaveBeenCalledOnce();
  });

  it("does not launch a browser for an already cancelled execution", async () => {
    const harness = createBrowserHarness();
    const runner = new ManagedBrowserRunner({
      navigationPolicies: policies,
      launchBrowser: harness.launchBrowser,
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled before launch"));

    await expect(
      runner.run(execution("smartid", controller.signal), async () => "unused"),
    ).rejects.toMatchObject({ authSource: "smartid", violation: "EXECUTION_ABORTED" });
    expect(harness.launchMock).not.toHaveBeenCalled();
  });

  it("closes browser resources when execution is cancelled during a task", async () => {
    const harness = createBrowserHarness();
    const runner = new ManagedBrowserRunner({
      navigationPolicies: policies,
      launchBrowser: harness.launchBrowser,
    });
    const controller = new AbortController();
    const taskStarted = Promise.withResolvers<void>();

    const running = runner.run(execution("smartid", controller.signal), async () => {
      taskStarted.resolve();
      return new Promise<never>(() => undefined);
    });
    await taskStarted.promise;
    controller.abort(new Error("private cancellation detail"));

    await expect(running).rejects.toMatchObject({
      authSource: "smartid",
      violation: "EXECUTION_ABORTED",
    });
    expect(harness.contextClose).toHaveBeenCalledOnce();
    expect(harness.browserClose).toHaveBeenCalledOnce();
  });

  it("connects executor timeout to browser cleanup without changing the timeout error", async () => {
    const harness = createBrowserHarness();
    const runner = new ManagedBrowserRunner({
      navigationPolicies: policies,
      launchBrowser: harness.launchBrowser,
    });
    const executor = new AuthenticationExecutor({
      officialBrowser: (context) =>
        runner.run(context, async () => new Promise<never>(() => undefined)),
      applicationCredentials: async () => "unused",
    });

    await expect(
      executor.execute(
        { authSource: "smartid", mode: "official-browser", scopes: [] },
        { timeoutMs: 5 },
      ),
    ).rejects.toMatchObject({
      authSource: "smartid",
      inputMode: "official-browser",
      violation: "TIMED_OUT",
    });
    expect(harness.contextClose).toHaveBeenCalledOnce();
    expect(harness.browserClose).toHaveBeenCalledOnce();
  });

  it("preserves the task failure when both cleanup operations fail", async () => {
    const harness = createBrowserHarness();
    harness.contextClose.mockRejectedValueOnce(new Error("context cleanup failed"));
    harness.browserClose.mockRejectedValueOnce(new Error("browser cleanup failed"));
    const runner = new ManagedBrowserRunner({
      navigationPolicies: policies,
      launchBrowser: harness.launchBrowser,
    });

    await expect(
      runner.run(execution(), async () => {
        throw new Error("original adapter failure");
      }),
    ).rejects.toThrow("original adapter failure");
    expect(harness.contextClose).toHaveBeenCalledOnce();
    expect(harness.browserClose).toHaveBeenCalledOnce();
  });

  it("surfaces cleanup failure after an otherwise successful task", async () => {
    const harness = createBrowserHarness();
    harness.contextClose.mockRejectedValueOnce(new Error("context cleanup failed"));
    const runner = new ManagedBrowserRunner({
      navigationPolicies: policies,
      launchBrowser: harness.launchBrowser,
    });

    await expect(runner.run(execution(), async () => "completed")).rejects.toThrow(
      "context cleanup failed",
    );
    expect(harness.browserClose).toHaveBeenCalledOnce();
  });

  it("idempotently closes active executions and rejects future runs", async () => {
    const harness = createBrowserHarness();
    const runner = new ManagedBrowserRunner({
      navigationPolicies: policies,
      launchBrowser: harness.launchBrowser,
    });
    const taskStarted = Promise.withResolvers<void>();
    const running = runner.run(execution("library"), async () => {
      taskStarted.resolve();
      return new Promise<never>(() => undefined);
    });
    await taskStarted.promise;

    const firstClose = runner.close();
    const secondClose = runner.close();
    expect(secondClose).toBe(firstClose);
    await Promise.all([firstClose, secondClose]);

    await expect(running).rejects.toMatchObject({
      authSource: "library",
      violation: "RUNNER_CLOSED",
    });
    expect(harness.contextClose).toHaveBeenCalledOnce();
    expect(harness.browserClose).toHaveBeenCalledOnce();
    await expect(runner.run(execution("smartid"), async () => "unused")).rejects.toMatchObject({
      authSource: "smartid",
      violation: "RUNNER_CLOSED",
    });
    expect(harness.launchMock).toHaveBeenCalledOnce();
  });

  it("keeps policy and browser errors free of navigated URLs", () => {
    const browserError = new ManagedBrowserError("smartid", "POPUP_NOT_ALLOWED");
    const policyError = (() => {
      try {
        policies
          .get("smartid")
          .assertNavigation("https://mock-user:mock-password@login.smartid.example.invalid");
      } catch (error: unknown) {
        return error;
      }
    })();

    expect(JSON.stringify(browserError)).toBe(
      '{"name":"ManagedBrowserError","authSource":"smartid","violation":"POPUP_NOT_ALLOWED"}',
    );
    expect(policyError).toBeInstanceOf(BrowserNavigationPolicyError);
    expect(JSON.stringify(policyError)).not.toContain("mock-password");
  });
});
