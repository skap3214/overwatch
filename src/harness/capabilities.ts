/**
 * Compatibility re-exports for the older `capabilities` API. The source of
 * truth for capabilities is each provider's entry in
 * `src/harness/providers/`. New code should import from there.
 */

import { getProvider } from "./providers/index.js";

export type { HarnessCapabilities } from "./providers/types.js";

export function getCapabilities(providerId: string) {
  return getProvider(providerId).capabilities;
}

/**
 * Back-compat: expose CAPABILITIES as a record built from the registry.
 * Prefer importing from `./providers/` instead.
 */
import { PROVIDERS } from "./providers/index.js";
import type { HarnessCapabilities } from "./providers/types.js";

export const CAPABILITIES: Record<string, HarnessCapabilities> = Object.fromEntries(
  PROVIDERS.map((p) => [p.id, p.capabilities]),
);
