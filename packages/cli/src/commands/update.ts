import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { getRunningGatewayPid } from "../gateway-state.js";
import { startGatewayService, stopGatewayService } from "./gateway.js";

const INSTALL_ROOT = join(homedir(), ".overwatch");
const INSTALL_DIR = join(INSTALL_ROOT, "app");
const BIN_DIR = join(INSTALL_ROOT, "bin");
const WRAPPER_PATH = join(BIN_DIR, "overwatch");

function run(command: string, args: string[], cwd = INSTALL_DIR): void {
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function output(command: string, args: string[], cwd = INSTALL_DIR): string {
  return execFileSync(command, args, { cwd, encoding: "utf-8" }).trim();
}

function recreateWrapper(): void {
  mkdirSync(BIN_DIR, { recursive: true });
  writeFileSync(
    WRAPPER_PATH,
    `#!/bin/bash
set -euo pipefail
APP_ROOT="$HOME/.overwatch/app"
exec "$APP_ROOT/node_modules/.bin/tsx" "$APP_ROOT/packages/cli/src/index.ts" "$@"
`,
    "utf-8",
  );
  chmodSync(WRAPPER_PATH, 0o755);
}

function ensureInstalledCheckout(): void {
  if (existsSync(join(INSTALL_DIR, ".git"))) return;
  throw new Error(
    `No installed Overwatch checkout found at ${INSTALL_DIR}. Run the installer first: eval "$(curl -fsSL https://raw.githubusercontent.com/skap3214/overwatch/main/install.sh)"`,
  );
}

export async function updateCommand(): Promise<void> {
  console.log("");
  console.log(chalk.bold("Updating Overwatch"));
  console.log(chalk.dim("------------------"));
  console.log("");

  ensureInstalledCheckout();

  const before = output("git", ["rev-parse", "--short", "HEAD"]);
  const gatewayWasRunning = Boolean(getRunningGatewayPid());

  if (gatewayWasRunning) {
    console.log(chalk.dim("Stopping gateway before update..."));
    stopGatewayService();
  }

  try {
    console.log(chalk.dim("Fetching latest main..."));
    run("git", ["fetch", "--depth", "1", "origin", "main", "--quiet"]);
    try {
      run("git", ["reset", "--hard", "origin/main", "--quiet"]);
    } catch {
      run("git", ["reset", "--hard", "FETCH_HEAD", "--quiet"]);
    }

    console.log(chalk.dim("Installing dependencies..."));
    run("npm", ["ci", "--no-audit", "--no-fund"]);

    recreateWrapper();
    const after = output("git", ["rev-parse", "--short", "HEAD"]);
    console.log(chalk.green("✓") + ` Updated Overwatch (${before} -> ${after})`);
    console.log(chalk.green("✓") + ` Refreshed CLI wrapper at ${WRAPPER_PATH}`);

    if (gatewayWasRunning) {
      console.log(chalk.dim("Restarting gateway..."));
      startGatewayService();
    }
  } catch (error) {
    console.log(
      chalk.red("✗") +
        ` Update failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    if (gatewayWasRunning) {
      console.log(chalk.yellow("!") + " Gateway was stopped for the update. Run `overwatch gateway start` after resolving the issue.");
    }
    process.exitCode = 1;
  }

  console.log("");
}
