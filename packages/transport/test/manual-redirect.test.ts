import { describe, expect, it } from "vitest";

import {
  HttpSessionError,
  requestFollowingRedirects,
  UpstreamUrlPolicyError,
  type HttpSession,
  type HttpSessionRequest,
  type HttpSessionResponse,
} from "../src/index.js";

class QueueSession implements HttpSession {
  readonly requests: HttpSessionRequest[] = [];
  readonly #responses: HttpSessionResponse[];

  constructor(responses: readonly HttpSessionResponse[]) {
    this.#responses = [...responses];
  }

  async request(request: HttpSessionRequest): Promise<HttpSessionResponse> {
    this.requests.push(request);
    const response = this.#responses.shift();
    if (response === undefined) throw new Error("No response remains.");
    return response;
  }

  async close(): Promise<void> {}
}

const response = (status: number, url: string, location?: string): HttpSessionResponse => ({
  status,
  url: new URL(url),
  headers: location === undefined ? {} : { location: [location] },
  body: new Uint8Array(),
});

describe("requestFollowingRedirects", () => {
  it("resolves a relative redirect and converts POST 302 to GET", async () => {
    const session = new QueueSession([
      response(302, "https://saint.ssu.ac.kr/login", "/callback"),
      response(200, "https://saint.ssu.ac.kr/callback"),
    ]);

    const result = await requestFollowingRedirects(session, {
      method: "POST",
      url: new URL("https://saint.ssu.ac.kr/login"),
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "text/html" },
      body: "password=mock",
    });

    expect(result.status).toBe(200);
    expect(session.requests).toHaveLength(2);
    expect(session.requests[1]).toMatchObject({
      method: "GET",
      url: new URL("https://saint.ssu.ac.kr/callback"),
      headers: { accept: "text/html" },
    });
    expect(session.requests[1]?.body).toBeUndefined();
  });

  it("preserves the method and body for a 307 redirect", async () => {
    const session = new QueueSession([
      response(307, "https://saint.ssu.ac.kr/login", "/continue"),
      response(200, "https://saint.ssu.ac.kr/continue"),
    ]);

    await requestFollowingRedirects(session, {
      method: "POST",
      url: new URL("https://saint.ssu.ac.kr/login"),
      body: "payload=mock",
    });

    expect(session.requests[1]).toMatchObject({ method: "POST", body: "payload=mock" });
  });

  it("allows a validated redirect to SmartID", async () => {
    const session = new QueueSession([
      response(302, "https://saint.ssu.ac.kr/login", "https://smartid.ssu.ac.kr/sso"),
      response(200, "https://smartid.ssu.ac.kr/sso"),
    ]);

    await requestFollowingRedirects(session, {
      method: "GET",
      url: new URL("https://saint.ssu.ac.kr/login"),
    });

    expect(session.requests[1]?.url.hostname).toBe("smartid.ssu.ac.kr");
  });

  it("rejects a redirect without Location", async () => {
    const session = new QueueSession([response(302, "https://saint.ssu.ac.kr/login")]);

    await expect(
      requestFollowingRedirects(session, {
        method: "GET",
        url: new URL("https://saint.ssu.ac.kr/login"),
      }),
    ).rejects.toMatchObject({ violation: "MISSING_REDIRECT_LOCATION" });
  });

  it("rejects a redirect to a non-allowlisted host", async () => {
    const session = new QueueSession([
      response(302, "https://saint.ssu.ac.kr/login", "https://evil.example/steal"),
    ]);

    await expect(
      requestFollowingRedirects(session, {
        method: "GET",
        url: new URL("https://saint.ssu.ac.kr/login"),
      }),
    ).rejects.toBeInstanceOf(UpstreamUrlPolicyError);
  });

  it("stops redirect loops at the configured limit", async () => {
    const session = new QueueSession([
      response(302, "https://saint.ssu.ac.kr/a", "/b"),
      response(302, "https://saint.ssu.ac.kr/b", "/a"),
    ]);

    await expect(
      requestFollowingRedirects(
        session,
        { method: "GET", url: new URL("https://saint.ssu.ac.kr/a") },
        { maxRedirects: 1 },
      ),
    ).rejects.toMatchObject({ violation: "REDIRECT_LIMIT_EXCEEDED" });
    expect(session.requests).toHaveLength(2);
  });

  it("rejects invalid redirect limits", async () => {
    const session = new QueueSession([]);

    for (const maxRedirects of [-1, 1.5, 21]) {
      await expect(
        requestFollowingRedirects(
          session,
          { method: "GET", url: new URL("https://saint.ssu.ac.kr/a") },
          { maxRedirects },
        ),
      ).rejects.toThrow(TypeError);
    }
  });

  it("returns a non-redirect response unchanged", async () => {
    const expected = response(200, "https://saint.ssu.ac.kr/data");
    const session = new QueueSession([expected]);

    await expect(
      requestFollowingRedirects(session, {
        method: "GET",
        url: new URL("https://saint.ssu.ac.kr/data"),
      }),
    ).resolves.toBe(expected);
  });

  it("uses safe redirect errors", () => {
    const error = new HttpSessionError("REDIRECT_LIMIT_EXCEEDED");
    expect(JSON.stringify(error)).toBe(
      '{"name":"HttpSessionError","violation":"REDIRECT_LIMIT_EXCEEDED"}',
    );
  });
});
