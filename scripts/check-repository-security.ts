import { resolve } from "node:path";

import { scanRepository } from "./repository-security.ts";

const root = resolve(process.argv[2] ?? ".");
const findings = await scanRepository(root);

if (findings.length > 0) {
  process.stderr.write("Repository security check failed:\n");
  for (const finding of findings) {
    process.stderr.write(`- ${finding.rule}: ${finding.path}\n`);
  }
  process.exitCode = 1;
} else {
  process.stdout.write("Repository security check passed.\n");
}
