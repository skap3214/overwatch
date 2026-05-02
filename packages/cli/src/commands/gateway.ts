import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import chalk from "chalk";
import {
  ERROR_LOG_PATH,
  GATEWAY_LOG_PATH,
  LOG_DIR,
  getRunningGatewayPid,
  loadOrCreatePairing,
  readGatewayStatus,
  type GatewayStatus,
} from "../gateway-state.js";
import { printPairingDetails, runGateway } from "../gateway-runtime.js";

const LAUNCHD_LABEL = "dev.overwatch.gateway";

function cliRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

function repoOrPackageRoot(): string {
  const root = cliRoot();
  if (root.endsWith("/dist")) return resolve(root, "..");
  if (root.endsWith("/src")) return resolve(root, "..");
  return root;
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
}

function programArguments(): string[] {
  const root = repoOrPackageRoot();
  const distEntry = join(root, "dist", "index.js");
  const srcEntry = join(root, "src", "index.ts");
  if (existsSync(distEntry)) {
    return [process.execPath, distEntry, "gateway", "run", "--replace", "--service"];
  }
  return ["npx", "tsx", srcEntry, "gateway", "run", "--replace", "--service"];
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateLaunchdPlist(): string {
  const args = programArguments()
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join("\n");
  const cwd = repoOrPackageRoot();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(cwd)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(GATEWAY_LOG_PATH)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(ERROR_LOG_PATH)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(homedir())}</string>
    <key>PATH</key>
    <string>${xmlEscape(process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")}</string>
  </dict>
</dict>
</plist>
`;
}

function runLaunchctl(args: string[], check = true): void {
  const result = spawnSync("launchctl", args, { stdio: check ? "pipe" : "ignore", encoding: "utf-8" });
  if (check && result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(`launchctl ${args.join(" ")} failed: ${detail}`);
  }
}

function requireMacos(): void {
  if (platform() !== "darwin") {
    throw new Error("Background service install is currently implemented for macOS launchd only.");
  }
}

function launchdTarget(): string {
  return `gui/${userInfo().uid}`;
}

function qrPayload(
  status: GatewayStatus,
  pairing: { userId: string; pairingToken: string },
): string {
  // Pairing payload for the voice/harness-bridge overhaul:
  //   r = relay URL (the phone POSTs to /api/sessions/start here)
  //   u = userId    (used by phone, daemon, and orchestrator to identify a channel)
  //   t = pairingToken (long-term shared secret; phone derives a per-session HMAC)
  return JSON.stringify({
    r: status.relayUrl,
    u: pairing.userId,
    t: pairing.pairingToken,
  });
}

function statusIsFresh(
  status: GatewayStatus | null,
  since: number,
): status is GatewayStatus {
  if (!status?.userId) return false;
  const updatedAt = Date.parse(status.updatedAt);
  return Number.isFinite(updatedAt) && updatedAt >= since - 1000;
}

async function waitForGatewayInfo(since: number, timeoutMs = 10000): Promise<GatewayStatus | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = readGatewayStatus();
    if (statusIsFresh(status, since)) return status;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return readGatewayStatus();
}

export function printGatewayInfo(status = readGatewayStatus()): boolean {
  const pid = getRunningGatewayPid();
  console.log("");
  if (!status?.userId) {
    console.log(chalk.red("No gateway pairing information found yet."));
    console.log(
      chalk.dim(
        "Run `overwatch gateway start` first, then retry `overwatch gateway info`.",
      ),
    );
    console.log("");
    return false;
  }

  if (!pid) {
    console.log(
      chalk.yellow("!") +
        " Gateway is not currently running; this pairing info may not be usable until it starts.",
    );
    console.log("");
  }

  // Read the persisted pairing token from disk so we can construct a fresh QR
  // even when only the status is loaded.
  const pairing = loadOrCreatePairing();
  printPairingDetails(pairing.userId, qrPayload(status, pairing));
  console.log(chalk.dim(`Relay: ${status.relayUrl}`));
  console.log(chalk.dim(`Status updated: ${status.updatedAt}`));
  console.log("");
  return true;
}

export async function startGatewayAndPrintInfo(): Promise<void> {
  const startedAt = Date.now();
  startGatewayService();
  const status = await waitForGatewayInfo(startedAt);
  if (!statusIsFresh(status, startedAt)) {
    console.log(chalk.yellow("!") + " Gateway started, but pairing info was not refreshed yet.");
    console.log(chalk.dim(`Check logs with: overwatch gateway logs`));
    if (status) {
      console.log(chalk.dim("Last known pairing info:"));
      printGatewayInfo(status);
    }
    return;
  }
  printGatewayInfo(status);
}

export function installGatewayService(): void {
  requireMacos();
  const path = plistPath();
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(path, generateLaunchdPlist(), "utf-8");
  console.log(chalk.green("✓") + ` installed launchd service at ${path}`);
}

export function uninstallGatewayService(): void {
  requireMacos();
  const path = plistPath();
  runLaunchctl(["bootout", launchdTarget(), path], false);
  try { unlinkSync(path); } catch {}
  console.log(chalk.green("✓") + " uninstalled launchd service");
}

export function startGatewayService(): void {
  requireMacos();
  const path = plistPath();
  if (!existsSync(path)) installGatewayService();
  runLaunchctl(["bootout", launchdTarget(), path], false);
  runLaunchctl(["bootstrap", launchdTarget(), path], true);
  runLaunchctl(["enable", `${launchdTarget()}/${LAUNCHD_LABEL}`], false);
  runLaunchctl(["kickstart", "-k", `${launchdTarget()}/${LAUNCHD_LABEL}`], false);
  console.log(chalk.green("✓") + " gateway service started");
}

export function stopGatewayService(): void {
  requireMacos();
  runLaunchctl(["bootout", launchdTarget(), plistPath()], false);
  const pid = getRunningGatewayPid();
  if (pid) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  console.log(chalk.green("✓") + " gateway service stopped");
}

function printGatewayStatus(): void {
  const pid = getRunningGatewayPid();
  const status = readGatewayStatus();
  const serviceInstalled = existsSync(plistPath());
  console.log("");
  console.log(`  Gateway:  ${pid ? chalk.green(`running (PID ${pid})`) : chalk.red("not running")}`);
  console.log(`  Service:  ${serviceInstalled ? chalk.green("installed") : chalk.dim("not installed")}`);
  if (status) {
    console.log(
      `  Relay:    ${status.daemonRelayConnected ? chalk.green("connected") : chalk.yellow("reconnecting")} (${status.relayUrl})`,
    );
    console.log(
      `  Daemon:   ${chalk.green("running")} (localhost:${status.backendPort})`,
    );
    console.log(
      `  Cloud:    ${status.orchestratorConnected ? chalk.green("connected") : chalk.dim("idle")}`,
    );
    console.log(`  User ID:  ${chalk.bold(status.userId)}`);
    console.log(`  Updated:  ${chalk.dim(status.updatedAt)}`);
    if (status.lastEvent) console.log(`  Event:    ${status.lastEvent}`);
    if (status.lastError) console.log(`  Error:    ${chalk.red(status.lastError)}`);
  }
  console.log(`  Logs:     ${chalk.dim(GATEWAY_LOG_PATH)}`);
  console.log("");
}

function printLogs(lines: number): void {
  if (!existsSync(GATEWAY_LOG_PATH)) {
    console.log("No gateway log found yet.");
    return;
  }
  const all = readFileSync(GATEWAY_LOG_PATH, "utf-8").trimEnd().split("\n");
  console.log(all.slice(-lines).join("\n"));
}

export function buildGatewayCommand(): Command {
  const command = new Command("gateway").description("Manage the background Overwatch gateway");

  command
    .command("run", { hidden: true })
    .description("Run the gateway in the current process")
    .option("--replace", "Replace an existing gateway process")
    .option("--service", "Run under a process supervisor without printing pairing UI")
    .action(async (opts: { replace?: boolean; service?: boolean }) => {
      await runGateway({
        replace: opts.replace,
        foreground: !opts.service,
        printPairing: !opts.service,
      });
    });

  command.command("start").description("Start the background service and print pairing info").action(startGatewayAndPrintInfo);
  command.command("stop").description("Stop the background service").action(() => stopGatewayService());
  command.command("restart").description("Restart the background service").action(() => {
    stopGatewayService();
    return startGatewayAndPrintInfo();
  });
  command.command("status").description("Show gateway service and connection status").action(() => printGatewayStatus());
  command.command("info").description("Print phone pairing QR code and room info").action(() => {
    if (!printGatewayInfo()) process.exitCode = 1;
  });
  command
    .command("logs")
    .description("Print recent gateway logs")
    .option("-n, --lines <count>", "Number of lines", "80")
    .action((opts: { lines: string }) => printLogs(Number.parseInt(opts.lines, 10) || 80));

  return command;
}
