/**
 * Single registration entry for an agent provider.
 *
 * Modelled after the `TerminalInfo[]` pattern in `packages/cli/src/commands/setup.ts`:
 * each provider is one entry in one flat list. Adding a new agent should be a
 * single new file under `src/harness/providers/` plus a one-line addition to
 * the `PROVIDERS` array in `index.ts`. Everything else (factory, mobile UI,
 * CLI commands, capabilities) reads from this registry.
 */

import type { OrchestratorHarness } from "../types.js";

export interface HarnessCapabilities {
  hasNativeCron: boolean;
  hasNativeSkills: boolean;
  hasNativeMemory: boolean;
  hasSessionContinuity: boolean;
  emitsReasoning: boolean;
  voiceConvention: "soul-md" | "instructions-prefix" | "none";
}

/**
 * Subset of AppConfig that providers may need at build time. Kept narrow on
 * purpose — providers should not reach back into the global config.
 */
export interface ProviderBuildContext {
  hermesBaseURL: string;
  hermesApiKey: string;
  hermesSessionId: string;
  hermesSkillName: string;
  isVoice: boolean;
}

export interface AgentProvider {
  /** Stable id used in env vars, settings, and protocol envelopes. */
  id: string;

  /** Human-readable name for the picker UI. */
  name: string;

  /** One-line tagline shown next to the name. */
  tagline: string;

  /** Multi-line description shown in the settings card. */
  description: string;

  /** What this provider can natively do — drives mobile UI gating. */
  capabilities: HarnessCapabilities;

  /**
   * Detection — is this provider runnable on the user's machine right now?
   * Synchronous so building the snapshot stays cheap. Implementations may
   * cache results internally.
   */
  detect(): boolean;

  /**
   * Optional install instruction shown next to the disabled provider in the
   * settings picker. CLI tooling also prints this when a provider isn't
   * available.
   */
  installInstruction?: string;

  /** Build the harness instance. Called once at backend boot. */
  build(ctx: ProviderBuildContext): OrchestratorHarness;
}

/** Shape sent over the wire — like AgentProvider but without the build fn. */
export interface AgentProviderInfo
  extends Omit<AgentProvider, "build" | "detect"> {
  installed: boolean;
}

export function summarizeProvider(provider: AgentProvider): AgentProviderInfo {
  return {
    id: provider.id,
    name: provider.name,
    tagline: provider.tagline,
    description: provider.description,
    capabilities: provider.capabilities,
    installed: provider.detect(),
    installInstruction: provider.installInstruction,
  };
}
