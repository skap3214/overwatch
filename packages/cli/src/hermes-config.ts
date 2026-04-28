import { existsSync, readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  pluginPath: string;
  pluginInstalled: boolean;
  pluginEnabled: boolean;
}

const HERMES_CONFIG_PATH = path.join(os.homedir(), ".hermes", "config.yaml");
const HERMES_PID_PATH = path.join(os.homedir(), ".hermes", "gateway.pid");
const HERMES_PLUGIN_DIR = path.join(os.homedir(), ".hermes", "plugins", "overwatch");
const HERMES_ENV_PATH = path.join(os.homedir(), ".hermes", ".env");

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

function findRepoRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "cli"))) {
      return dir;
    }
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
  return start;
}

function isPluginEnabled(content: string, name: string): boolean {
  const lines = content.split("\n");
  let inPlugins = false;
  let inEnabled = false;
  let enabledIndent = 0;

  for (const raw of lines) {
    const indent = raw.match(/^( *)/)?.[1]?.length ?? 0;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (indent === 0) {
      inPlugins = trimmed === "plugins:";
      inEnabled = false;
      continue;
    }
    if (inPlugins && trimmed.startsWith("enabled")) {
      inEnabled = true;
      enabledIndent = indent;
      continue;
    }
    if (inEnabled) {
      if (trimmed.startsWith("- ")) {
        if (stripQuotes(trimmed.slice(2).trim()) === name) return true;
        continue;
      }
      if (indent <= enabledIndent) inEnabled = false;
    }
  }

  return false;
}

async function addEnabledPlugin(name: string): Promise<void> {
  const content = readHermesYamlText();
  if (!content) {
    throw new Error(`Cannot find ${HERMES_CONFIG_PATH}.`);
  }
  if (isPluginEnabled(content, name)) return;

  await fs.writeFile(`${HERMES_CONFIG_PATH}.bak`, content);

  const lines = content.split("\n");
  let inPlugins = false;
  let inEnabled = false;
  let pluginsLineIndex = -1;
  let enabledLineIndex = -1;
  let enabledIndent = 0;
  let listIndent = -1;
  let lastListItemIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const indent = raw.match(/^( *)/)?.[1]?.length ?? 0;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    if (indent === 0) {
      inPlugins = trimmed === "plugins:";
      inEnabled = false;
      if (inPlugins) pluginsLineIndex = i;
      continue;
    }
    if (inPlugins && trimmed.startsWith("enabled")) {
      inEnabled = true;
      enabledLineIndex = i;
      enabledIndent = indent;
      continue;
    }
    if (inEnabled) {
      if (trimmed.startsWith("- ")) {
        listIndent = indent;
        lastListItemIndex = i;
        continue;
      }
      if (indent <= enabledIndent) inEnabled = false;
    }
  }

  const updated = [...lines];
  if (pluginsLineIndex === -1) {
    if (updated.length > 0 && updated[updated.length - 1] !== "") updated.push("");
    updated.push("plugins:", "  enabled:", `    - ${name}`);
  } else if (enabledLineIndex === -1) {
    updated.splice(pluginsLineIndex + 1, 0, "  enabled:", `    - ${name}`);
  } else {
    const useIndent = listIndent >= 0 ? listIndent : enabledIndent + 2;
    const insertAt = lastListItemIndex === -1 ? enabledLineIndex + 1 : lastListItemIndex + 1;
    updated.splice(insertAt, 0, `${" ".repeat(useIndent)}- ${name}`);
  }

  await fs.writeFile(HERMES_CONFIG_PATH, updated.join("\n"));
}

async function mergeEnv(envPath: string, vars: Record<string, string>): Promise<void> {
  const existing = existsSync(envPath) ? await fs.readFile(envPath, "utf8") : "";
  const map = new Map<string, string>();
  for (const line of existing.split("\n")) {
    if (!line.trim()) continue;
    const equals = line.indexOf("=");
    if (equals === -1) continue;
    map.set(line.slice(0, equals), line.slice(equals + 1));
  }
  for (const [key, value] of Object.entries(vars)) {
    map.set(key, value);
  }
  await fs.mkdir(path.dirname(envPath), { recursive: true });
  await fs.writeFile(
    envPath,
    `${Array.from(map.entries()).map(([key, value]) => `${key}=${value}`).join("\n")}\n`,
  );
}

export async function enableHermesPlugin(config: OverwatchConfig): Promise<void> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidateRoots = [
    findRepoRoot(process.cwd()),
    findRepoRoot(path.resolve(moduleDir, "..", "..", "..")),
    path.join(os.homedir(), ".overwatch", "app"),
  ];
  const sourceDir = candidateRoots
    .map((root) => path.join(root, "cli", "hermes-plugin"))
    .find((candidate) => existsSync(candidate));
  if (!sourceDir) {
    throw new Error("Hermes plugin source not found.");
  }

  await fs.mkdir(path.dirname(HERMES_PLUGIN_DIR), { recursive: true });
  if (existsSync(HERMES_PLUGIN_DIR)) {
    await fs.rm(HERMES_PLUGIN_DIR, { recursive: true, force: true });
  }
  await fs.symlink(sourceDir, HERMES_PLUGIN_DIR, "dir");
  await addEnabledPlugin("overwatch");
  await mergeEnv(HERMES_ENV_PATH, {
    OVERWATCH_API_BASE: `http://127.0.0.1:${config.backendPort ?? 8787}`,
  });
}

export async function getHermesStatus(): Promise<HermesStatus> {
  const yaml = readHermesYaml();
  const { host, port } = getApiHost(yaml);
  const apiBaseURL = `http://${host}:${port}`;
  const pid = readHermesPid();
  const daemonRunning = isPidAlive(pid);
  const content = readHermesYamlText();

  return {
    configPath: HERMES_CONFIG_PATH,
    configExists: Boolean(yaml),
    daemonRunning,
    daemonPid: daemonRunning ? pid : undefined,
    apiBaseURL,
    apiReachable: daemonRunning ? await probeHealth(apiBaseURL) : false,
    apiKey: getApiKey(yaml),
    pluginPath: HERMES_PLUGIN_DIR,
    pluginInstalled: existsSync(HERMES_PLUGIN_DIR),
    pluginEnabled: isPluginEnabled(content, "overwatch"),
  };
}
