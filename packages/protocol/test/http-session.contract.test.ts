import { describe, expect, it } from "vitest";

import type { HttpSession, HttpSessionRequest, HttpSessionResponse } from "../src/index.js";

class RecordingHttpSession implements HttpSession {
  readonly requests: HttpSessionRequest[] = [];
  closed = false;

  async request(request: HttpSessionRequest): Promise<HttpSessionResponse> {
    this.requests.push(request);
    return {
      status: 302,
      url: request.url,
      headers: { location: ["https://example.invalid/callback"] },
      body: new Uint8Array(),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

describe("HttpSession contract", () => {
  it("preserves a redirect response for the caller to validate", async () => {
    const session = new RecordingHttpSession();
    const response = await session.request({
      method: "GET",
      url: new URL("https://example.invalid/login"),
    });

    expect(response.status).toBe(302);
    expect(response.headers.location).toEqual(["https://example.invalid/callback"]);
    expect(session.requests).toHaveLength(1);

    await session.close();
    expect(session.closed).toBe(true);
  });
});
