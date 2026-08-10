import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanRepository } from "../repository-security.ts";

const temporaryDirectories: string[] = [];

const createRepository = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "ssu-saintbridge-security-"));
  temporaryDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("repository security scanner", () => {
  it("accepts ordinary source and sanitized fixtures", async () => {
    const root = await createRepository();
    await mkdir(join(root, "fixtures", "mock"), { recursive: true });
    await writeFile(join(root, "index.ts"), "export const ok = true;\n", "utf8");
    await writeFile(
      join(root, "fixtures", "mock", "login.sanitized.har"),
      JSON.stringify({ log: { entries: [] } }),
      "utf8",
    );

    await expect(scanRepository(root)).resolves.toEqual([]);
  });

  it("finds forbidden files and canary values", async () => {
    const root = await createRepository();
    const canary = ["CANARY", "SECRET", "DELTA12345678"].join("_");
    await mkdir(join(root, "fixtures", "raw"), { recursive: true });
    await writeFile(join(root, ".env"), `PASSWORD=${canary}\n`, "utf8");
    await writeFile(join(root, "capture.har"), "{}", "utf8");
    await writeFile(join(root, "fixtures", "raw", "student.json"), "{}", "utf8");

    const findings = await scanRepository(root);
    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining([
        "CANARY_SECRET_PRESENT",
        "ENV_FILE_FORBIDDEN",
        "RAW_FIXTURE_FORBIDDEN",
        "RAW_HAR_FORBIDDEN",
      ]),
    );
  });

  it("finds credential-shaped values in data artifacts", async () => {
    const root = await createRepository();
    await mkdir(join(root, "fixtures", "mock"), { recursive: true });
    await writeFile(
      join(root, "fixtures", "mock", "unsafe.json"),
      JSON.stringify({ password: "not-redacted", authorization: "Bearer unsafe-token" }),
      "utf8",
    );

    const findings = await scanRepository(root);
    expect(findings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining(["PASSWORD_VALUE_PRESENT", "AUTHORIZATION_VALUE_PRESENT"]),
    );
  });
});
