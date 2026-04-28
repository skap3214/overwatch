import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type SkillsSetupMode = "on" | "off";

export interface SkillInstallResult {
  name: string;
  source: string;
  ok: boolean;
  error?: string;
}

const REMOTE_REPO = "skap3214/overwatch";
const OVERWATCH_SKILL_NAME = "overwatch";
const OVERWATCH_SKILL_SEGMENTS = [".agents", "skills", OVERWATCH_SKILL_NAME];

function findRepoRoot(start: string): string | undefined {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (
      existsSync(path.join(dir, "package.json")) &&
      existsSync(path.join(dir, ".agents", "skills"))
    ) {
      return dir;
    }
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return undefined;
}

function getCandidateRepoRoots(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    findRepoRoot(process.cwd()),
    findRepoRoot(path.resolve(moduleDir, "..", "..", "..")),
    path.join(os.homedir(), ".overwatch", "app"),
  ].filter((root): root is string => Boolean(root));
}

function resolveSkillSource(): string {
  const localSource = getCandidateRepoRoots()
    .map((root) => path.join(root, ...OVERWATCH_SKILL_SEGMENTS))
    .find((candidate) => existsSync(path.join(candidate, "SKILL.md")));

  return localSource ?? `${REMOTE_REPO}/.agents/skills/${OVERWATCH_SKILL_NAME}`;
}

export function normalizeSkillsSetupMode(value: string | undefined): SkillsSetupMode {
  const normalized = (value ?? "on").trim().toLowerCase();
  if (normalized === "on") return "on";
  if (normalized === "off") return "off";
  throw new Error(`Unknown skills mode "${value}". Use "on" or "off".`);
}

export function installOverwatchSkills(): SkillInstallResult[] {
  const source = resolveSkillSource();

  try {
    execFileSync(
      "npx",
      [
        "--yes",
        "skills@latest",
        "add",
        source,
        "--global",
        "--all",
        "--copy",
      ],
      { stdio: "inherit" },
    );
    return [{ name: OVERWATCH_SKILL_NAME, source, ok: true }];
  } catch (error) {
    return [
      {
        name: OVERWATCH_SKILL_NAME,
        source,
        ok: false,
        error: error instanceof Error ? error.message : "unknown error",
      },
    ];
  }
}
