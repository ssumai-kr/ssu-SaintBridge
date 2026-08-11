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

import type { OfficialBrowserExecutionContext } from "./authentication-executor.js";
import type {
  BrowserNavigationPolicyRegistry,
  BrowserNavigationPolicy,
} from "./browser-navigation-policy.js";

export type ManagedBrowserViolation = "DOWNLOAD_NOT_ALLOWED" | "POPUP_NOT_ALLOWED";

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
    execution.signal.throwIfAborted();
    const policy = this.#navigationPolicies.get(execution.authSource);
    const browser = await this.#launchBrowser(Object.freeze({ headless: false }));
    let context: BrowserContext | undefined;
    let outcome:
      | { readonly success: true; readonly value: Result }
      | { readonly success: false; readonly error: unknown };

    try {
      execution.signal.throwIfAborted();
      context = await browser.newContext({
        acceptDownloads: false,
        bypassCSP: false,
        ignoreHTTPSErrors: false,
        serviceWorkers: "block",
      });

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
        fail(new ManagedBrowserError(execution.authSource, "POPUP_NOT_ALLOWED"));
        void openedPage.close().catch(() => undefined);
      });
      context.on("download", (download: Download) => {
        fail(new ManagedBrowserError(execution.authSource, "DOWNLOAD_NOT_ALLOWED"));
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
      ]);
      execution.signal.throwIfAborted();

      const taskContext = Object.freeze({
        authSource: execution.authSource,
        inputMode: execution.inputMode,
        requestedScopes: execution.requestedScopes,
        signal: execution.signal,
        page,
      });
      outcome = {
        success: true,
        value: await Promise.race([task(taskContext), failure.promise]),
      };
    } catch (error: unknown) {
      outcome = { success: false, error };
    }

    const cleanupError = await closeBrowserResources(context, browser);
    if (!outcome.success) throw outcome.error;
    if (cleanupError !== undefined) throw cleanupError;
    return outcome.value;
  }
}
