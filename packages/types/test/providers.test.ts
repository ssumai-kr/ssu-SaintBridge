import { describe, expect, it } from "vitest";

import {
  authSnapshotSchema,
  browserLoginRequestSchema,
  isSensitiveScope,
  providerDescriptorSchema,
  providerForScope,
  providerSessionSchema,
  sourceRefSchema,
} from "../src/index.js";

describe("provider contracts", () => {
  it("rejects credentials and unknown fields in browser login requests", () => {
    expect(
      browserLoginRequestSchema.safeParse({
        authSource: "smartid",
        mode: "official-browser",
        scopes: ["usaint:profile.read"],
        studentId: "not-accepted",
        password: "not-accepted",
      }).success,
    ).toBe(false);
  });

  it("maps scopes to providers and marks sensitive scopes", () => {
    expect(providerForScope("usaint:timetable.read")).toBe("usaint");
    expect(providerForScope("lms:tasks.read")).toBe("lms");
    expect(isSensitiveScope("library:loans.read")).toBe(true);
    expect(isSensitiveScope("library:catalog.read")).toBe(false);
  });

  it("accepts an isolated provider session", () => {
    expect(
      providerSessionSchema.parse({
        provider: "lms",
        authenticatedBy: "smartid",
        status: "ready",
        grantedScopes: ["lms:courses.read", "lms:tasks.read"],
        capabilities: [
          { id: "courses.read", available: true },
          { id: "tasks.read", available: true },
        ],
        expiresAt: "2026-08-11T12:00:00+09:00",
      }),
    ).toMatchObject({ provider: "lms", status: "ready" });
  });

  it("rejects scopes from another provider and invalid limited states", () => {
    expect(
      providerSessionSchema.safeParse({
        provider: "usaint",
        authenticatedBy: "smartid",
        status: "ready",
        grantedScopes: ["lms:courses.read"],
        capabilities: [{ id: "courses.read", available: true }],
        expiresAt: null,
      }).success,
    ).toBe(false);

    expect(
      providerSessionSchema.safeParse({
        provider: "library",
        authenticatedBy: "library",
        status: "limited",
        grantedScopes: ["library:catalog.read"],
        capabilities: [{ id: "catalog.read", available: true }],
        expiresAt: null,
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate providers in an auth snapshot", () => {
    const session = {
      provider: "library",
      authenticatedBy: "public",
      status: "unsupported",
      grantedScopes: [],
      capabilities: [{ id: "catalog.read", available: false }],
      expiresAt: null,
    };
    expect(
      authSnapshotSchema.safeParse({
        state: "open",
        authSources: [],
        providers: [session, session],
      }).success,
    ).toBe(false);
  });

  it("separates authentication sources from data providers", () => {
    expect(
      authSnapshotSchema
        .parse({
          state: "open",
          authSources: [
            {
              source: "smartid",
              inputMode: "official-browser",
              status: "authenticated",
              expiresAt: null,
            },
            {
              source: "library",
              inputMode: "application-credentials",
              status: "authenticated",
              expiresAt: null,
            },
          ],
          providers: [
            {
              provider: "usaint",
              authenticatedBy: "smartid",
              status: "ready",
              grantedScopes: ["usaint:profile.read"],
              capabilities: [{ id: "profile.read", available: true }],
              expiresAt: null,
            },
            {
              provider: "library",
              authenticatedBy: "library",
              status: "ready",
              grantedScopes: ["library:loans.read"],
              capabilities: [{ id: "loans.read", available: true }],
              expiresAt: null,
            },
          ],
        })
        .providers.map(({ authenticatedBy }) => authenticatedBy),
    ).toEqual(["smartid", "library"]);
  });

  it("rejects invalid authentication-to-provider bindings", () => {
    expect(
      providerSessionSchema.safeParse({
        provider: "lms",
        authenticatedBy: "library",
        status: "ready",
        grantedScopes: ["lms:courses.read"],
        capabilities: [{ id: "courses.read", available: true }],
        expiresAt: null,
      }).success,
    ).toBe(false);
    expect(
      authSnapshotSchema.safeParse({
        state: "open",
        authSources: [
          {
            source: "smartid",
            inputMode: "official-browser",
            status: "expired",
            expiresAt: null,
          },
        ],
        providers: [
          {
            provider: "usaint",
            authenticatedBy: "smartid",
            status: "ready",
            grantedScopes: ["usaint:profile.read"],
            capabilities: [{ id: "profile.read", available: true }],
            expiresAt: null,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps public source references free of query credentials", () => {
    expect(
      sourceRefSchema.parse({
        provider: "usaint",
        sourceId: "course-list",
        fetchedAt: "2026-08-11T03:00:00Z",
        sourceUrl: "https://saint.ssu.ac.kr/irj/portal",
      }),
    ).toMatchObject({ sourceId: "course-list" });

    expect(
      sourceRefSchema.safeParse({
        provider: "usaint",
        sourceId: "course-list",
        fetchedAt: "2026-08-11T03:00:00Z",
        sourceUrl: "https://saint.ssu.ac.kr/irj/portal?ticket=secret",
      }).success,
    ).toBe(false);
  });

  it("requires descriptor scopes to match the provider", () => {
    expect(
      providerDescriptorSchema.safeParse({
        provider: "library",
        supportedAuthSources: ["smartid", "library"],
        supportsPublicAccess: true,
        supportedScopes: ["usaint:profile.read"],
        capabilities: ["catalog.read"],
      }).success,
    ).toBe(false);
  });
});
