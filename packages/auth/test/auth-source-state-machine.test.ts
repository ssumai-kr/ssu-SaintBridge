import { describe, expect, it } from "vitest";

import {
  AuthSourceTransitionError,
  authSourceStableStates,
  authSourceTransitionRules,
  getAuthSourceTransitionTarget,
} from "../src/index.js";

describe("authentication source state-machine contract", () => {
  it("defines the complete AUTH-02 transition table", () => {
    expect(authSourceTransitionRules).toEqual([
      { from: "absent", event: "begin", to: "authenticating" },
      { from: "authenticating", event: "complete", to: "authenticated" },
      { from: "authenticating", event: "rollback", to: "previous" },
      { from: "authenticating", event: "remove", to: "absent" },
      { from: "authenticated", event: "begin", to: "authenticating" },
      { from: "authenticated", event: "expire", to: "expired" },
      { from: "authenticated", event: "remove", to: "absent" },
      { from: "expired", event: "begin", to: "authenticating" },
      { from: "expired", event: "remove", to: "absent" },
    ]);
  });

  it("keeps the rollback destination dependent on the previous stable state", () => {
    expect(getAuthSourceTransitionTarget("authenticating", "rollback")).toBe("previous");
    expect(authSourceStableStates).toEqual(["absent", "authenticated", "expired"]);
  });

  it("rejects transitions outside the contract", () => {
    expect(getAuthSourceTransitionTarget("absent", "complete")).toBeUndefined();
    expect(getAuthSourceTransitionTarget("expired", "expire")).toBeUndefined();
    expect(getAuthSourceTransitionTarget("authenticating", "begin")).toBeUndefined();
  });

  it("publishes immutable transition metadata", () => {
    expect(Object.isFrozen(authSourceTransitionRules)).toBe(true);
    expect(authSourceTransitionRules.every((rule) => Object.isFrozen(rule))).toBe(true);
  });

  it("serializes transition errors without runtime or credential data", () => {
    const error = new AuthSourceTransitionError("smartid", "complete", "STALE_ATTEMPT");

    expect(error.message).toBe("The authentication attempt no longer owns the source transition.");
    expect(JSON.stringify(error)).toBe(
      '{"name":"AuthSourceTransitionError","source":"smartid","event":"complete","violation":"STALE_ATTEMPT"}',
    );
  });
});
