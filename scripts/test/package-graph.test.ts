import { describe, expect, it } from "vitest";

import { inspectPackageGraph } from "../package-graph.ts";

describe("workspace package graph", () => {
  it("matches the multi-provider dependency policy", async () => {
    await expect(inspectPackageGraph(process.cwd())).resolves.toEqual([]);
  });
});
