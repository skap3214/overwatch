/**
 * Agent provider registry.
 *
 * To add a new agent: drop a new file in this directory exporting an
 * `AgentProvider`, then append it to the `PROVIDERS` array below. That's it —
 * the factory, mobile UI, settings picker, CLI status, and capability gating
 * all read from this list.
 *
 * Mirrors the `detectTerminals()` pattern in setup.ts.
 */

import { piCodingAgentProvider } from "./pi-coding-agent.js";
import { claudeCodeCliProvider } from "./claude-code-cli.js";
import { hermesAgentProvider } from "./hermes.js";
import {
  summarizeProvider,
  type AgentProvider,
  type AgentProviderInfo,
} from "./types.js";

export const PROVIDERS: AgentProvider[] = [
  piCodingAgentProvider,
  claudeCodeCliProvider,
  hermesAgentProvider,
];

export const DEFAULT_PROVIDER_ID = "pi-coding-agent";

export function getProvider(id: string | undefined): AgentProvider {
  return (
    PROVIDERS.find((p) => p.id === id) ??
    PROVIDERS.find((p) => p.id === DEFAULT_PROVIDER_ID)!
  );
}

export function listProviders(): AgentProviderInfo[] {
  return PROVIDERS.map(summarizeProvider);
}

export function listProviderIds(): string[] {
  return PROVIDERS.map((p) => p.id);
}

export type { AgentProvider, AgentProviderInfo } from "./types.js";
export type { HarnessCapabilities, ProviderBuildContext } from "./types.js";
