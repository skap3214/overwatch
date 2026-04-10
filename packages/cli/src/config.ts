import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".overwatch");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface OverwatchConfig {
  deepgramApiKey?: string;
  cartesiaApiKey?: string;
  relayUrl?: string;
  backendPort?: number;
}

const DEFAULTS: OverwatchConfig = {
  relayUrl: "https://overwatch-relay.soami.workers.dev",
  backendPort: 8787,
};

export function loadConfig(): OverwatchConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    return { ...DEFAULTS, ...stored };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(config: OverwatchConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf-8");
  chmodSync(CONFIG_PATH, 0o600);
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}
