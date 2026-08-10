import { describe, expect, it } from "vitest";

import { FetchHttpSession, type FetchImplementation, type HttpDiagnostic } from "../src/index.js";

describe("FetchHttpSession diagnostics", () => {
  it("emits one stable safe request ID across a retried request", async () => {
    const queryCanary = "QUERY_CANARY_123";
    const headerCanary = "HEADER_CANARY_456";
    const errorCanary = "ERROR_CANARY_789";
    const bodyCanary = "BODY_CANARY_012";
    const events: HttpDiagnostic[] = [];
    let calls = 0;
    const fetch: FetchImplementation = async () => {
      calls += 1;
      if (calls === 1) throw new Error(errorCanary);
      return new Response(bodyCanary, {
        status: 200,
        headers: {
          "set-cookie": "PORTAL_SESSION=COOKIE_CANARY_345; Path=/; Secure; HttpOnly",
          "x-upstream-canary": "RESPONSE_HEADER_CANARY_678",
        },
      });
    };
    const session = new FetchHttpSession({
      diagnosticSink: (event) => {
        events.push(event);
      },
      fetchImplementation: fetch,
      retryBaseDelayMs: 0,
    });

    await session.request({
      method: "GET",
      url: new URL(`https://saint.ssu.ac.kr/private/path?token=${queryCanary}`),
      headers: { "x-request-canary": headerCanary },
    });

    expect(events.map((event) => event.event)).toEqual([
      "request_started",
      "retry_scheduled",
      "request_completed",
    ]);
    expect(events[1]).toMatchObject({
      attempt: 2,
      retryReason: "network_failure",
    });
    expect(events[2]).toMatchObject({ attempt: 2, status: 200 });
    expect(new Set(events.map((event) => event.requestId)).size).toBe(1);
    expect(events[0]?.requestId).toMatch(
      /^req_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(events.every(Object.isFrozen)).toBe(true);

    const serialized = JSON.stringify(events);
    for (const canary of [
      queryCanary,
      headerCanary,
      errorCanary,
      bodyCanary,
      "COOKIE_CANARY_345",
      "RESPONSE_HEADER_CANARY_678",
      "/private/path",
      "token=",
    ]) {
      expect(serialized).not.toContain(canary);
    }
    expect(serialized).toContain('"host":"saint.ssu.ac.kr"');
  });

  it("reports a POST failure without scheduling a replay", async () => {
    const events: HttpDiagnostic[] = [];
    let calls = 0;
    const fetch: FetchImplementation = async () => {
      calls += 1;
      throw new Error("credential=DO_NOT_LOG");
    };
    const session = new FetchHttpSession({
      diagnosticSink: (event) => {
        events.push(event);
      },
      fetchImplementation: fetch,
    });

    await expect(
      session.request({
        method: "POST",
        url: new URL("https://saint.ssu.ac.kr/login"),
        body: "password=FORM_BODY_CANARY",
      }),
    ).rejects.toMatchObject({ violation: "NETWORK_FAILURE" });

    expect(calls).toBe(1);
    expect(events.map((event) => event.event)).toEqual(["request_started", "request_failed"]);
    expect(events[1]).toMatchObject({
      attempt: 1,
      failure: "NETWORK_FAILURE",
      method: "POST",
    });
    expect(JSON.stringify(events)).not.toContain("FORM_BODY_CANARY");
    expect(JSON.stringify(events)).not.toContain("DO_NOT_LOG");
  });

  it("reports only the safe status when a gateway response is retried", async () => {
    const events: HttpDiagnostic[] = [];
    const responses = [
      new Response("GATEWAY_BODY_CANARY", {
        status: 503,
        headers: { "set-cookie": "FAILED_COOKIE=COOKIE_CANARY; Path=/; Secure" },
      }),
      new Response("ok", { status: 200 }),
    ];
    const fetch: FetchImplementation = async () => {
      const next = responses.shift();
      if (next === undefined) throw new Error("No response remains.");
      return next;
    };
    const session = new FetchHttpSession({
      diagnosticSink: (event) => {
        events.push(event);
      },
      fetchImplementation: fetch,
      retryBaseDelayMs: 0,
    });

    await session.request({
      method: "GET",
      url: new URL("https://saint.ssu.ac.kr/data"),
    });

    expect(events[1]).toMatchObject({
      attempt: 2,
      event: "retry_scheduled",
      retryReason: "upstream_status",
      status: 503,
    });
    expect(JSON.stringify(events)).not.toContain("GATEWAY_BODY_CANARY");
    expect(JSON.stringify(events)).not.toContain("COOKIE_CANARY");
  });

  it("uses a distinct request ID for each request", async () => {
    const events: HttpDiagnostic[] = [];
    const session = new FetchHttpSession({
      diagnosticSink: (event) => {
        events.push(event);
      },
      fetchImplementation: async () => new Response("ok", { status: 200 }),
    });

    await session.request({
      method: "GET",
      url: new URL("https://saint.ssu.ac.kr/first"),
    });
    await session.request({
      method: "GET",
      url: new URL("https://saint.ssu.ac.kr/second"),
    });

    const started = events.filter((event) => event.event === "request_started");
    expect(started).toHaveLength(2);
    expect(started[0]?.requestId).not.toBe(started[1]?.requestId);
  });

  it("isolates synchronous and asynchronous sink failures", async () => {
    const synchronous = new FetchHttpSession({
      diagnosticSink: () => {
        throw new Error("sync diagnostic failure");
      },
      fetchImplementation: async () => new Response("ok", { status: 200 }),
    });
    const asynchronous = new FetchHttpSession({
      diagnosticSink: async () => {
        throw new Error("async diagnostic failure");
      },
      fetchImplementation: async () => new Response("ok", { status: 200 }),
    });

    await expect(
      synchronous.request({
        method: "GET",
        url: new URL("https://saint.ssu.ac.kr/data"),
      }),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      asynchronous.request({
        method: "GET",
        url: new URL("https://saint.ssu.ac.kr/data"),
      }),
    ).resolves.toMatchObject({ status: 200 });
  });
});
