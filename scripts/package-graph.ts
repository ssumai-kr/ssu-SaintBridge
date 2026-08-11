import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

interface PackageManifest {
  readonly name?: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
}

export interface PackageGraphFinding {
  readonly package: string;
  readonly dependency: string;
  readonly rule:
    "MISSING_DEPENDENCY" | "MISSING_PACKAGE" | "UNEXPECTED_DEPENDENCY" | "UNEXPECTED_PACKAGE";
}

const workspaceDependencyPolicy: Readonly<Record<string, readonly string[]>> = {
  "@ssu-saintbridge/types": [],
  "@ssu-saintbridge/transport": [],
  "@ssu-saintbridge/auth": ["@ssu-saintbridge/transport", "@ssu-saintbridge/types"],
  "@ssu-saintbridge/usaint": ["@ssu-saintbridge/auth", "@ssu-saintbridge/types"],
  "@ssu-saintbridge/lms": ["@ssu-saintbridge/auth", "@ssu-saintbridge/types"],
  "@ssu-saintbridge/library": ["@ssu-saintbridge/auth", "@ssu-saintbridge/types"],
  "@ssu-saintbridge/facade": [
    "@ssu-saintbridge/auth",
    "@ssu-saintbridge/library",
    "@ssu-saintbridge/lms",
    "@ssu-saintbridge/types",
    "@ssu-saintbridge/usaint",
  ],
  "@ssu-saintbridge/client": ["@ssu-saintbridge/types"],
  "@ssu-saintbridge/mock": ["@ssu-saintbridge/auth", "@ssu-saintbridge/types"],
  "@ssu-saintbridge/server": ["@ssu-saintbridge/facade"],
  "@ssu-saintbridge/cli": ["@ssu-saintbridge/facade"],
};

const readManifest = async (path: string): Promise<PackageManifest> =>
  JSON.parse(await readFile(path, "utf8")) as PackageManifest;

const workspaceDependencies = (manifest: PackageManifest): readonly string[] =>
  [
    ...new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]),
  ]
    .filter((dependency) => dependency.startsWith("@ssu-saintbridge/"))
    .sort();

export const inspectPackageGraph = async (root: string): Promise<PackageGraphFinding[]> => {
  const manifests: PackageManifest[] = [];
  for (const parent of ["packages", "apps"] as const) {
    const parentPath = join(root, parent);
    for (const entry of await readdir(parentPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      manifests.push(await readManifest(join(parentPath, entry.name, "package.json")));
    }
  }

  const findings: PackageGraphFinding[] = [];
  const packageNames = new Set(
    manifests.map(({ name }) => name).filter((name) => name !== undefined),
  );
  for (const packageName of Object.keys(workspaceDependencyPolicy)) {
    if (!packageNames.has(packageName)) {
      findings.push({
        package: packageName,
        dependency: "",
        rule: "MISSING_PACKAGE",
      });
    }
  }

  for (const manifest of manifests) {
    const packageName = manifest.name;
    if (packageName === undefined || !(packageName in workspaceDependencyPolicy)) {
      findings.push({
        package: packageName ?? "(unnamed)",
        dependency: "",
        rule: "UNEXPECTED_PACKAGE",
      });
      continue;
    }
    const expected = new Set(workspaceDependencyPolicy[packageName]);
    const actual = new Set(workspaceDependencies(manifest));
    for (const dependency of expected) {
      if (!actual.has(dependency)) {
        findings.push({ package: packageName, dependency, rule: "MISSING_DEPENDENCY" });
      }
    }
    for (const dependency of actual) {
      if (!expected.has(dependency)) {
        findings.push({ package: packageName, dependency, rule: "UNEXPECTED_DEPENDENCY" });
      }
    }
  }

  return findings.sort((left, right) =>
    `${left.package}:${left.rule}:${left.dependency}`.localeCompare(
      `${right.package}:${right.rule}:${right.dependency}`,
    ),
  );
};
