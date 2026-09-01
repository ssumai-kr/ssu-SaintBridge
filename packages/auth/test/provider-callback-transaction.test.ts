import type { HttpSession } from "@ssu-saintbridge/transport";
import type { ProviderSession } from "@ssu-saintbridge/types";
import { describe, expect, it } from "vitest";

import {
  ProviderCallbackContractError,
  getProviderCallbackTransactionTarget,
  isProviderCallbackBindingAllowed,
  providerCallbackBindingRules,
  providerCallbackTransactionRules,
  type ProviderCallbackContext,
  type StageProviderCallbackResultOptions,
} from "../src/index.js";

describe("provider callback contract", () => {
  it("defines the complete authentication-to-provider binding matrix", () => {
    expect(providerCallbackBindingRules).toEqual([
      { authSource: "smartid", provider: "usaint" },
      { authSource: "smartid", provider: "lms" },
      { authSource: "smartid", provider: "library" },
      { authSource: "library", provider: "library" },
    ]);

    expect(isProviderCallbackBindingAllowed("smartid", "usaint")).toBe(true);
    expect(isProviderCallbackBindingAllowed("smartid", "lms")).toBe(true);
    expect(isProviderCallbackBindingAllowed("smartid", "library")).toBe(true);
    expect(isProviderCallbackBindingAllowed("library", "library")).toBe(true);
    expect(isProviderCallbackBindingAllowed("library", "usaint")).toBe(false);
    expect(isProviderCallbackBindingAllowed("library", "lms")).toBe(false);
  });

  it("allows staging only before one terminal transaction outcome", () => {
    expect(providerCallbackTransactionRules).toEqual([
      { from: "staging", event: "stage", to: "staging" },
      { from: "staging", event: "commit", to: "committed" },
      { from: "staging", event: "rollback", to: "rolled-back" },
    ]);
    expect(getProviderCallbackTransactionTarget("committed", "stage")).toBeUndefined();
    expect(getProviderCallbackTransactionTarget("committed", "rollback")).toBeUndefined();
    expect(getProviderCallbackTransactionTarget("rolled-back", "stage")).toBeUndefined();
    expect(getProviderCallbackTransactionTarget("rolled-back", "commit")).toBeUndefined();
  });

  it("publishes immutable binding and transaction metadata", () => {
    expect(Object.isFrozen(providerCallbackBindingRules)).toBe(true);
    expect(providerCallbackBindingRules.every((rule) => Object.isFrozen(rule))).toBe(true);
    expect(Object.isFrozen(providerCallbackTransactionRules)).toBe(true);
    expect(providerCallbackTransactionRules.every((rule) => Object.isFrozen(rule))).toBe(true);
  });

  it("requires cancellation and one provider-owned transport in callback staging", () => {
    const signal = new AbortController().signal;
    const transport = {} as HttpSession;
    const result = {} as ProviderSession;
    const context: ProviderCallbackContext = {
      authSource: "smartid",
      inputMode: "official-browser",
      requestedScopes: ["lms:courses.read"],
      transport,
      signal,
    };
    const staged: StageProviderCallbackResultOptions = {
      expectedProvider: "lms",
      requestedScopes: context.requestedScopes,
      result,
      transport: context.transport,
    };

    expect(context.signal).toBe(signal);
    expect(staged.transport).toBe(transport);
    expect(staged.requestedScopes).toEqual(["lms:courses.read"]);
  });

  it("serializes contract failures without callback results or transport details", () => {
    const error = new ProviderCallbackContractError("RESULT_AUTH_SOURCE_MISMATCH", {
      authSource: "smartid",
      provider: "lms",
    });

    expect(error.message).toBe(
      "The callback result is bound to a different authentication source.",
    );
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      name: "ProviderCallbackContractError",
      violation: "RESULT_AUTH_SOURCE_MISMATCH",
      authSource: "smartid",
      provider: "lms",
    });
    expect(JSON.stringify(error)).not.toContain("transport");
    expect(JSON.stringify(error)).not.toContain("result");
  });
});
