import {
  chromium,
  type Browser,
  type BrowserContext,
  type Download,
  type Page,
  type Request,
  type Route,
} from "playwright";

import type { AuthSourceId, Scope } from "@ssu-saintbridge/types";

import {
  AuthenticationExecutionError,
  type OfficialBrowserExecutionContext,
} from "./authentication-executor.js";
import type {
  BrowserNavigationPolicyRegistry,
  BrowserNavigationPolicy,
} from "./browser-navigation-policy.js";

export type ManagedBrowserViolation =
  "DOWNLOAD_NOT_ALLOWED" | "EXECUTION_ABORTED" | "POPUP_NOT_ALLOWED" | "RUNNER_CLOSED";

export class ManagedBrowserError extends Error {
  readonly authSource: AuthSourceId;
  readonly violation: ManagedBrowserViolation;

  constructor(authSource: AuthSourceId, violation: ManagedBrowserViolation) {
    super("The managed authentication browser rejected an unsafe browser action.");
    this.name = "ManagedBrowserError";
    this.authSource = authSource;
    this.violation = violation;
  }

  toJSON(): {
    readonly name: string;
    readonly authSource: AuthSourceId;
    readonly violation: ManagedBrowserViolation;
  } {
    return {
      name: this.name,
      authSource: this.authSource,
      violation: this.violation,
    };
  }
}

export interface ManagedBrowserTaskContext {
  readonly authSource: AuthSourceId;
  readonly inputMode: "official-browser";
  readonly requestedScopes: readonly Scope[];
  readonly signal: AbortSignal;
  readonly page: Page;
}

export type ManagedBrowserTask<Result> = (
  context: Readonly<ManagedBrowserTaskContext>,
) => Promise<Result>;

export type ManagedBrowserLaunch = (options: { readonly headless: false }) => Promise<Browser>;

export interface ManagedBrowserRunnerOptions {
  readonly navigationPolicies: BrowserNavigationPolicyRegistry;
  readonly launchBrowser?: ManagedBrowserLaunch;
}

const launchChromium: ManagedBrowserLaunch = (options) => chromium.launch(options);

const toSafeAbortError = (
  execution: OfficialBrowserExecutionContext,
  signal: AbortSignal,
): AuthenticationExecutionError | ManagedBrowserError =>
  signal.reason instanceof AuthenticationExecutionError ||
  signal.reason instanceof ManagedBrowserError
    ? signal.reason
    : new ManagedBrowserError(execution.authSource, "EXECUTION_ABORTED");

interface AbortWaiter {
  readonly promise: Promise<never>;
  dispose(): void;
}

const createAbortWaiter = (
  execution: OfficialBrowserExecutionContext,
  signal: AbortSignal,
): AbortWaiter => {
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject;
  });
  void promise.catch(() => undefined);
  const abort = (): void => rejectPromise(toSafeAbortError(execution, signal));
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return {
    promise,
    dispose: () => signal.removeEventListener("abort", abort),
  };
};

const closeBrowserResources = async (
  context: BrowserContext | undefined,
  browser: Browser,
): Promise<unknown | undefined> => {
  let firstError: unknown;
  if (context !== undefined) {
    try {
      await context.close({ reason: "SaintBridge authentication browser execution finished." });
    } catch (error: unknown) {
      firstError = error;
    }
  }
  try {
    await browser.close({ reason: "SaintBridge authentication browser execution finished." });
  } catch (error: unknown) {
    firstError ??= error;
  }
  return firstError;
};

const continueAllowedNavigation = async (
  route: Route,
  request: Request,
  policy: BrowserNavigationPolicy,
  primaryPage: Page | undefined,
  fail: (error: unknown) => void,
): Promise<void> => {
  if (!request.isNavigationRequest()) {
    await route.continue();
    return;
  }

  if (primaryPage !== undefined && request.frame().page() !== primaryPage) {
    fail(new ManagedBrowserError(policy.authSource, "POPUP_NOT_ALLOWED"));
    await route.abort("blockedbyclient");
    return;
  }

  try {
    policy.assertNavigation(request.url());
  } catch (error: unknown) {
    fail(error);
    await route.abort("blockedbyclient");
    return;
  }
  await route.continue();
};

export class ManagedBrowserRunner {
  readonly #activeExecutions = new Set<{
    readonly authSource: AuthSourceId;
    readonly controller: AbortController;
    readonly finished: Promise<void>;
  }>();
  #closed = false;
  #closePromise: Promise<void> | undefined;
  readonly #launchBrowser: ManagedBrowserLaunch;
  readonly #navigationPolicies: BrowserNavigationPolicyRegistry;

  constructor(options: ManagedBrowserRunnerOptions) {
    this.#launchBrowser = options.launchBrowser ?? launchChromium;
    this.#navigationPolicies = options.navigationPolicies;
  }

  async run<Result>(
    execution: OfficialBrowserExecutionContext,
    task: ManagedBrowserTask<Result>,
  ): Promise<Result> {
    if (this.#closed) {
      throw new ManagedBrowserError(execution.authSource, "RUNNER_CLOSED");
    }
    const runController = new AbortController();
    const forwardCancellation = (): void =>
      runController.abort(toSafeAbortError(execution, execution.signal));
    if (execution.signal.aborted) forwardCancellation();
    else execution.signal.addEventListener("abort", forwardCancellation, { once: true });
    const finished = Promise.withResolvers<void>();
    const activeExecution = {
      authSource: execution.authSource,
      controller: runController,
      finished: finished.promise,
    };
    this.#activeExecutions.add(activeExecution);

    const runExecution = Object.freeze({ ...execution, signal: runController.signal });
    const abortWaiter = createAbortWaiter(runExecution, runController.signal);
    let browser: Browser | undefined;
    let context: BrowserContext | undefined;
    let cleanupPromise: Promise<unknown | undefined> | undefined;
    const cleanup = (): Promise<unknown | undefined> => {
      cleanupPromise ??=
        browser === undefined
          ? Promise.resolve(undefined)
          : closeBrowserResources(context, browser);
      return cleanupPromise;
    };
    let outcome:
      | { readonly success: true; readonly value: Result }
      | { readonly success: false; readonly error: unknown };

    try {
      runController.signal.throwIfAborted();
      const policy = this.#navigationPolicies.get(runExecution.authSource);
      browser = await this.#launchBrowser(Object.freeze({ headless: false }));
      runController.signal.throwIfAborted();

      context = await browser.newContext({
        acceptDownloads: false,
        bypassCSP: false,
        ignoreHTTPSErrors: false,
        serviceWorkers: "block",
      });
      runController.signal.throwIfAborted();

      let failureRecorded = false;
      const failure = Promise.withResolvers<never>();
      const fail = (error: unknown): void => {
        if (failureRecorded) return;
        failureRecorded = true;
        failure.reject(error);
      };

      const page = await context.newPage();
      await context.route("**/*", (route, request) =>
        continueAllowedNavigation(route, request, policy, page, fail),
      );
      context.on("page", (openedPage) => {
        if (openedPage === page) return;
        fail(new ManagedBrowserError(runExecution.authSource, "POPUP_NOT_ALLOWED"));
        void openedPage.close().catch(() => undefined);
      });
      context.on("download", (download: Download) => {
        fail(new ManagedBrowserError(runExecution.authSource, "DOWNLOAD_NOT_ALLOWED"));
        void download.cancel().catch(() => undefined);
      });
      context.on("framenavigated", (frame) => {
        try {
          policy.assertNavigation(frame.url());
        } catch (error: unknown) {
          fail(error);
        }
      });

      await Promise.race([
        page.goto(policy.entryUrl.toString(), { waitUntil: "domcontentloaded" }),
        failure.promise,
        abortWaiter.promise,
      ]);
      runController.signal.throwIfAborted();

      const taskContext = Object.freeze({
        authSource: runExecution.authSource,
        inputMode: runExecution.inputMode,
        requestedScopes: runExecution.requestedScopes,
        signal: runController.signal,
        page,
      });
      outcome = {
        success: true,
        value: await Promise.race([task(taskContext), failure.promise, abortWaiter.promise]),
      };
    } catch (error: unknown) {
      outcome = { success: false, error };
    }

    const cleanupError = await cleanup();
    abortWaiter.dispose();
    execution.signal.removeEventListener("abort", forwardCancellation);
    this.#activeExecutions.delete(activeExecution);
    finished.resolve();
    if (!outcome.success) throw outcome.error;
    if (cleanupError !== undefined) throw cleanupError;
    return outcome.value;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    const activeExecutions = [...this.#activeExecutions];
    for (const execution of activeExecutions) {
      execution.controller.abort(new ManagedBrowserError(execution.authSource, "RUNNER_CLOSED"));
    }
    this.#closePromise = Promise.allSettled(activeExecutions.map(({ finished }) => finished)).then(
      () => undefined,
    );
    return this.#closePromise;
  }
}
