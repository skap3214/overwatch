/**
 * Gateway runtime — supervises the session-host daemon process.
 *
 * Post-overhaul shape:
 *   - The daemon (packages/session-host-daemon) speaks adapter-protocol to the
 *     orchestrator over the relay's UserChannel. No RelayBridge in this
 *     process anymore.
 *   - This runtime just spawns the daemon binary, hands it the user identity
 *     + pairing token via env, and watches it.
 *
 * The legacy in-process audio bridge (RelayBridge → phone↔daemon WS) is gone.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import qrcode from "qrcode-terminal";
import { loadConfig, type OverwatchConfig } from "./config.js";
import {
  DEFAULT_RELAY_URL,
  ERROR_LOG_PATH,
  GATEWAY_LOG_PATH,
  LOG_DIR,
  getRunningGatewayPid,
  loadOrCreatePairing,
  removePidFile,
  writeGatewayStatus,
  writePidFile,
  type GatewayStatus,
} from "./gateway-state.js";

export interface GatewayRunOptions {
  replace?: boolean;
  foreground?: boolean;
  printPairing?: boolean;
}

export function printPairingDetails(userId: string, qrData: string): void {
  console.log("Scan this QR code with the Overwatch app:");
  console.log("");
  qrcode.generate(qrData, { small: true }, (code: string) => {
    console.log(code);
  });
  console.log("");
  console.log(chalk.dim("Or pair manually with:"));
  console.log(chalk.dim(`  user_id: ${userId}`));
}

function findDaemonRoot(): string {
  // Resolve via the CLI's own location so installed copies still find the
  // session-host-daemon package next to it.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // dev: packages/cli/src/gateway-runtime.ts → packages/session-host-daemon
    resolve(here, "..", "..", "session-host-daemon"),
    // installed: packages/cli/dist/gateway-runtime.js → packages/session-host-daemon
    resolve(here, "..", "..", "session-host-daemon"),
    // monorepo root fallback
    resolve(process.cwd(), "packages", "session-host-daemon"),
    // installed monorepo: ~/.overwatch/app/packages/session-host-daemon
    join(homedir(), ".overwatch", "app", "packages", "session-host-daemon"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "src", "index.ts")) || existsSync(join(c, "dist", "index.js"))) {
      return c;
    }
  }
  throw new Error(
    "Cannot find session-host-daemon. Reinstall with the standard installer.",
  );
}

function logLine(path: string, line: string): void {
  mkdirSync(LOG_DIR, { recursive: true });
  appendFileSync(path, `${new Date().toISOString()} ${line}\n`, "utf-8");
}

function startDaemon(
  port: number,
  config: OverwatchConfig,
  pairing: { userId: string; pairingToken: string },
  relayUrl: string,
  foreground: boolean,
): ChildProcess {
  const root = findDaemonRoot();
  const entry = existsSync(join(root, "src", "index.ts"))
    ? join(root, "src", "index.ts")
    : join(root, "dist", "index.js");

  const harnessEnv: Record<string, string> = {};
  if (config.harness) {
    harnessEnv.HARNESS_PROVIDER = config.harness;
  }
  if (config.harness === "hermes" && config.hermes) {
    if (config.hermes.baseURL) harnessEnv.HERMES_BASE_URL = config.hermes.baseURL;
    if (config.hermes.apiKey) harnessEnv.HERMES_API_KEY = config.hermes.apiKey;
    if (config.hermes.sessionId) harnessEnv.HERMES_SESSION_ID = config.hermes.sessionId;
    if (config.hermes.skillName) harnessEnv.HERMES_SKILL_NAME = config.hermes.skillName;
  }

  const child = spawn("npx", ["tsx", entry], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      RELAY_URL: relayUrl,
      OVERWATCH_USER_ID: pairing.userId,
      ORCHESTRATOR_PAIRING_TOKEN: pairing.pairingToken,
      ...harnessEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (!text) return;
    logLine(GATEWAY_LOG_PATH, `[daemon] ${text}`);
    if (foreground) console.log(chalk.dim(`[daemon] ${text}`));
  });

  child.stderr?.on("data", (data: Buffer) => {
    const text = data.toString().trim();
    if (!text) return;
    logLine(ERROR_LOG_PATH, `[daemon] ${text}`);
    if (foreground) console.log(chalk.dim(`[daemon] ${text}`));
  });

  return child;
}

async function daemonHealthy(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForDaemon(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await daemonHealthy(port)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Daemon failed to start within timeout");
}

function terminatePid(pid: number): void {
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
}

async function replaceExistingGatewayIfNeeded(replace: boolean): Promise<void> {
  const existingPid = getRunningGatewayPid();
  if (!existingPid || existingPid === process.pid) return;
  if (!replace) {
    throw new Error(
      `Gateway already running (PID ${existingPid}). Use 'overwatch gateway restart'.`,
    );
  }
  terminatePid(existingPid);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!getRunningGatewayPid()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    process.kill(existingPid, "SIGKILL");
  } catch {}
}

export async function runGateway(options: GatewayRunOptions = {}): Promise<void> {
  const foreground = options.foreground ?? false;
  const config = loadConfig();
  const port = config.backendPort ?? 8787;
  const relayUrl = config.relayUrl ?? DEFAULT_RELAY_URL;
  const pairing = loadOrCreatePairing();

  await replaceExistingGatewayIfNeeded(options.replace ?? false);
  writePidFile();

  const startedAt = new Date().toISOString();
  let daemonProcess: ChildProcess | null = null;

  const status: GatewayStatus = {
    pid: process.pid,
    startedAt,
    updatedAt: startedAt,
    relayUrl,
    userId: pairing.userId,
    backendPort: port,
    daemonRelayConnected: false,
    orchestratorConnected: false,
    lastEvent: "starting",
  };
  const updateStatus = (patch: Partial<GatewayStatus>) => {
    Object.assign(status, patch);
    writeGatewayStatus(status);
  };
  updateStatus({});

  const log = (line: string) => {
    logLine(GATEWAY_LOG_PATH, line);
    if (foreground) console.log(line);
  };

  try {
    if (await daemonHealthy(port)) {
      updateStatus({ lastEvent: "using existing daemon" });
      log(`[gateway] daemon already healthy on localhost:${port}`);
    } else {
      daemonProcess = startDaemon(port, config, pairing, relayUrl, foreground);
      await waitForDaemon(port);
      updateStatus({ lastEvent: "daemon started" });
      log(`[gateway] daemon running on localhost:${port}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "daemon failed";
    updateStatus({ lastError: message, lastEvent: "daemon failed" });
    removePidFile();
    throw err;
  }

  // Best-effort: poll the relay's user-channel for orchestrator connectivity.
  const pollChannel = async () => {
    try {
      const res = await fetch(
        `${relayUrl}/api/users/${encodeURIComponent(pairing.userId)}/info`,
      );
      if (!res.ok) return;
      const info = (await res.json()) as {
        host_connected?: boolean;
        orchestrator_connected?: boolean;
      };
      updateStatus({
        daemonRelayConnected: Boolean(info.host_connected),
        orchestratorConnected: Boolean(info.orchestrator_connected),
      });
    } catch {
      // ignore
    }
  };
  void pollChannel();
  const pollInterval = setInterval(pollChannel, 5000).unref();

  const qrData = JSON.stringify({
    r: relayUrl,
    u: pairing.userId,
    t: pairing.pairingToken,
  });
  if (options.printPairing ?? foreground) {
    printPairingDetails(pairing.userId, qrData);
    console.log(chalk.dim("Waiting for phone to connect..."));
  }

  const cleanup = () => {
    updateStatus({
      lastEvent: "stopping",
      daemonRelayConnected: false,
      orchestratorConnected: false,
    });
    clearInterval(pollInterval);
    daemonProcess?.kill();
    removePidFile();
  };

  process.once("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.once("exit", cleanup);

  await new Promise(() => {});
}
