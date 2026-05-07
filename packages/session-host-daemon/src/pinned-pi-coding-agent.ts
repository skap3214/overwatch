import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DAEMON_PKG_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "package.json",
);

function stripRangePrefix(raw: string): string {
  return raw.replace(/^[\^~]/, "");
}

/** Version string from this package's dependency on @mariozechner/pi-coding-agent. */
export function getPinnedPiCodingAgentVersion(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(DAEMON_PKG_JSON, "utf-8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const raw =
      pkg.dependencies?.["@mariozechner/pi-coding-agent"] ??
      pkg.devDependencies?.["@mariozechner/pi-coding-agent"];
    return raw ? stripRangePrefix(raw) : undefined;
  } catch {
    return undefined;
  }
}

/** Global npm install line aligned with the daemon's pinned pi-coding-agent. */
export function getPinnedPiCodingAgentGlobalInstallCommand(): string {
  const v = getPinnedPiCodingAgentVersion();
  return v
    ? `npm install -g @mariozechner/pi-coding-agent@${v}`
    : "npm install -g @mariozechner/pi-coding-agent";
}
