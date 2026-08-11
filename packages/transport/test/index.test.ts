import { describe, expect, it } from "vitest";

import { FetchHttpSession, UpstreamUrlPolicy } from "../src/index.js";

describe("transport package", () => {
  it("exports transport primitives without provider state", async () => {
    const policy = new UpstreamUrlPolicy({ allowedHosts: ["saint.ssu.ac.kr"] });
    const session = new FetchHttpSession({ urlPolicy: policy });

    expect(session).toBeInstanceOf(FetchHttpSession);
    expect(JSON.parse(JSON.stringify(session))).toEqual({ closed: false });
    await session.close();
  });
});
