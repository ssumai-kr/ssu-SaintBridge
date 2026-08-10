import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sanitizeHar } from "../har-redaction.ts";
import { sanitizeHarFile } from "../sanitize-har.ts";

const temporaryDirectories: string[] = [];

const createSensitiveHar = () => {
  const password = ["CANARY", "PASSWORD", "ALPHA12345678"].join("_");
  const cookie = ["CANARY", "COOKIE", "BRAVO12345678"].join("_");
  const token = ["CANARY", "TOKEN", "CHARLIE12345678"].join("_");

  return {
    secrets: { password, cookie, token },
    har: {
      log: {
        version: "1.2",
        creator: { name: "test", version: "1" },
        entries: [
          {
            request: {
              method: "POST",
              url: `https://smartid.ssu.ac.kr/login?studentId=20261234&sessionId=${token}#callback=${token}`,
              headers: [
                { name: "Cookie", value: `SESSION=${cookie}` },
                { name: "Authorization", value: `Bearer ${token}` },
                { name: "Accept", value: "text/html" },
              ],
              cookies: [{ name: "SESSION", value: cookie }],
              queryString: [
                { name: "studentId", value: "20261234" },
                { name: "page", value: "1" },
              ],
              postData: {
                mimeType: "application/json",
                text: JSON.stringify({
                  password,
                  studentName: "Mock Student",
                  email: "student@example.com",
                  phone: "010-1234-5678",
                }),
              },
            },
            response: {
              status: 302,
              headers: [{ name: "Set-Cookie", value: `SESSION=${cookie}` }],
              cookies: [{ name: "SESSION", value: cookie }],
              content: {
                mimeType: "application/json",
                text: JSON.stringify({
                  studentId: "20261234",
                  accessToken: token,
                  grade: "A+",
                }),
              },
            },
          },
        ],
      },
    },
  };
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true })),
  );
});

describe("HAR redaction", () => {
  it("removes authentication headers, cookies, credentials, tokens and PII", () => {
    const { har, secrets } = createSensitiveHar();
    const sanitized = sanitizeHar(har);
    const output = JSON.stringify(sanitized);

    expect(output).not.toContain(secrets.password);
    expect(output).not.toContain(secrets.cookie);
    expect(output).not.toContain(secrets.token);
    expect(output).not.toContain("student@example.com");
    expect(output).not.toContain("010-1234-5678");
    expect(output).not.toContain("20261234");
    expect(output).not.toContain('"Cookie"');
    expect(output).not.toContain('"Authorization"');
    expect(output).not.toContain('"Set-Cookie"');
    expect(output).toContain("[REDACTED:PASSWORD]");
    expect(output).toContain("[REDACTED:STUDENT_ID]");
    expect(output).toContain("[REDACTED:ACADEMIC_DATA]");
    expect(output).toContain("[REDACTED:FRAGMENT]");
  });

  it("refuses invalid HAR structures", () => {
    expect(() => sanitizeHar({ log: {} })).toThrow("Input is not a valid HAR object");
  });

  it("writes only to a distinct .sanitized.har file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ssu-saintbridge-har-"));
    temporaryDirectories.push(directory);
    const { har, secrets } = createSensitiveHar();
    const inputPath = join(directory, "capture.har");
    const outputPath = join(directory, "capture.sanitized.har");
    await writeFile(inputPath, JSON.stringify(har), "utf8");

    await sanitizeHarFile({ inputPath, outputPath });
    const output = await readFile(outputPath, "utf8");
    expect(output).not.toContain(secrets.password);

    await expect(
      sanitizeHarFile({ inputPath, outputPath: join(directory, "unsafe.json") }),
    ).rejects.toThrow("must end with .sanitized.har");
    await expect(sanitizeHarFile({ inputPath, outputPath: inputPath })).rejects.toThrow(
      "Refusing to overwrite",
    );
    await expect(sanitizeHarFile({ inputPath, outputPath })).rejects.toThrow();
  });
});
