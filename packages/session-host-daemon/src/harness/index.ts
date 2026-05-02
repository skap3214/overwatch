/**
 * Harness factory — selects an OrchestratorHarness implementation by provider id.
 *
 * Adding a new provider: drop a new file under `src/harness/providers/` and
 * register it in `src/harness/providers/index.ts`. This factory needs no
 * changes; it dispatches via the registry.
 */

import os from "node:os";
import type { OrchestratorHarness } from "./types.js";
import { getProvider } from "./providers/index.js";
import type { ProviderBuildContext } from "./providers/types.js";

export interface MakeHarnessOptions {
  provider: string;
  hermes?: {
    baseURL: string;
    apiKey: string;
    sessionId?: string;
    skillName?: string;
    isVoice?: boolean;
  };
}

export function makeHarness(opts: MakeHarnessOptions): OrchestratorHarness {
  const provider = getProvider(opts.provider);
  const ctx: ProviderBuildContext = {
    hermesBaseURL: opts.hermes?.baseURL ?? "http://127.0.0.1:8642",
    hermesApiKey: opts.hermes?.apiKey ?? "",
    hermesSessionId:
      opts.hermes?.sessionId ?? `overwatch-${os.hostname()}`,
    hermesSkillName: opts.hermes?.skillName ?? "overwatch",
    isVoice: opts.hermes?.isVoice ?? true,
  };
  return provider.build(ctx);
}
