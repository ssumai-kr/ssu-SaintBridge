import { describe, expect, it } from "vitest";

import {
  AuthSourceTransitionError,
  InMemoryAuthSourceStateMachine,
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

describe("in-memory authentication source state machine", () => {
  it("moves an initial attempt from absent through authenticating to authenticated", () => {
    const machine = new InMemoryAuthSourceStateMachine();
    const attempt = machine.begin({ source: "smartid", inputMode: "official-browser" });

    expect(machine.getSnapshot()).toEqual([
      {
        source: "smartid",
        inputMode: "official-browser",
        status: "authenticating",
        expiresAt: null,
      },
    ]);

    expect(machine.complete(attempt, { expiresAt: "2026-08-14T12:00:00+09:00" })).toEqual({
      source: "smartid",
      inputMode: "official-browser",
      status: "authenticated",
      expiresAt: "2026-08-14T12:00:00+09:00",
    });
  });

  it("rolls an initial failed attempt back to absent", () => {
    const machine = new InMemoryAuthSourceStateMachine();
    const attempt = machine.begin({
      source: "library",
      inputMode: "application-credentials",
    });

    expect(machine.rollback(attempt)).toBeUndefined();
    expect(machine.getSnapshot()).toEqual([]);
  });

  it("restores the complete previous session when reauthentication rolls back", () => {
    const machine = new InMemoryAuthSourceStateMachine();
    const initial = machine.begin({ source: "smartid", inputMode: "official-browser" });
    const previous = machine.complete(initial, { expiresAt: "2026-08-14T12:00:00+09:00" });
    const retry = machine.begin({ source: "smartid", inputMode: "application-credentials" });

    expect(machine.getSnapshot()[0]).toMatchObject({
      inputMode: "application-credentials",
      status: "authenticating",
    });
    expect(machine.rollback(retry)).toBe(previous);
    expect(machine.getSnapshot()).toEqual([previous]);
  });

  it("expires and then reauthenticates one source", () => {
    const machine = new InMemoryAuthSourceStateMachine();
    const initial = machine.begin({ source: "smartid", inputMode: "official-browser" });
    machine.complete(initial);

    expect(machine.expire("smartid")).toMatchObject({ status: "expired" });
    const retry = machine.begin({ source: "smartid", inputMode: "application-credentials" });
    expect(machine.complete(retry)).toMatchObject({
      inputMode: "application-credentials",
      status: "authenticated",
    });
  });

  it("keeps SmartID and Library attempts independent and deterministically ordered", () => {
    const machine = new InMemoryAuthSourceStateMachine();
    const library = machine.begin({ source: "library", inputMode: "official-browser" });
    const smartid = machine.begin({
      source: "smartid",
      inputMode: "application-credentials",
    });

    machine.complete(library);
    expect(machine.getSnapshot().map(({ source, status }) => [source, status])).toEqual([
      ["smartid", "authenticating"],
      ["library", "authenticated"],
    ]);

    machine.rollback(smartid);
    expect(machine.getSnapshot()).toEqual([
      expect.objectContaining({ source: "library", status: "authenticated" }),
    ]);
  });

  it("rejects overlapping attempts for the same source", () => {
    const machine = new InMemoryAuthSourceStateMachine();
    machine.begin({ source: "smartid", inputMode: "official-browser" });

    expect(() =>
      machine.begin({ source: "smartid", inputMode: "application-credentials" }),
    ).toThrowError(
      expect.objectContaining({
        violation: "ATTEMPT_ALREADY_ACTIVE",
      }),
    );
  });

  it("rejects a late completion after removal as stale", () => {
    const machine = new InMemoryAuthSourceStateMachine();
    const attempt = machine.begin({ source: "library", inputMode: "official-browser" });
    machine.remove("library");

    expect(() => machine.complete(attempt)).toThrowError(
      expect.objectContaining({ violation: "STALE_ATTEMPT" }),
    );
    expect(machine.getSnapshot()).toEqual([]);
  });

  it("prevents an old token from overwriting a newer attempt", () => {
    const machine = new InMemoryAuthSourceStateMachine();
    const oldAttempt = machine.begin({ source: "smartid", inputMode: "official-browser" });
    machine.complete(oldAttempt);
    const currentAttempt = machine.begin({
      source: "smartid",
      inputMode: "application-credentials",
    });

    expect(() => machine.complete(oldAttempt)).toThrowError(
      expect.objectContaining({ violation: "STALE_ATTEMPT" }),
    );
    expect(machine.getSnapshot()).toEqual([
      expect.objectContaining({
        source: "smartid",
        inputMode: "application-credentials",
        status: "authenticating",
      }),
    ]);

    machine.complete(currentAttempt);
    expect(machine.getSnapshot()[0]).toMatchObject({ status: "authenticated" });
  });

  it("does not allow a completed attempt to roll back its stable state", () => {
    const machine = new InMemoryAuthSourceStateMachine();
    const attempt = machine.begin({ source: "library", inputMode: "official-browser" });
    const completed = machine.complete(attempt);

    expect(() => machine.rollback(attempt)).toThrowError(
      expect.objectContaining({ violation: "STALE_ATTEMPT" }),
    );
    expect(machine.getSnapshot()).toEqual([completed]);
  });

  it("rejects attempts owned by another state machine", () => {
    const owner = new InMemoryAuthSourceStateMachine();
    const other = new InMemoryAuthSourceStateMachine();
    const attempt = owner.begin({ source: "smartid", inputMode: "official-browser" });

    expect(() => other.complete(attempt)).toThrowError(
      expect.objectContaining({ violation: "ATTEMPT_NOT_ACTIVE" }),
    );
  });

  it("enforces invalid transitions and validates expiration timestamps", () => {
    const machine = new InMemoryAuthSourceStateMachine();

    expect(() => machine.expire("smartid")).toThrowError(
      expect.objectContaining({ violation: "INVALID_TRANSITION" }),
    );

    const attempt = machine.begin({ source: "smartid", inputMode: "official-browser" });
    expect(() => machine.complete(attempt, { expiresAt: "not-a-timestamp" })).toThrow();
    expect(machine.getSnapshot()[0]).toMatchObject({ status: "authenticating" });
  });

  it("returns frozen snapshots and schema-frozen source sessions", () => {
    const machine = new InMemoryAuthSourceStateMachine();
    machine.begin({ source: "smartid", inputMode: "official-browser" });
    const snapshot = machine.getSnapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/password|credential|attempt/i);
  });
});
