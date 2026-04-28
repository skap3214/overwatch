/**
 * Walk ~/.hermes/skills/ to surface installed skills in the Overwatch UI.
 *
 * Skills are file-based: each `~/.hermes/skills/<category>/<name>/SKILL.md`
 * has YAML frontmatter and a markdown body. We parse the frontmatter only
 * (cheap), and report a flat list. Polled every 60s — skills change rarely.
 *
 * This is read-only. Editing/installing other skills is what `hermes skills`
 * and the Hermes dashboard are for.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

export interface ActiveSkill {
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  version?: string;
}

const SKILLS_ROOT = path.join(os.homedir(), ".hermes", "skills");

interface FrontmatterSnapshot {
  name?: string;
  description?: string;
  version?: string;
}

function parseFrontmatter(content: string): FrontmatterSnapshot | null {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  const block = content.slice(3, end);
  const out: FrontmatterSnapshot = {};
  for (const rawLine of block.split("\n")) {
    const m = rawLine.match(/^(name|description|version):\s*(.+?)\s*$/);
    if (!m) continue;
    let value = m[2]!;
    // strip surrounding quotes
    if (
      (value.startsWith("'") && value.endsWith("'")) ||
      (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    (out as Record<string, string>)[m[1]!] = value;
  }
  return out;
}

async function safeReadDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function listInstalledSkills(): Promise<ActiveSkill[]> {
  if (!(await isDir(SKILLS_ROOT))) return [];
  const categories = await safeReadDir(SKILLS_ROOT);
  const skills: ActiveSkill[] = [];

  for (const category of categories) {
    if (category.startsWith(".")) continue;
    const categoryDir = path.join(SKILLS_ROOT, category);
    if (!(await isDir(categoryDir))) continue;

    // The category dir might itself be a skill (a SKILL.md present), or it
    // might contain skill subdirectories. Handle both.
    const skillMdAtRoot = path.join(categoryDir, "SKILL.md");
    if (await fileExists(skillMdAtRoot)) {
      const skill = await readSkill(skillMdAtRoot, "(root)");
      if (skill) skills.push(skill);
      continue;
    }

    const entries = await safeReadDir(categoryDir);
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const skillDir = path.join(categoryDir, name);
      if (!(await isDir(skillDir))) continue;
      const skillMd = path.join(skillDir, "SKILL.md");
      if (!(await fileExists(skillMd))) continue;
      const skill = await readSkill(skillMd, category);
      if (skill) skills.push(skill);
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readSkill(skillMdPath: string, category: string): Promise<ActiveSkill | null> {
  let content: string;
  try {
    content = await fs.readFile(skillMdPath, "utf8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(content);
  if (!fm?.name) {
    // Use directory name as fallback
    const dirName = path.basename(path.dirname(skillMdPath));
    return {
      name: dirName,
      description: fm?.description ?? "",
      category,
      enabled: true,
      version: fm?.version,
    };
  }
  return {
    name: fm.name,
    description: fm.description ?? "",
    category,
    enabled: true,
    version: fm.version,
  };
}

type Events = {
  changed: [ActiveSkill[]];
};

class SkillsEmitter extends EventEmitter {
  emit<K extends keyof Events>(event: K, ...args: Events[K]): boolean {
    return super.emit(event, ...args);
  }
  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    return super.on(event, listener);
  }
  off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): this {
    return super.off(event, listener);
  }
}

export class HermesSkillsBridge {
  private readonly emitter = new SkillsEmitter();
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private latest: ActiveSkill[] = [];

  constructor(opts: { pollIntervalMs?: number } = {}) {
    this.pollIntervalMs = opts.pollIntervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    if (this.timer.unref) this.timer.unref();
    console.log(`[hermes-skills] watching ${SKILLS_ROOT}`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  list(): ActiveSkill[] {
    return this.latest;
  }

  subscribe(listener: (skills: ActiveSkill[]) => void): () => void {
    this.emitter.on("changed", listener);
    return () => this.emitter.off("changed", listener);
  }

  private async poll(): Promise<void> {
    try {
      const skills = await listInstalledSkills();
      const changed = !shallowEqualSkills(this.latest, skills);
      this.latest = skills;
      if (changed) this.emitter.emit("changed", skills);
    } catch (err) {
      console.warn(
        `[hermes-skills] poll failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}

function shallowEqualSkills(a: ActiveSkill[], b: ActiveSkill[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i]!.name !== b[i]!.name ||
      a[i]!.description !== b[i]!.description ||
      a[i]!.version !== b[i]!.version ||
      a[i]!.enabled !== b[i]!.enabled
    ) {
      return false;
    }
  }
  return true;
}
