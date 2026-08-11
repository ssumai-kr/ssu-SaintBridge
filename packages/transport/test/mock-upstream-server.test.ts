import { afterEach, describe, expect, it } from "vitest";

import {
  startMockUpstreamServer,
  type MockUpstreamServer,
} from "./support/mock-upstream-server.js";

const runningServers: MockUpstreamServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map(async (server) => server.close()));
});

describe("mock upstream server", () => {
  it("records a request and returns the configured response", async () => {
    const server = await startMockUpstreamServer([
      {
        method: "POST",
        path: "/sso/login?step=1",
        handler: (request) => ({
          status: 302,
          headers: {
            location: "/portal/callback",
            "x-received-bytes": String(request.body.byteLength),
          },
        }),
      },
    ]);
    runningServers.push(server);

    const response = await fetch(server.url("/sso/login?step=1"), {
      method: "POST",
      body: "studentId=mock-user",
      redirect: "manual",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/portal/callback");
    expect(response.headers.get("x-received-bytes")).toBe("19");
    expect(server.requests).toHaveLength(1);
    expect(Buffer.from(server.requests[0]?.body ?? []).toString("utf8")).toBe(
      "studentId=mock-user",
    );
  });

  it("returns 404 for an unconfigured route", async () => {
    const server = await startMockUpstreamServer([]);
    runningServers.push(server);

    const response = await fetch(server.url("/unknown"));

    expect(response.status).toBe(404);
  });
});
