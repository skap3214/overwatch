import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HermesAgentHarness } from "../hermes-agent.js";
import type { AgentProvider } from "./types.js";

function detect(): boolean {
  // Most reliable: gateway state file (written by `hermes gateway run`).
  // Fall back to the install dir for users who have Hermes installed but
  // not currently running.
  return (
    existsSync(join(homedir(), ".hermes", "gateway_state.json")) ||
    existsSync(join(homedir(), ".hermes", "hermes-agent"))
  );
}

export const hermesAgentProvider: AgentProvider = {
  id: "hermes",
  name: "Hermes Agent",
  tagline: "Routes to a local Hermes daemon",
  description:
    "Routes turns to a locally-running Hermes Agent gateway (Nous Research). Cron, skills, memory, and personality come from your `~/.hermes/config.yaml`.",
  capabilities: {
    hasNativeCron: true,
    hasNativeSkills: true,
    hasNativeMemory: true,
    hasSessionContinuity: true,
    emitsReasoning: true,
    voiceConvention: "soul-md",
  },
  detect,
  installInstruction: "https://github.com/NousResearch/hermes-agent",
  build: (ctx) =>
    new HermesAgentHarness({
      baseURL: ctx.hermesBaseURL,
      apiKey: ctx.hermesApiKey,
      sessionId: ctx.hermesSessionId,
      skillName: ctx.hermesSkillName,
      isVoice: ctx.isVoice,
    }),
};
