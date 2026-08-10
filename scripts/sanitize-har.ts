import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sanitizeHar } from "./har-redaction.ts";

export interface SanitizeHarFileOptions {
  readonly inputPath: string;
  readonly outputPath: string;
  readonly overwrite?: boolean;
}

export const sanitizeHarFile = async ({
  inputPath,
  outputPath,
  overwrite = false,
}: SanitizeHarFileOptions): Promise<void> => {
  const resolvedInput = resolve(inputPath);
  const resolvedOutput = resolve(outputPath);

  if (resolvedInput === resolvedOutput) {
    throw new TypeError("Refusing to overwrite the original HAR file.");
  }
  if (!resolvedOutput.endsWith(".sanitized.har")) {
    throw new TypeError("Sanitized HAR output must end with .sanitized.har.");
  }

  const source = await readFile(resolvedInput, "utf8");
  const sanitized = sanitizeHar(JSON.parse(source) as unknown);
  const flag = overwrite ? "w" : "wx";
  await writeFile(resolvedOutput, `${JSON.stringify(sanitized, null, 2)}\n`, {
    encoding: "utf8",
    flag,
    mode: 0o600,
  });
};

const runCli = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const overwriteIndex = args.indexOf("--force");
  const overwrite = overwriteIndex !== -1;
  if (overwrite) args.splice(overwriteIndex, 1);

  if (args.length !== 2) {
    throw new TypeError("Usage: pnpm sanitize:har <input.har> <output.sanitized.har> [--force]");
  }

  await sanitizeHarFile({
    inputPath: args[0] as string,
    outputPath: args[1] as string,
    overwrite,
  });
  process.stdout.write(`Sanitized HAR written to ${resolve(args[1] as string)}\n`);
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown sanitizer failure.";
    process.stderr.write(`HAR sanitization failed: ${message}\n`);
    process.exitCode = 1;
  });
}
