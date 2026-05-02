import { execSync } from "node:child_process";
import { ClaudeCodeCliHarness } from "../claude-code-cli.js";
import type { AgentProvider } from "./types.js";

function detect(): boolean {
  try {
    execSync("command -v claude", { stdio: "ignore", shell: "/bin/bash" });
    return true;
  } catch {
    return false;
  }
}

export const claudeCodeCliProvider: AgentProvider = {
  id: "claude-code-cli",
  name: "Claude Code CLI",
  tagline: "Spawns the `claude` CLI subprocess",
  description:
    "Wraps the official Claude Code CLI as a subprocess. Mirrors the desktop CLI experience exactly. Requires `claude` on PATH.",
  capabilities: {
    hasNativeCron: false,
    hasNativeSkills: true,
    hasNativeMemory: false,
    hasSessionContinuity: true,
    emitsReasoning: false,
    voiceConvention: "instructions-prefix",
  },
  detect,
  installInstruction: "https://claude.com/claude-code",
  build: () => new ClaudeCodeCliHarness(),
};
