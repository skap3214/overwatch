import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OverwatchConfig } from "./config.js";

interface HermesYaml {
  platforms?: {
    api_server?: {
      enabled?: boolean;
      extra?: { host?: string; port?: number | string; key?: string };
    };
  };
  [key: string]: unknown;
}

export interface HermesStatus {
  configPath: string;
  configExists: boolean;
  daemonRunning: boolean;
  daemonPid?: number;
  apiBaseURL: string;
  apiReachable: boolean;
  apiKey?: string;
}

const HERMES_CONFIG_PATH = path.join(os.homedir(), ".hermes", "config.yaml");
const HERMES_PID_PATH = path.join(os.homedir(), ".hermes", "gateway.pid");
const HERMES_PLUGIN_DIR = path.join(os.homedir(), ".hermes", "plugins", "overwatch");

function stripQuotes(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseHermesYaml(content: string): HermesYaml {
  const out: HermesYaml = {};
  const stack: { indent: number; obj: Record<string, unknown> }[] = [
    { indent: -1, obj: out },
  ];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (line.trim().startsWith("- ")) continue;

    const indent = line.match(/^( *)/)?.[1]?.length ?? 0;
    const trimmed = line.trim();
    const colon = trimmed.indexOf(":");
    if (colon === -1) continue;

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }

    const key = trimmed.slice(0, colon).trim();
    const valueRaw = trimmed.slice(colon + 1).trim();
    const top = stack[stack.length - 1]!;
    if (!valueRaw) {
      const obj: Record<string, unknown> = {};
      top.obj[key] = obj;
      stack.push({ indent, obj });
    } else {
      top.obj[key] = stripQuotes(valueRaw);
    }
  }

  return out;
}

function readHermesYaml(): HermesYaml | null {
  if (!existsSync(HERMES_CONFIG_PATH)) return null;
  try {
    return parseHermesYaml(readFileSync(HERMES_CONFIG_PATH, "utf8"));
  } catch {
    return null;
  }
}

function readHermesYamlText(): string {
  if (!existsSync(HERMES_CONFIG_PATH)) return "";
  return readFileSync(HERMES_CONFIG_PATH, "utf8");
}

function getApiKey(yaml: HermesYaml | null): string | undefined {
  return yaml?.platforms?.api_server?.extra?.key;
}

function getApiHost(yaml: HermesYaml | null): { host: string; port: number } {
  const extra = yaml?.platforms?.api_server?.extra ?? {};
  return {
    host: extra.host ?? "127.0.0.1",
    port: Number.parseInt(String(extra.port ?? 8642), 10),
  };
}

function readHermesPid(): number | undefined {
  if (!existsSync(HERMES_PID_PATH)) return undefined;
  try {
    const raw = readFileSync(HERMES_PID_PATH, "utf8").trim();
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as { pid?: number };
      return typeof parsed.pid === "number" ? parsed.pid : undefined;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isInteger(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function probeHealth(baseURL: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

export function configureHermesHarnessConfig(
  config: OverwatchConfig,
): OverwatchConfig {
  const yaml = readHermesYaml();
  if (!yaml) {
    throw new Error(
      `Could not find ${HERMES_CONFIG_PATH}. Install and initialize Hermes first.`,
    );
  }

  const apiKey = getApiKey(yaml);
  if (!apiKey) {
    throw new Error(
      `${HERMES_CONFIG_PATH} has no platforms.api_server.extra.key.`,
    );
  }

  const { host, port } = getApiHost(yaml);
  return {
    ...config,
    harness: "hermes",
    hermes: {
      baseURL: `http://${host}:${port}`,
      apiKey,
      sessionId: config.hermes?.sessionId ?? `overwatch-${os.hostname()}`,
      skillName: config.hermes?.skillName ?? "overwatch",
    },
  };
}

function removeEnabledPlugin(content: string, name: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let inPlugins = false;
  let inEnabled = false;
  let enabledIndent = 0;
  let changed = false;

  for (const raw of lines) {
    const indent = raw.match(/^( *)/)?.[1]?.length ?? 0;
    const trimmed = raw.trim();

    if (trimmed && !trimmed.startsWith("#")) {
      if (indent === 0) {
        inPlugins = trimmed === "plugins:";
        inEnabled = false;
      } else if (inPlugins && trimmed.startsWith("enabled")) {
        inEnabled = true;
        enabledIndent = indent;
      } else if (inEnabled && indent <= enabledIndent && !trimmed.startsWith("- ")) {
        inEnabled = false;
      }
    }

    if (inEnabled && trimmed.startsWith("- ") && stripQuotes(trimmed.slice(2).trim()) === name) {
      changed = true;
      continue;
    }
    out.push(raw);
  }

  return changed ? out.join("\n") : content;
}

function removeEnvVar(content: string, key: string): string {
  const lines = content.split("\n");
  const next = lines.filter((line) => {
    const trimmed = line.trim();
    return !trimmed.startsWith(`${key}=`);
  });
  return next.join("\n");
}

export async function disableHermesPlugin(): Promise<boolean> {
  let changed = false;
  const configText = readHermesYamlText();
  if (configText) {
    const updated = removeEnabledPlugin(configText, "overwatch");
    if (updated !== configText) {
      await fs.writeFile(`${HERMES_CONFIG_PATH}.bak`, configText);
      await fs.writeFile(HERMES_CONFIG_PATH, updated);
      changed = true;
    }
  }

  const envPath = path.join(os.homedir(), ".hermes", ".env");
  if (existsSync(envPath)) {
    const envText = readFileSync(envPath, "utf8");
    const updated = removeEnvVar(envText, "OVERWATCH_API_BASE");
    if (updated !== envText) {
      await fs.writeFile(envPath, updated);
      changed = true;
    }
  }

  if (existsSync(HERMES_PLUGIN_DIR)) {
    await fs.rm(HERMES_PLUGIN_DIR, { recursive: true, force: true });
    changed = true;
  }

  return changed;
}

export async function getHermesStatus(): Promise<HermesStatus> {
  const yaml = readHermesYaml();
  const { host, port } = getApiHost(yaml);
  const apiBaseURL = `http://${host}:${port}`;
  const pid = readHermesPid();
  const daemonRunning = isPidAlive(pid);

  return {
    configPath: HERMES_CONFIG_PATH,
    configExists: Boolean(yaml),
    daemonRunning,
    daemonPid: daemonRunning ? pid : undefined,
    apiBaseURL,
    apiReachable: daemonRunning ? await probeHealth(apiBaseURL) : false,
    apiKey: getApiKey(yaml),
  };
}
