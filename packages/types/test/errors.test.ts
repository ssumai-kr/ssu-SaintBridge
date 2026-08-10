import { describe, expect, it } from "vitest";

import {
  isSaintError,
  SaintError,
  saintErrorCodeSchema,
  saintErrorPayloadSchema,
} from "../src/index.js";

describe("SaintError", () => {
  it("assigns retryability from the error code", () => {
    const retryable = new SaintError({
      code: "UPSTREAM_UNAVAILABLE",
    });
    const terminal = new SaintError({
      code: "INVALID_CREDENTIALS",
    });

    expect(retryable.retryable).toBe(true);
    expect(terminal.retryable).toBe(false);
    expect(isSaintError(retryable)).toBe(true);
  });

  it("serializes only the safe public payload", () => {
    const error = new SaintError({
      code: "SSO_FLOW_CHANGED",
      cause: new Error("canary-password=do-not-leak"),
    });

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      code: "SSO_FLOW_CHANGED",
      message: "The upstream SSO flow no longer matches the expected contract.",
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain("canary-password");
  });

  it("uses a controlled message instead of an upstream cause", () => {
    const canary = "UPSTREAM_HTML_CANARY";
    const error = new SaintError({
      code: "PARSER_MISMATCH",
      cause: new Error(canary),
    });

    expect(error.message).toBe("The upstream document no longer matches the expected contract.");
    expect(JSON.stringify(error)).not.toContain(canary);
  });
});

describe("error schemas", () => {
  it("rejects an unknown error code", () => {
    expect(saintErrorCodeSchema.safeParse("UNKNOWN").success).toBe(false);
  });

  it("rejects extra fields in a public payload", () => {
    expect(
      saintErrorPayloadSchema.safeParse({
        code: "PARSER_MISMATCH",
        message: "Unexpected markup.",
        retryable: false,
        cause: "secret",
      }).success,
    ).toBe(false);
  });
});
