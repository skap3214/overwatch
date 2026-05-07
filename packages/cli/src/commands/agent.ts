/**
 * `overwatch agent` — generic, registry-driven CLI for managing agent
 * harnesses. Reads the same provider registry the backend uses
 * (`src/harness/providers/index.ts`) so adding a new agent there
 * automatically appears here too.
 */

import path from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { loadConfig, saveConfig } from "../config.js";
import {
  configureHermesHarnessConfig,
  disableHermesPlugin,
  getHermesStatus,
} from "../hermes-config.js";
import { getPinnedPiCodingAgentGlobalInstallCommand } from "../pinned-pi-coding-agent.js";

interface ProviderInfo {
  id: string;
  name: string;
  tagline: string;
  description: string;
  capabilities: Record<string, unknown>;
  installed: boolean;
  installInstruction?: string;
}

async function loadProviders(): Promise<ProviderInfo[]> {
  // Resolve the daemon's provider registry from inside the Overwatch app dir.
  // After the voice/harness-bridge overhaul the registry lives in
  // `packages/session-host-daemon/src/harness/providers/` (lifted from the
  // root `src/` tree).
  const candidates = [
    // Repo dev: cwd is repo root.
    path.resolve(
      process.cwd(),
      "packages/session-host-daemon/src/harness/providers/index.ts",
    ),
    // CLI run from packages/cli/ via `npm run` — walk back up.
    path.resolve(
      process.cwd(),
      "../session-host-daemon/src/harness/providers/index.ts",
    ),
    path.resolve(
      process.cwd(),
      "../../session-host-daemon/src/harness/providers/index.ts",
    ),
    // Installed: ~/.overwatch/app/packages/session-host-daemon/...
    path.resolve(
      process.env.HOME ?? "~",
      ".overwatch/app/packages/session-host-daemon/src/harness/providers/index.ts",
    ),
  ];

  for (const candidate of candidates) {
    try {
      const mod = await import(candidate);
      if (typeof mod.listProviders === "function") {
        return mod.listProviders() as ProviderInfo[];
      }
    } catch {
      // try next path
    }
  }

  // Fallback: hardcoded snapshot. If the registry can't be loaded we still
  // give the user a sensible "what could exist" list rather than crashing.
  return [
    {
      id: "pi-coding-agent",
      name: "pi-coding-agent",
      tagline: "Anthropic via OAuth (default)",
      description: "Library-based harness shipped with Overwatch.",
      capabilities: {},
      installed: false,
      installInstruction: getPinnedPiCodingAgentGlobalInstallCommand(),
    },
    {
      id: "claude-code-cli",
      name: "Claude Code CLI",
      tagline: "Spawns the `claude` CLI",
      description: "Wraps the official Claude Code CLI as a subprocess.",
      capabilities: {},
      installed: false,
      installInstruction: "https://claude.com/claude-code",
    },
    {
      id: "hermes",
      name: "Hermes Agent",
      tagline: "Routes to a local Hermes daemon",
      description: "Routes turns to a locally-running Hermes Agent gateway.",
      capabilities: {},
      installed: false,
      installInstruction: "https://github.com/NousResearch/hermes-agent",
    },
  ];
}

async function listCommand(): Promise<void> {
  const cfg = loadConfig();
  const active = cfg.harness ?? "pi-coding-agent";
  const providers = await loadProviders();

  console.log(chalk.bold("\nAvailable agents\n"));
  for (const p of providers) {
    const marker = p.id === active ? chalk.green("●") : chalk.dim("○");
    const installState = p.installed
      ? chalk.green("installed")
      : chalk.yellow("not installed");
    const activeTag = p.id === active ? chalk.green(" (active)") : "";
    console.log(
      `  ${marker} ${chalk.bold(p.name.padEnd(20))} ${installState}${activeTag}`,
    );
    console.log(`    ${chalk.dim(p.tagline)}`);
    if (!p.installed && p.installInstruction) {
      console.log(`    ${chalk.dim("install:")} ${p.installInstruction}`);
    }
    console.log("");
  }

  console.log(chalk.dim("Switch with: `overwatch agent set <id>` and restart."));
  console.log("");
}

async function statusCommand(): Promise<void> {
  const cfg = loadConfig();
  const active = cfg.harness ?? "pi-coding-agent";
  const providers = await loadProviders();
  const target = providers.find((provider) => provider.id === active);

  console.log(chalk.bold("\nAgent status\n"));
  console.log(`  active:    ${chalk.green(active)}`);
  if (target) {
    console.log(`  installed: ${target.installed ? chalk.green("yes") : chalk.red("no")}`);
    console.log(`  summary:   ${target.tagline}`);
  }

  if (active === "hermes") {
    const hermes = await getHermesStatus();
    console.log("");
    console.log(chalk.bold("Hermes"));
    console.log(`  config:    ${hermes.configPath} ${hermes.configExists ? chalk.green("found") : chalk.red("missing")}`);
    console.log(`  daemon:    ${hermes.daemonRunning ? chalk.green(`running (PID ${hermes.daemonPid})`) : chalk.red("not running")}`);
    console.log(`  api:       ${hermes.apiBaseURL} ${hermes.apiReachable ? chalk.green("reachable") : chalk.yellow("unreachable")}`);
    console.log(`  api key:   ${hermes.apiKey ? chalk.green(maskKey(hermes.apiKey)) : chalk.red("not configured")}`);
  }

  console.log("");
}

async function setCommand(id: string): Promise<void> {
  const providers = await loadProviders();
  const target = providers.find((p) => p.id === id);
  if (!target) {
    console.log(
      chalk.red(`✗ Unknown agent "${id}". Run \`overwatch agent list\`.`),
    );
    process.exit(1);
  }
  if (!target.installed) {
    console.log(
      chalk.yellow(`! "${id}" is not installed.`) +
        (target.installInstruction
          ? `\n  Install first: ${target.installInstruction}`
          : ""),
    );
    process.exit(1);
  }
  let cfg = loadConfig();
  if (id === "hermes") {
    cfg = configureHermesHarnessConfig(cfg);
    await disableHermesPlugin();
  } else {
    cfg.harness = id as typeof cfg.harness;
  }
  saveConfig(cfg);
  console.log(chalk.green(`✓ Active agent: ${id}`));
  console.log("Restart the Overwatch backend to apply: `overwatch start`.");
}

function maskKey(key: string): string {
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}...${key.slice(-2)}`;
}

export function buildAgentCommand(): Command {
  const cmd = new Command("agent");
  cmd.description("Manage agent harnesses (registry-driven)");

  cmd
    .command("list")
    .description("List all known agent providers and their install state")
    .action(listCommand);

  cmd
    .command("status")
    .description("Show active agent harness status")
    .action(statusCommand);

  cmd
    .command("set <id>")
    .description("Switch the active agent harness")
    .action(setCommand);

  return cmd;
}
