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
import { generateKeyPair, fromBase64, toBase64, type KeyPair } from "./crypto.js";

export interface GatewayStatus {
  pid: number;
  startedAt: string;
  updatedAt: string;
  relayUrl: string;
  room: string;
  hostPublicKey: string;
  backendPort: number;
  backendConnected: boolean;
  relayConnected: boolean;
  phoneConnected: boolean;
  lastEvent?: string;
  lastError?: string;
}

interface HostIdentityFile {
  publicKey: string;
  secretKey: string;
}

interface PairingFile {
  room: string;
  createdAt: string;
}

export const GATEWAY_DIR = join(homedir(), ".overwatch");
export const PID_PATH = join(GATEWAY_DIR, "gateway.pid");
export const STATUS_PATH = join(GATEWAY_DIR, "gateway-status.json");
export const HOST_IDENTITY_PATH = join(GATEWAY_DIR, "host-key.json");
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
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }, null, 2),
    "utf-8"
  );
  chmodSync(PID_PATH, 0o600);
}

export function removePidFile(): void {
  try { unlinkSync(PID_PATH); } catch {}
}

export function readGatewayStatus(): GatewayStatus | null {
  return readJson<GatewayStatus>(STATUS_PATH);
}

export function writeGatewayStatus(status: GatewayStatus): void {
  ensureGatewayDirs();
  writeFileSync(
    STATUS_PATH,
    JSON.stringify({ ...status, updatedAt: new Date().toISOString() }, null, 2),
    "utf-8"
  );
  chmodSync(STATUS_PATH, 0o600);
}

export function loadOrCreateHostIdentity(): KeyPair {
  ensureGatewayDirs();
  const existing = readJson<HostIdentityFile>(HOST_IDENTITY_PATH);
  if (existing?.publicKey && existing.secretKey) {
    return {
      publicKey: fromBase64(existing.publicKey),
      secretKey: fromBase64(existing.secretKey),
    };
  }

  const keyPair = generateKeyPair();
  writeFileSync(
    HOST_IDENTITY_PATH,
    JSON.stringify(
      {
        publicKey: toBase64(keyPair.publicKey),
        secretKey: toBase64(keyPair.secretKey),
      },
      null,
      2
    ),
    "utf-8"
  );
  chmodSync(HOST_IDENTITY_PATH, 0o600);
  return keyPair;
}

function generateRoomCode(): string {
  const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const digits = "23456789";
  let prefix = "";
  let suffix = "";
  for (let i = 0; i < 4; i++) prefix += letters[Math.floor(Math.random() * letters.length)];
  for (let i = 0; i < 4; i++) suffix += digits[Math.floor(Math.random() * digits.length)];
  return `${prefix}-${suffix}`;
}

export function loadOrCreatePairingRoom(): string {
  ensureGatewayDirs();
  const existing = readJson<PairingFile>(PAIRING_PATH);
  if (existing?.room && /^[A-Z0-9]+-[A-Z0-9]+$/.test(existing.room)) {
    return existing.room;
  }

  const room = generateRoomCode();
  writeFileSync(
    PAIRING_PATH,
    JSON.stringify({ room, createdAt: new Date().toISOString() }, null, 2),
    "utf-8"
  );
  chmodSync(PAIRING_PATH, 0o600);
  return room;
}

export function createEphemeralRoom(): string {
  return generateRoomCode();
}
