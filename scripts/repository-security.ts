import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";

export interface SecurityFinding {
  readonly path: string;
  readonly rule: string;
}

const skippedDirectories = new Set([".git", "node_modules", "dist", "coverage", ".turbo"]);
const textExtensions = new Set([
  ".env",
  ".har",
  ".html",
  ".js",
  ".json",
  ".log",
  ".md",
  ".ts",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);
const dataArtifactExtensions = new Set([".env", ".har", ".html", ".json", ".log", ".txt", ".xml"]);

const globalContentRules = [
  {
    rule: "CANARY_SECRET_PRESENT",
    pattern: /CANARY_(?:PASSWORD|COOKIE|TOKEN|SECRET)_[A-Za-z0-9_-]{8,}/,
  },
  {
    rule: "PRIVATE_KEY_PRESENT",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
] as const;

const artifactContentRules = [
  {
    rule: "COOKIE_VALUE_PRESENT",
    pattern: /(?:^|[{\s,])["']?(?:cookie|set-cookie)["']?\s*[:=]\s*["']?(?!\[REDACTED)[^\s"']+/i,
  },
  {
    rule: "AUTHORIZATION_VALUE_PRESENT",
    pattern: /(?:^|[{\s,])["']?authorization["']?\s*[:=]\s*["']?(?:basic|bearer)\s+[^\s"']+/i,
  },
  {
    rule: "PASSWORD_VALUE_PRESENT",
    pattern: /(?:^|[{\s,])["']?(?:password|passwd|pwd)["']?\s*[:=]\s*["']?(?!\[REDACTED)[^\s"']+/i,
  },
  {
    rule: "PERSONAL_ID_PRESENT",
    pattern: /\b\d{6}-[1-4]\d{6}\b/,
  },
] as const;

const shouldReadAsText = (path: string): boolean => {
  const extension = extname(path).toLowerCase();
  return textExtensions.has(extension) || basename(path).startsWith(".env");
};

const pathFindings = (path: string): SecurityFinding[] => {
  const normalized = path.split(sep).join("/");
  const filename = basename(path);
  const findings: SecurityFinding[] = [];

  if (filename.startsWith(".env") && filename !== ".env.example") {
    findings.push({ path: normalized, rule: "ENV_FILE_FORBIDDEN" });
  }
  if (normalized.startsWith("fixtures/raw/")) {
    findings.push({ path: normalized, rule: "RAW_FIXTURE_FORBIDDEN" });
  }
  if (filename.endsWith(".har") && !/^fixtures\/.+\.sanitized\.har$/.test(normalized)) {
    findings.push({ path: normalized, rule: "RAW_HAR_FORBIDDEN" });
  }
  if (/\.session(?:\.|$)/i.test(filename) || /^(?:cookies?|sessions?)\.json$/i.test(filename)) {
    findings.push({ path: normalized, rule: "SESSION_FILE_FORBIDDEN" });
  }
  if (/\.(?:key|p12|pfx|pem)$/i.test(filename) || /^id_(?:rsa|ecdsa|ed25519)$/i.test(filename)) {
    findings.push({ path: normalized, rule: "PRIVATE_KEY_FILE_FORBIDDEN" });
  }

  return findings;
};

const contentFindings = (path: string, content: string): SecurityFinding[] => {
  const normalized = path.split(sep).join("/");
  const findings: SecurityFinding[] = [];

  for (const { rule, pattern } of globalContentRules) {
    if (pattern.test(content)) findings.push({ path: normalized, rule });
  }

  const extension = extname(path).toLowerCase();
  if (dataArtifactExtensions.has(extension) || basename(path).startsWith(".env")) {
    for (const { rule, pattern } of artifactContentRules) {
      if (pattern.test(content)) findings.push({ path: normalized, rule });
    }
  }

  return findings;
};

const collectFiles = async (root: string, directory = root): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;

    const absolutePath = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, absolutePath)));
    } else if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files;
};

export const scanRepository = async (root: string): Promise<SecurityFinding[]> => {
  const resolvedRoot = resolve(root);
  const rootStats = await stat(resolvedRoot);
  if (!rootStats.isDirectory()) throw new TypeError("Repository root must be a directory.");

  const findings: SecurityFinding[] = [];
  for (const absolutePath of await collectFiles(resolvedRoot)) {
    const repositoryPath = relative(resolvedRoot, absolutePath);
    findings.push(...pathFindings(repositoryPath));

    if (shouldReadAsText(repositoryPath)) {
      const content = await readFile(absolutePath, "utf8");
      findings.push(...contentFindings(repositoryPath, content));
    }
  }

  return findings.sort((left, right) =>
    `${left.path}:${left.rule}`.localeCompare(`${right.path}:${right.rule}`),
  );
};
