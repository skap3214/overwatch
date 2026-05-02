import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PiCodingAgentHarness } from "../pi-coding-agent.js";
import type { AgentProvider } from "./types.js";

function detect(): boolean {
  try {
    execSync("command -v pi", { stdio: "ignore", shell: "/bin/bash" });
    return true;
  } catch {
    // fall through
  }
  return (
    existsSync(
      join(homedir(), ".overwatch", "app", "node_modules", ".bin", "pi"),
    ) ||
    existsSync(join(process.cwd(), "node_modules", ".bin", "pi"))
  );
}

export const piCodingAgentProvider: AgentProvider = {
  id: "pi-coding-agent",
  name: "pi-coding-agent",
  tagline: "Anthropic via OAuth (default)",
  description:
    "Library-based harness shipped with Overwatch. Uses the Anthropic API via OAuth (`~/.pi/agent/auth.json`). Lightweight, no external daemon required.",
  capabilities: {
    hasNativeCron: false,
    hasNativeSkills: false,
    hasNativeMemory: true,
    hasSessionContinuity: false,
    emitsReasoning: false,
    voiceConvention: "instructions-prefix",
  },
  detect,
  installInstruction: "npm install -g @mariozechner/pi-coding-agent",
  build: () => new PiCodingAgentHarness(),
};
