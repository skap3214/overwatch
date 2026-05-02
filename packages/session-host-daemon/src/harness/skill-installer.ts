/**
 * Auto-install / auto-update the `overwatch` skill into ~/.hermes/skills/.
 *
 * The bundled skill at `.agents/skills/<name>/SKILL.md` is the source of truth.
 * On backend boot in Hermes mode, we sync it to `~/.hermes/skills/<name>/SKILL.md`:
 *   - missing → install
 *   - bundled content differs from installed → back up existing to
 *     SKILL.md.backup, then write the new version
 *   - identical → skip
 *
 * Change detection uses SHA-256 of the file contents rather than a frontmatter
 * `version` field. That keeps SKILL.md frontmatter minimal (`name` +
 * `description` only) and compatible with the `npx skills@latest` ecosystem
 * convention — and catches *any* change to the bundled skill, not just
 * version-bumped ones.
 *
 * Users who hand-edit their installed SKILL.md will see their edits preserved
 * in SKILL.md.backup after an upgrade — they can diff and merge if they want
 * their customizations back.
 */

import { promises as fs } from "node:fs";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export type SyncAction = "installed" | "updated" | "skipped" | "missing-bundle";

export interface SyncResult {
  action: SyncAction;
  skillPath: string;
  backupPath?: string;
  bundledHash?: string;
  installedHash?: string;
}

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function findRepoRoot(): string {
  // Walk upward looking for a directory containing the `.agents/skills` bundle
  // — this is the source of truth regardless of whether we're running from
  // dev (tsx, packages/session-host-daemon/src/...) or compiled
  // (packages/session-host-daemon/dist/...) layouts.
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, ".agents", "skills"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: stay close to historical behavior (parent of package).
  return path.resolve(__dirname, "..", "..", "..", "..");
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function syncOverwatchSkill(
  opts: { force?: boolean; skillName?: string } = {},
): Promise<SyncResult> {
  const skillName = opts.skillName ?? "overwatch";
  const repoRoot = findRepoRoot();
  const bundled = path.join(repoRoot, ".agents", "skills", skillName, "SKILL.md");
  const installedDir = path.join(os.homedir(), ".hermes", "skills", skillName);
  const installed = path.join(installedDir, "SKILL.md");
  const backup = path.join(installedDir, "SKILL.md.backup");

  if (!(await fileExists(bundled))) {
    return { action: "missing-bundle", skillPath: installed };
  }

  const bundledContent = await fs.readFile(bundled, "utf8");
  const bundledHash = sha256(bundledContent);

  let installedHash: string | undefined;
  let installedExists = false;
  if (await fileExists(installed)) {
    installedExists = true;
    const installedContent = await fs.readFile(installed, "utf8");
    installedHash = sha256(installedContent);
  }

  if (installedExists && installedHash === bundledHash && !opts.force) {
    return {
      action: "skipped",
      skillPath: installed,
      bundledHash,
      installedHash,
    };
  }

  await fs.mkdir(installedDir, { recursive: true });

  let backupPath: string | undefined;
  if (installedExists) {
    await fs.copyFile(installed, backup);
    backupPath = backup;
  }

  await fs.writeFile(installed, bundledContent, "utf8");

  return {
    action: installedExists ? "updated" : "installed",
    skillPath: installed,
    backupPath,
    bundledHash,
    installedHash,
  };
}

export function describeSyncResult(result: SyncResult): string {
  switch (result.action) {
    case "installed":
      return `[hermes] skill installed at ${result.skillPath}`;
    case "updated":
      return `[hermes] skill updated (backup at ${result.backupPath})`;
    case "skipped":
      return `[hermes] skill up-to-date`;
    case "missing-bundle":
      return `[hermes] skill bundle missing — skipped sync`;
  }
}
