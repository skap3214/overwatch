/**
 * Gateway state — owns the daemon's pairing identity and runtime status file.
 *
 * Schema for the voice/harness-bridge overhaul:
 *   - userId:        long-lived identifier; the relay's UserChannel keys on this
 *   - pairingToken:  shared between phone, daemon, and orchestrator
 *   - relayUrl:      the relay endpoint (defaults to the hosted alpha worker)
 *
 * The legacy {room, hostPublicKey} schema is gone. Phone never connects to
 * the relay's WS; it hits POST /api/sessions/start instead, then WebRTC to
 * a Daily room. Daemon and orchestrator talk through /api/users/:userId/ws/*.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export interface GatewayStatus {
  pid: number;
  startedAt: string;
  updatedAt: string;
  relayUrl: string;
  userId: string;
  /** Daemon's local API port (mobile UI for monitor/tmux REST shims). */
  backendPort: number;
  /** True if the daemon is connected to the relay's UserChannel as host. */
  daemonRelayConnected: boolean;
  /** True if the orchestrator is currently connected on the same channel. */
  orchestratorConnected: boolean;
  lastEvent?: string;
  lastError?: string;
}

interface PairingFile {
  userId: string;
  pairingToken: string;
  createdAt: string;
}

export const DEFAULT_RELAY_URL = "https://overwatch-relay.soami.workers.dev";

export const GATEWAY_DIR = join(homedir(), ".overwatch");
export const PID_PATH = join(GATEWAY_DIR, "gateway.pid");
export const STATUS_PATH = join(GATEWAY_DIR, "gateway-status.json");
export const PAIRING_PATH = join(GATEWAY_DIR, "pairing.json");
export const LOG_DIR = join(GATEWAY_DIR, "logs");
export const GATEWAY_LOG_PATH = join(LOG_DIR, "gateway.log");
export const ERROR_LOG_PATH = join(LOG_DIR, "errors.log");

export function ensureGatewayDirs(): void {
  mkdirSync(GATEWAY_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function getRunningGatewayPid(): number | null {
  const raw = readJson<{ pid?: number }>(PID_PATH);
  const pid = raw?.pid;
  if (!pid) return null;
  if (isPidAlive(pid)) return pid;
  removePidFile();
  return null;
}

export function writePidFile(): void {
  ensureGatewayDirs();
  writeFileSync(
    PID_PATH,
    JSON.stringify(
      { pid: process.pid, startedAt: new Date().toISOString() },
      null,
      2,
    ),
    "utf-8",
  );
  chmodSync(PID_PATH, 0o600);
}

export function removePidFile(): void {
  try {
    unlinkSync(PID_PATH);
  } catch {}
}

export function readGatewayStatus(): GatewayStatus | null {
  return readJson<GatewayStatus>(STATUS_PATH);
}

export function writeGatewayStatus(status: GatewayStatus): void {
  ensureGatewayDirs();
  writeFileSync(
    STATUS_PATH,
    JSON.stringify(
      { ...status, updatedAt: new Date().toISOString() },
      null,
      2,
    ),
    "utf-8",
  );
  chmodSync(STATUS_PATH, 0o600);
}

/**
 * Load the daemon's pairing identity, generating a fresh one on first run.
 * The userId is a friendly base32-ish handle; the pairing token is a 256-bit
 * URL-safe random string.
 */
export function loadOrCreatePairing(): PairingFile {
  ensureGatewayDirs();
  const existing = readJson<PairingFile>(PAIRING_PATH);
  if (existing?.userId && existing.pairingToken) return existing;

  const fresh: PairingFile = {
    userId: generateUserId(),
    pairingToken: generatePairingToken(),
    createdAt: new Date().toISOString(),
  };
  writeFileSync(PAIRING_PATH, JSON.stringify(fresh, null, 2), "utf-8");
  chmodSync(PAIRING_PATH, 0o600);
  return fresh;
}

function generateUserId(): string {
  // Friendly readable form: USER-XXXX-XXXX (24 bits of entropy).
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  const pickFrom = (alphabet: string, n: number) =>
    Array.from(
      { length: n },
      () => alphabet[Math.floor(Math.random() * alphabet.length)],
    ).join("");
  return `USER-${pickFrom(letters, 4)}-${pickFrom(digits, 4)}`;
}

function generatePairingToken(): string {
  // 256 bits of entropy, URL-safe base64.
  return randomBytes(32)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
