import { resolvePackagePath } from "../../src/config/package-paths";

/** Reads the version from the installed package manifest. */
export async function readInstalledVersion(): Promise<string> {
  const metadata: unknown = await Bun.file(resolvePackagePath("package.json")).json();
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    !("version" in metadata) ||
    typeof metadata.version !== "string"
  ) {
    throw new Error("Cartethyia package version is unavailable");
  }
  return metadata.version;
}

/** Asks the npm registry for the newest published version, or null on failure. */
export async function readLatestPublishedVersion(): Promise<string | null> {
  try {
    const response = await fetch("https://registry.npmjs.org/cartethyia/latest", {
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) return null;
    const metadata: unknown = await response.json();
    if (
      metadata !== null &&
      typeof metadata === "object" &&
      "version" in metadata &&
      typeof metadata.version === "string"
    ) {
      return metadata.version;
    }
    return null;
  } catch {
    return null;
  }
}
