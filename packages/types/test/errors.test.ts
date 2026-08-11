import { describe, expect, it } from "vitest";

import {
  isSaintBridgeError,
  SaintBridgeError,
  saintBridgeErrorCodeSchema,
  saintBridgeErrorPayloadSchema,
} from "../src/index.js";

describe("SaintBridgeError", () => {
  it("assigns retryability from the error code", () => {
    const retryable = new SaintBridgeError({
      code: "UPSTREAM_UNAVAILABLE",
      provider: "lms",
    });
    const terminal = new SaintBridgeError({
      code: "INVALID_CREDENTIALS",
    });

    expect(retryable.retryable).toBe(true);
    expect(terminal.retryable).toBe(false);
    expect(isSaintBridgeError(retryable)).toBe(true);
  });

  it("serializes only the safe public payload", () => {
    const error = new SaintBridgeError({
      code: "AUTH_FLOW_CHANGED",
      cause: new Error("canary-password=do-not-leak"),
      provider: "usaint",
    });

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "AUTH_FLOW_CHANGED",
      message: "The upstream authentication flow no longer matches the expected contract.",
      provider: "usaint",
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain("canary-password");
  });

  it("uses a controlled message instead of an upstream cause", () => {
    const canary = "UPSTREAM_HTML_CANARY";
    const error = new SaintBridgeError({
      code: "PARSER_MISMATCH",
      cause: new Error(canary),
    });

    expect(error.message).toBe("The upstream document no longer matches the expected contract.");
    expect(JSON.stringify(error)).not.toContain(canary);
  });
});

describe("error schemas", () => {
  it("rejects an unknown error code", () => {
    expect(saintBridgeErrorCodeSchema.safeParse("UNKNOWN").success).toBe(false);
  });

  it("rejects extra fields in a public payload", () => {
    expect(
      saintBridgeErrorPayloadSchema.safeParse({
        code: "PARSER_MISMATCH",
        message: "Unexpected markup.",
        retryable: false,
        cause: "secret",
      }).success,
    ).toBe(false);
  });
});
