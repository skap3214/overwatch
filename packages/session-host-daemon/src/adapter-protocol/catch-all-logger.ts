/**
 * Catch-all logger — env-gated. When CATCH_ALL_LOGGER=1, every wire event from
 * each adapter gets appended to ~/.overwatch/catch-all/<provider>/<date>.jsonl
 * for offline review. Lets us discover unmapped events that should be
 * promoted from `provider_event` to a Tier-1 mapping.
 */

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export type CatchAllLogger = (event: unknown) => void;

export function createCatchAllLogger(provider: string, enabled: boolean): CatchAllLogger {
  if (!enabled) {
    return () => {};
  }
  const root = join(os.homedir(), ".overwatch", "catch-all", provider);
  mkdirSync(root, { recursive: true });

  return (event) => {
    const date = new Date().toISOString().slice(0, 10);
    const file = join(root, `${date}.jsonl`);
    try {
      appendFileSync(file, JSON.stringify({ ts: Date.now(), event }) + "\n");
    } catch {
      // Never fail the harness because of logging.
    }
  };
}
