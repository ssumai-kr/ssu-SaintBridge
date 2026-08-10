import { describe, expect, it } from "vitest";

import {
  FetchHttpSession,
  HttpSessionError,
  requestFollowingRedirects,
  type FetchImplementation,
} from "../src/index.js";

interface CapturedFetchCall {
  readonly input: string | URL | Request;
  readonly init: RequestInit | undefined;
}

const responseWithHeaders = (
  body: ConstructorParameters<typeof Response>[0],
  init: ResponseInit,
  setCookies: readonly string[] = [],
): Response => {
  const headers = new Headers(init.headers);
  for (const cookie of setCookies) headers.append("set-cookie", cookie);
  return new Response(body, { ...init, headers });
};

const createQueueFetch = (
  responses: readonly Response[],
): { readonly calls: CapturedFetchCall[]; readonly fetch: FetchImplementation } => {
  const calls: CapturedFetchCall[] = [];
  const queue = [...responses];
  return {
    calls,
    fetch: async (input, init) => {
      calls.push({ input, init });
      const response = queue.shift();
      if (response === undefined) throw new Error("No fake response remains.");
      return response;
    },
  };
};

describe("FetchHttpSession", () => {
  it("forces manual redirects and returns the redirect response", async () => {
    const fake = createQueueFetch([
      responseWithHeaders(null, { status: 302, headers: { location: "/callback" } }),
    ]);
    const session = new FetchHttpSession({ fetchImplementation: fake.fetch });

    const response = await session.request({
      method: "GET",
      url: new URL("https://saint.ssu.ac.kr/irj/portal"),
    });

    expect(response.status).toBe(302);
    expect(response.headers.location).toEqual(["/callback"]);
    expect(fake.calls[0]?.init?.redirect).toBe("manual");
  });

  it("stores Set-Cookie privately and sends it on the next matching request", async () => {
    const fake = createQueueFetch([
      responseWithHeaders(null, { status: 302, headers: { location: "/next" } }, [
        "PORTAL_SESSION=mock-session; Path=/; Secure; HttpOnly",
      ]),
      responseWithHeaders("ok", { status: 200 }),
    ]);
    const session = new FetchHttpSession({ fetchImplementation: fake.fetch });
    const url = new URL("https://saint.ssu.ac.kr/irj/portal");

    const first = await session.request({ method: "GET", url });
    await session.request({ method: "GET", url });

    expect(first.headers["set-cookie"]).toBeUndefined();
    expect(new Headers(fake.calls[0]?.init?.headers).get("cookie")).toBeNull();
    expect(new Headers(fake.calls[1]?.init?.headers).get("cookie")).toBe(
      "PORTAL_SESSION=mock-session",
    );
  });

  it("carries a newly stored cookie through a manually followed redirect", async () => {
    const fake = createQueueFetch([
      responseWithHeaders(null, { status: 302, headers: { location: "/callback" } }, [
        "PORTAL_SESSION=redirect-session; Path=/; Secure; HttpOnly",
      ]),
      responseWithHeaders("done", { status: 200 }),
    ]);
    const session = new FetchHttpSession({ fetchImplementation: fake.fetch });

    const result = await requestFollowingRedirects(session, {
      method: "POST",
      url: new URL("https://saint.ssu.ac.kr/login"),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "studentId=mock",
    });

    expect(result.status).toBe(200);
    expect(fake.calls[1]?.init?.method).toBe("GET");
    expect(fake.calls[1]?.init?.body).toBeUndefined();
    expect(new Headers(fake.calls[1]?.init?.headers).get("cookie")).toBe(
      "PORTAL_SESSION=redirect-session",
    );
  });

  it("returns response bytes", async () => {
    const fake = createQueueFetch([responseWithHeaders("한글", { status: 200 })]);
    const session = new FetchHttpSession({ fetchImplementation: fake.fetch });

    const response = await session.request({
      method: "GET",
      url: new URL("https://saint.ssu.ac.kr/data"),
    });

    expect(new TextDecoder().decode(response.body)).toBe("한글");
  });

  it.each(["Cookie", "Authorization", "Host", "Content-Length"])(
    "rejects the transport-managed request header %s",
    async (header) => {
      const fake = createQueueFetch([responseWithHeaders("ok", { status: 200 })]);
      const session = new FetchHttpSession({ fetchImplementation: fake.fetch });

      await expect(
        session.request({
          method: "GET",
          url: new URL("https://saint.ssu.ac.kr/data"),
          headers: { [header]: "do-not-send" },
        }),
      ).rejects.toMatchObject({ violation: "FORBIDDEN_REQUEST_HEADER" });
      expect(fake.calls).toHaveLength(0);
    },
  );

  it("rejects GET and HEAD bodies before sending", async () => {
    const fake = createQueueFetch([responseWithHeaders("ok", { status: 200 })]);
    const session = new FetchHttpSession({ fetchImplementation: fake.fetch });

    await expect(
      session.request({
        method: "GET",
        url: new URL("https://saint.ssu.ac.kr/data"),
        body: "unsafe",
      }),
    ).rejects.toMatchObject({ violation: "INVALID_REQUEST_BODY" });
    expect(fake.calls).toHaveLength(0);
  });

  it("maps fetch failures to a safe error", async () => {
    const fetch: FetchImplementation = async () => {
      throw new Error("https://saint.ssu.ac.kr/?token=do-not-leak");
    };
    const session = new FetchHttpSession({ fetchImplementation: fetch });

    let captured: unknown;
    try {
      await session.request({
        method: "GET",
        url: new URL("https://saint.ssu.ac.kr/data"),
      });
    } catch (error: unknown) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(HttpSessionError);
    expect(captured).toMatchObject({ violation: "NETWORK_FAILURE" });
    expect(JSON.stringify(captured)).not.toContain("do-not-leak");
  });

  it("clears cookies and rejects requests after close", async () => {
    const fake = createQueueFetch([responseWithHeaders("ok", { status: 200 })]);
    const session = new FetchHttpSession({ fetchImplementation: fake.fetch });

    await session.close();
    await session.close();

    await expect(
      session.request({
        method: "GET",
        url: new URL("https://saint.ssu.ac.kr/data"),
      }),
    ).rejects.toMatchObject({ violation: "CLOSED" });
    expect(JSON.stringify(session)).toBe('{"closed":true}');
  });
});
