import { describe, expect, it } from "vitest";

import { UpstreamUrlPolicyError } from "../src/index.js";
import {
  maxSetCookieHeaderLength,
  maxSetCookieHeaders,
  SessionCookieJar,
  SessionCookieJarError,
} from "../src/transport/session-cookie-jar.js";

const portalUrl = "https://saint.ssu.ac.kr/irj/portal";
const portalChildUrl = "https://saint.ssu.ac.kr/irj/portal/student";
const portalOtherPathUrl = "https://saint.ssu.ac.kr/other";
const smartIdUrl = "https://smartid.ssu.ac.kr/login";

describe("SessionCookieJar", () => {
  it("stores and returns a host-only cookie", async () => {
    const jar = new SessionCookieJar();

    await jar.storeFromResponse(portalUrl, [
      "PORTAL_SESSION=mock-session; Path=/; Secure; HttpOnly",
    ]);

    await expect(jar.getCookieHeader(portalChildUrl)).resolves.toBe("PORTAL_SESSION=mock-session");
    await expect(jar.getCookieHeader(smartIdUrl)).resolves.toBeNull();
  });

  it("respects an explicitly scoped parent domain", async () => {
    const jar = new SessionCookieJar();

    await jar.storeFromResponse(portalUrl, [
      "SSO_SHARED=mock-shared; Domain=ssu.ac.kr; Path=/; Secure; HttpOnly",
    ]);

    await expect(jar.getCookieHeader(portalUrl)).resolves.toBe("SSO_SHARED=mock-shared");
    await expect(jar.getCookieHeader(smartIdUrl)).resolves.toBe("SSO_SHARED=mock-shared");
  });

  it("respects the cookie path boundary", async () => {
    const jar = new SessionCookieJar();

    await jar.storeFromResponse(portalUrl, ["IRJ_SESSION=mock-irj; Path=/irj; Secure"]);

    await expect(jar.getCookieHeader(portalChildUrl)).resolves.toBe("IRJ_SESSION=mock-irj");
    await expect(jar.getCookieHeader(portalOtherPathUrl)).resolves.toBeNull();
  });

  it("stores multiple Set-Cookie headers", async () => {
    const jar = new SessionCookieJar();

    await jar.storeFromResponse(portalUrl, [
      "FIRST_COOKIE=one; Path=/; Secure",
      "SECOND_COOKIE=two; Path=/; Secure",
    ]);

    const header = await jar.getCookieHeader(portalUrl);
    expect(header).toContain("FIRST_COOKIE=one");
    expect(header).toContain("SECOND_COOKIE=two");
  });

  it("removes an expired cookie", async () => {
    const jar = new SessionCookieJar();
    await jar.storeFromResponse(portalUrl, ["PORTAL_SESSION=mock-session; Path=/; Secure"]);

    await jar.storeFromResponse(portalUrl, ["PORTAL_SESSION=deleted; Path=/; Secure; Max-Age=0"]);

    await expect(jar.getCookieHeader(portalUrl)).resolves.toBeNull();
  });

  it("clears all cookies without closing the jar", async () => {
    const jar = new SessionCookieJar();
    await jar.storeFromResponse(portalUrl, ["PORTAL_SESSION=mock-session; Path=/; Secure"]);

    await jar.clear();

    expect(jar.closed).toBe(false);
    await expect(jar.getCookieHeader(portalUrl)).resolves.toBeNull();
  });

  it("clears secrets and blocks access after close", async () => {
    const jar = new SessionCookieJar();
    await jar.storeFromResponse(portalUrl, ["PORTAL_SESSION=mock-session; Path=/; Secure"]);

    await jar.close();
    await jar.close();

    expect(jar.closed).toBe(true);
    await expect(jar.getCookieHeader(portalUrl)).rejects.toMatchObject({ violation: "CLOSED" });
    await expect(jar.storeFromResponse(portalUrl, [])).rejects.toMatchObject({
      violation: "CLOSED",
    });
  });

  it("keeps separate user sessions isolated", async () => {
    const firstUser = new SessionCookieJar();
    const secondUser = new SessionCookieJar();
    await firstUser.storeFromResponse(portalUrl, ["PORTAL_SESSION=user-a; Path=/; Secure"]);
    await secondUser.storeFromResponse(portalUrl, ["PORTAL_SESSION=user-b; Path=/; Secure"]);

    await expect(firstUser.getCookieHeader(portalUrl)).resolves.toBe("PORTAL_SESSION=user-a");
    await expect(secondUser.getCookieHeader(portalUrl)).resolves.toBe("PORTAL_SESSION=user-b");
  });

  it("rejects cookies for an unrelated domain without leaking their value", async () => {
    const jar = new SessionCookieJar();
    const sensitiveCookie = "PORTAL_SESSION=do-not-leak; Domain=evil.example; Path=/; Secure";

    let captured: unknown;
    try {
      await jar.storeFromResponse(portalUrl, [sensitiveCookie]);
    } catch (error: unknown) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(SessionCookieJarError);
    expect(captured).toMatchObject({ violation: "INVALID_SET_COOKIE" });
    expect(JSON.stringify(captured)).not.toContain("do-not-leak");
  });

  it("enforces secure cookie prefixes", async () => {
    const jar = new SessionCookieJar();

    await expect(
      jar.storeFromResponse(portalUrl, ["__Host-SESSION=unsafe; Domain=ssu.ac.kr; Path=/"]),
    ).rejects.toMatchObject({ violation: "INVALID_SET_COOKIE" });
  });

  it("rejects non-HTTPS cookie operations through the URL policy", async () => {
    const jar = new SessionCookieJar();

    await expect(
      jar.storeFromResponse("http://saint.ssu.ac.kr/irj/portal", ["SESSION=unsafe"]),
    ).rejects.toBeInstanceOf(UpstreamUrlPolicyError);
  });

  it("rejects excessive Set-Cookie counts before storing anything", async () => {
    const jar = new SessionCookieJar();
    const headers = Array.from(
      { length: maxSetCookieHeaders + 1 },
      (_, index) => `COOKIE_${index}=value; Path=/; Secure`,
    );

    await expect(jar.storeFromResponse(portalUrl, headers)).rejects.toMatchObject({
      violation: "LIMIT_EXCEEDED",
    });
    await expect(jar.getCookieHeader(portalUrl)).resolves.toBeNull();
  });

  it("rejects oversized Set-Cookie headers before storing anything", async () => {
    const jar = new SessionCookieJar();
    const oversized = `SESSION=${"x".repeat(maxSetCookieHeaderLength)}`;

    await expect(jar.storeFromResponse(portalUrl, [oversized])).rejects.toMatchObject({
      violation: "LIMIT_EXCEEDED",
    });
    await expect(jar.getCookieHeader(portalUrl)).resolves.toBeNull();
  });

  it("does not serialize cookie values", async () => {
    const jar = new SessionCookieJar();
    await jar.storeFromResponse(portalUrl, ["PORTAL_SESSION=do-not-serialize; Path=/; Secure"]);

    expect(JSON.stringify(jar)).toBe('{"closed":false}');
    expect(JSON.stringify(jar)).not.toContain("do-not-serialize");
  });
});
