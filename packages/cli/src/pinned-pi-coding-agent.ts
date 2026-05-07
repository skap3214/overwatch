import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function stripRangePrefix(raw: string): string {
  return raw.replace(/^[\^~]/, "");
}

function readVersionFromPackageJson(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const pkg = JSON.parse(readFileSync(path, "utf-8")) as {
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

/**
 * Resolves the pi-coding-agent version Overwatch is built against (same source
 * as install.sh). Tries monorepo layout, installed ~/.overwatch/app, and cwd.
 */
export function getPinnedPiCodingAgentVersion(): string | undefined {
  const cliSrc = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(cliSrc, "../../session-host-daemon/package.json"),
    join(process.cwd(), "packages/session-host-daemon/package.json"),
    join(process.cwd(), "../session-host-daemon/package.json"),
    join(
      homedir(),
      ".overwatch/app/packages/session-host-daemon/package.json",
    ),
  ];
  for (const p of candidates) {
    const v = readVersionFromPackageJson(p);
    if (v) return v;
  }
  return undefined;
}

export function getPinnedPiCodingAgentGlobalInstallCommand(): string {
  const v = getPinnedPiCodingAgentVersion();
  return v
    ? `npm install -g @mariozechner/pi-coding-agent@${v}`
    : "npm install -g @mariozechner/pi-coding-agent";
}
