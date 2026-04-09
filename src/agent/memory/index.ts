import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const CATEGORIES = [
  "user-preferences",
  "project-context",
  "learned-behaviors",
  "feedback",
  "general",
] as const;

export type MemoryCategory = (typeof CATEGORIES)[number];

export const VALID_CATEGORIES: readonly string[] = CATEGORIES;

export function ensureMemoryDirs(memoryDir: string): void {
  for (const cat of CATEGORIES) {
    fs.mkdirSync(path.join(memoryDir, cat), { recursive: true });
  }
}

export async function loadMemories(memoryDir: string): Promise<string> {
  const sections: string[] = [];

  for (const cat of CATEGORIES) {
    const dir = path.join(memoryDir, cat);

    let files: string[];
    try {
      files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue;
    }

    if (files.length === 0) continue;

    const entries: string[] = [];
    for (const file of files) {
      const key = file.replace(/\.md$/, "");
      try {
        const content = await fsp.readFile(path.join(dir, file), "utf-8");
        entries.push(`### ${key}\n${content.trim()}`);
      } catch {
        // Skip unreadable files.
      }
    }

    if (entries.length > 0) {
      sections.push(`## ${cat}\n\n${entries.join("\n\n")}`);
    }
  }

  return sections.join("\n\n");
}
