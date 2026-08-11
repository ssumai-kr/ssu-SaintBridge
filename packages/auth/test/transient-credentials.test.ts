import { inspect } from "node:util";

import { describe, expect, it } from "vitest";

import { parseAuthLoginRequest, TransientCredentials } from "../src/index.js";

describe("transient credentials", () => {
  it("allows one bounded use and then releases its values", async () => {
    const credentials = new TransientCredentials({
      identifier: "student-id",
      password: "temporary-password",
    });

    await expect(
      credentials.withCredentials(async ({ identifier, password }) => `${identifier}:${password}`),
    ).resolves.toBe("student-id:temporary-password");
    expect(credentials.released).toBe(true);
    await expect(credentials.withCredentials(async () => undefined)).rejects.toThrow(
      "already been released",
    );
  });

  it("releases its values when the credential consumer fails", async () => {
    const credentials = new TransientCredentials({
      identifier: "student-id",
      password: "temporary-password",
    });

    await expect(
      credentials.withCredentials(async () => {
        throw new Error("upstream login failed");
      }),
    ).rejects.toThrow("upstream login failed");
    expect(credentials.released).toBe(true);
  });

  it("redacts inspection and serialization output", () => {
    const secret = ["never", "serialize", "this"].join("-");
    const credentials = new TransientCredentials({ identifier: "student-id", password: secret });

    expect(String(credentials)).not.toContain(secret);
    expect(inspect(credentials)).not.toContain(secret);
    expect(JSON.stringify(credentials)).not.toContain(secret);
    expect(JSON.parse(JSON.stringify(credentials))).toEqual({ released: false, redacted: true });
  });
});

describe("authentication login requests", () => {
  it("accepts the official browser mode without credential fields", () => {
    expect(
      parseAuthLoginRequest({
        authSource: "smartid",
        mode: "official-browser",
        scopes: ["usaint:profile.read"],
      }),
    ).toEqual({
      authSource: "smartid",
      mode: "official-browser",
      scopes: ["usaint:profile.read"],
    });
  });

  it("accepts an application credential provider", () => {
    const acquireCredentials = () =>
      new TransientCredentials({ identifier: "student-id", password: "temporary-password" });

    expect(
      parseAuthLoginRequest({
        authSource: "library",
        mode: "application-credentials",
        scopes: ["library:loans.read"],
        acquireCredentials,
      }),
    ).toMatchObject({
      authSource: "library",
      mode: "application-credentials",
      acquireCredentials,
    });
  });

  it("rejects credentials placed directly in the request", () => {
    expect(() =>
      parseAuthLoginRequest({
        authSource: "smartid",
        mode: "application-credentials",
        scopes: ["usaint:profile.read"],
        acquireCredentials: () =>
          new TransientCredentials({ identifier: "student-id", password: "temporary-password" }),
        password: "must-not-be-an-api-field",
      }),
    ).toThrow("unsupported field");
  });

  it("rejects unsupported modes and missing credential providers", () => {
    expect(() =>
      parseAuthLoginRequest({ authSource: "smartid", mode: "embedded-form", scopes: [] }),
    ).toThrow("not supported");
    expect(() =>
      parseAuthLoginRequest({
        authSource: "smartid",
        mode: "application-credentials",
        scopes: [],
      }),
    ).toThrow("requires an acquireCredentials provider");
  });
});
