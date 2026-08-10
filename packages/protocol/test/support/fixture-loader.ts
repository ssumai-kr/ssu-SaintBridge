import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const fixtureRoot = fileURLToPath(new URL("../../../../fixtures/", import.meta.url));

export const resolveFixturePath = (relativePath: string): string => {
  if (relativePath.length === 0 || isAbsolute(relativePath)) {
    throw new TypeError("Fixture paths must be non-empty and relative.");
  }

  const resolvedRoot = resolve(fixtureRoot);
  const resolvedPath = resolve(resolvedRoot, relativePath);
  const pathFromRoot = relative(resolvedRoot, resolvedPath);

  if (pathFromRoot.startsWith(`..${sep}`) || pathFromRoot === ".." || isAbsolute(pathFromRoot)) {
    throw new TypeError("Fixture path escapes the fixture root.");
  }

  return resolvedPath;
};

export const loadFixtureText = async (relativePath: string): Promise<string> =>
  readFile(resolveFixturePath(relativePath), "utf8");

export const loadFixtureJson = async (relativePath: string): Promise<unknown> =>
  JSON.parse(await loadFixtureText(relativePath)) as unknown;
