import fsp from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  ensureMemoryDirs,
  loadMemories,
  VALID_CATEGORIES,
} from "../agent/memory/index.js";

const MEMORY_DIR = path.join(homedir(), ".overwatch", "memory");

function ok(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

export function memoryExtension() {
  return (pi: ExtensionAPI) => {
    pi.on("session_start", () => {
      ensureMemoryDirs(MEMORY_DIR);
    });

    pi.on("before_agent_start", async (event) => {
      const memories = await loadMemories(MEMORY_DIR);
      if (!memories) return;
      return {
        systemPrompt:
          event.systemPrompt +
          `\n\n## Persistent Memory\n\n${memories}`,
      };
    });

    pi.registerTool({
      name: "memory_read",
      label: "Memory Read",
      description: "List persistent memories, optionally filtered by category.",
      promptSnippet: "Read persistent memory.",
      parameters: Type.Object({
        category: Type.Optional(
          Type.String({
            description:
              "Category filter: user-preferences, project-context, learned-behaviors, feedback, general.",
          })
        ),
      }),
      async execute(_toolCallId, params) {
        const categories = params.category
          ? [params.category]
          : [...VALID_CATEGORIES];

        if (params.category && !VALID_CATEGORIES.includes(params.category)) {
          throw new Error(
            `Invalid category: ${params.category}. Must be one of: ${VALID_CATEGORIES.join(", ")}`
          );
        }

        const lines: string[] = [];
        for (const cat of categories) {
          const dir = path.join(MEMORY_DIR, cat);
          let files: string[];
          try {
            files = (await fsp.readdir(dir))
              .filter((f) => f.endsWith(".md"))
              .sort();
          } catch {
            continue;
          }

          for (const file of files) {
            const key = file.replace(/\.md$/, "");
            try {
              const content = await fsp.readFile(path.join(dir, file), "utf-8");
              const preview =
                content.trim().split("\n")[0]?.slice(0, 100) ?? "";
              lines.push(`[${cat}] ${key}: ${preview}`);
            } catch {
              lines.push(`[${cat}] ${key}: (unreadable)`);
            }
          }
        }

        return ok(lines.length === 0 ? "No memories found." : lines.join("\n"));
      },
    });

    pi.registerTool({
      name: "memory_write",
      label: "Memory Write",
      description: "Save a persistent memory to a category.",
      promptSnippet: "Write persistent memory.",
      parameters: Type.Object({
        key: Type.String({
          description: "Name for the memory, without the .md extension.",
        }),
        category: Type.String({
          description:
            "Category: user-preferences, project-context, learned-behaviors, feedback, general.",
        }),
        content: Type.String({
          description: "The memory content in markdown.",
        }),
      }),
      async execute(_toolCallId, params) {
        if (!VALID_CATEGORIES.includes(params.category)) {
          throw new Error(
            `Invalid category: ${params.category}. Must be one of: ${VALID_CATEGORIES.join(", ")}`
          );
        }

        const safeKey = path.basename(params.key.replace(/\.md$/, ""));
        if (!safeKey || safeKey === "." || safeKey === "..") {
          throw new Error(`Invalid key: ${params.key}`);
        }

        const dir = path.join(MEMORY_DIR, params.category);
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(
          path.join(dir, `${safeKey}.md`),
          params.content,
          "utf-8"
        );

        return ok(`Memory saved: [${params.category}] ${safeKey}`);
      },
    });

    pi.registerTool({
      name: "memory_delete",
      label: "Memory Delete",
      description: "Delete a persistent memory by key and category.",
      promptSnippet: "Delete persistent memory.",
      parameters: Type.Object({
        key: Type.String({
          description: "The memory key to delete.",
        }),
        category: Type.String({
          description:
            "Category: user-preferences, project-context, learned-behaviors, feedback, general.",
        }),
      }),
      async execute(_toolCallId, params) {
        if (!VALID_CATEGORIES.includes(params.category)) {
          throw new Error(
            `Invalid category: ${params.category}. Must be one of: ${VALID_CATEGORIES.join(", ")}`
          );
        }

        const safeKey = path.basename(params.key.replace(/\.md$/, ""));
        const filePath = path.join(MEMORY_DIR, params.category, `${safeKey}.md`);

        try {
          await fsp.unlink(filePath);
          return ok(`Memory deleted: [${params.category}] ${safeKey}`);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return ok(`Memory not found: [${params.category}] ${safeKey}`);
          }
          throw err;
        }
      },
    });
  };
}
