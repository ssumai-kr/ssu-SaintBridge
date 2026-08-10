import { describe, expect, it } from "vitest";

import { academicTermSchema, semesterSchema } from "../src/index.js";

describe("semester schemas", () => {
  it.each(["FIRST", "SUMMER", "SECOND", "WINTER"])(
    "accepts the supported semester %s",
    (semester) => {
      expect(semesterSchema.parse(semester)).toBe(semester);
    },
  );

  it("accepts a valid academic term", () => {
    expect(academicTermSchema.parse({ year: 2026, semester: "SECOND" })).toEqual({
      year: 2026,
      semester: "SECOND",
    });
  });

  it.each([
    { year: 2026.5, semester: "SECOND" },
    { year: 1800, semester: "SECOND" },
    { year: 2026, semester: "UNKNOWN" },
    { year: 2026, semester: "SECOND", internalId: "secret" },
  ])("rejects an invalid academic term: %j", (term) => {
    expect(academicTermSchema.safeParse(term).success).toBe(false);
  });
});
