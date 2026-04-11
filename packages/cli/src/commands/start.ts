import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import qrcode from "qrcode-terminal";
import { loadConfig } from "../config.js";
import { RelayBridge } from "../relay-bridge.js";

interface RoomResponse {
  room: string;
  roomId: string;
}

async function createRoom(relayUrl: string): Promise<RoomResponse> {
  const res = await fetch(`${relayUrl}/api/room/create`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to create room: ${res.status}`);
  return (await res.json()) as RoomResponse;
}

function startBackend(port: number, config: import("../config.js").OverwatchConfig): ChildProcess {
  // Find the backend entry point relative to the CLI
  // In development: ../../src/index.ts (from packages/cli/)
  // When published: the user clones the repo and runs from root
  const possiblePaths = [
    join(process.cwd(), "src/index.ts"),
    join(process.cwd(), "dist/index.js"),
  ];

  const entryPoint = possiblePaths.find((p) => existsSync(p));
  if (!entryPoint) {
    throw new Error(
      "Cannot find backend entry point. Run this from the overwatch repo root."
    );
  }

  const child = spawn("npx", ["tsx", entryPoint], {
    env: {
      ...process.env,
      PORT: String(port),
      ...(config.deepgramApiKey && { DEEPGRAM_API_KEY: config.deepgramApiKey }),
      ...(config.cartesiaApiKey && { CARTESIA_API_KEY: config.cartesiaApiKey }),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(chalk.dim(`[backend] ${line}`));
  });

  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) console.log(chalk.dim(`[backend] ${line}`));
  });

  return child;
}

async function waitForBackend(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Backend failed to start within timeout");
}

export async function startCommand(): Promise<void> {
  const config = loadConfig();
  const port = config.backendPort ?? 8787;
  const relayUrl = config.relayUrl ?? "https://overwatch-relay.soami.workers.dev";

  console.log("");
  console.log(chalk.bold("Starting Overwatch..."));
  console.log("");

  // 1. Start backend
  process.stdout.write(`  Backend:  `);
  let backendProcess: ChildProcess;
  try {
    backendProcess = startBackend(port, config);
    await waitForBackend(port);
    console.log(chalk.green("✓") + ` running on localhost:${port}`);
  } catch (err) {
    console.log(chalk.red("✗") + ` ${err instanceof Error ? err.message : "failed"}`);
    process.exit(1);
  }

  // 2. Connect to relay
  process.stdout.write(`  Relay:    `);
  let room: RoomResponse;
  try {
    room = await createRoom(relayUrl);
    console.log(chalk.green("✓") + ` connected to relay`);
  } catch (err) {
    console.log(chalk.red("✗") + ` ${err instanceof Error ? err.message : "failed"}`);
    backendProcess.kill();
    process.exit(1);
  }

  console.log(`  Room:     ${chalk.bold(room.room)}`);
  console.log("");

  // 3. Start encrypted bridge
  const bridge = new RelayBridge({
    relayUrl,
    roomCode: room.room,
    roomId: room.roomId,
    backendPort: port,
    sttUrl: `http://localhost:${port}/api/v1/stt`,
    onPhoneConnected: () => {
      console.log(chalk.green("  ✓ Phone connected!") + chalk.dim(" (E2E encrypted)"));
      console.log("");
      console.log(chalk.dim("Overwatch is running. Press Ctrl+C to stop."));
    },
    onPhoneDisconnected: () => {
      console.log(chalk.yellow("  Phone disconnected. Waiting for reconnect..."));
    },
    onReconnecting: (target) => {
      console.log(chalk.yellow(`  ${target === "relay" ? "Relay" : "Backend"} connection lost, reconnecting...`));
    },
    onReconnected: (target) => {
      console.log(chalk.green(`  ✓ ${target === "relay" ? "Relay" : "Backend"} reconnected`));
    },
    onError: (err) => {
      console.error(chalk.red(`  Error: ${err.message}`));
    },
  });

  bridge.start();

  // 4. Show QR code
  const qrData = JSON.stringify({
    relay: relayUrl,
    room: room.room,
    hostPublicKey: bridge.publicKeyBase64,
  });

  console.log("Scan this QR code with the Overwatch app:");
  console.log("");
  qrcode.generate(qrData, { small: true }, (code: string) => {
    console.log(code);
  });
  console.log("");
  console.log(chalk.dim(`Or enter manually:`));
  console.log(chalk.dim(`  Room: ${room.room}`));
  console.log("");
  console.log("Waiting for phone to connect...");

  // Handle graceful shutdown
  const cleanup = () => {
    console.log("");
    console.log(chalk.dim("Shutting down..."));
    bridge.stop();
    backendProcess.kill();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Keep process alive
  await new Promise(() => {});
}
