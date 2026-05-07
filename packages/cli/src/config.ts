import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_DIR = join(homedir(), ".overwatch");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface OverwatchConfig {
  deepgramApiKey?: string;
  cartesiaApiKey?: string;
  xaiApiKey?: string;
  sttProvider?: "deepgram" | "xai";
  ttsProvider?: "cartesia" | "xai";
  sttModel?: string;
  ttsModel?: string;
  relayUrl?: string;
  backendPort?: number;
  gateway?: {
    enabled?: boolean;
    stableRoom?: boolean;
  };
  /** Which harness to run. Default = pi-coding-agent. */
  harness?: "pi-coding-agent" | "claude-code-cli" | "hermes";
  hermes?: {
    baseURL?: string;
    apiKey?: string;
    sessionId?: string;
    skillName?: string;
  };
}

const DEFAULTS: OverwatchConfig = {
  relayUrl: "https://overwatch-relay.soami.workers.dev",
  backendPort: 8787,
  sttProvider: "deepgram",
  ttsProvider: "cartesia",
  gateway: {
    enabled: false,
    stableRoom: true,
  },
};

export function loadConfig(): OverwatchConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    const stored = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    const sttProvider =
      stored.sttProvider === "deepgram" || stored.sttProvider === "xai"
        ? stored.sttProvider
        : DEFAULTS.sttProvider;
    const ttsProvider =
      stored.ttsProvider === "xai" || stored.ttsProvider === "cartesia"
        ? stored.ttsProvider
        : DEFAULTS.ttsProvider;
    return {
      ...DEFAULTS,
      ...stored,
      sttProvider,
      ttsProvider,
      gateway: { ...DEFAULTS.gateway, ...stored.gateway },
    };
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
