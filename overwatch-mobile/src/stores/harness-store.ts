import { create } from "zustand";
import type { AgentProviderInfo, HarnessCapabilities } from "../types";

const DEFAULT_CAPABILITIES: HarnessCapabilities = {
  hasNativeCron: false,
  hasNativeSkills: false,
  hasNativeMemory: true,
  hasSessionContinuity: false,
  emitsReasoning: false,
  voiceConvention: "instructions-prefix",
};

const DEFAULT_PROVIDERS: AgentProviderInfo[] = [
  {
    id: "pi-coding-agent",
    name: "pi-coding-agent",
    tagline: "Anthropic via OAuth (default)",
    description:
      "Library-based harness shipped with Overwatch. Uses Anthropic API via OAuth.",
    capabilities: DEFAULT_CAPABILITIES,
    installed: false,
  },
];

type HarnessStore = {
  active: string;
  capabilities: HarnessCapabilities;
  providers: AgentProviderInfo[];
  setSnapshot: (
    active: string,
    capabilities: HarnessCapabilities,
    providers?: AgentProviderInfo[],
  ) => void;
  /** Convenience selector — find the active provider's full info, or null. */
  activeInfo: () => AgentProviderInfo | null;
};

export const useHarnessStore = create<HarnessStore>((set, get) => ({
  active: "pi-coding-agent",
  capabilities: DEFAULT_CAPABILITIES,
  providers: DEFAULT_PROVIDERS,
  setSnapshot: (active, capabilities, providers) =>
    set({
      active,
      capabilities,
      providers: providers ?? get().providers,
    }),
  activeInfo: () => {
    const { active, providers } = get();
    return providers.find((p) => p.id === active) ?? null;
  },
}));
