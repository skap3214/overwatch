import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import chalk from "chalk";
import { loadConfig, saveConfig, getConfigDir } from "../config.js";

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

export async function setupCommand(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const config = loadConfig();

  console.log("");
  console.log(chalk.bold("Overwatch Setup"));
  console.log(chalk.dim("───────────────"));
  console.log("");

  // Check pi-coding-agent OAuth
  const authPath = join(homedir(), ".pi", "agent", "auth.json");
  if (existsSync(authPath)) {
    console.log(chalk.green("✓") + " pi-coding-agent OAuth found at ~/.pi/agent/auth.json");
  } else {
    console.log(chalk.yellow("!") + " pi-coding-agent OAuth not found at ~/.pi/agent/auth.json");
    console.log("  Run your agent once to complete the OAuth flow, or set ANTHROPIC_API_KEY as fallback.");
  }
  console.log("");

  // Deepgram
  const deepgram = await ask(
    rl,
    `Deepgram API key${config.deepgramApiKey ? chalk.dim(" (enter to keep current)") : ""}: `
  );
  if (deepgram.trim()) config.deepgramApiKey = deepgram.trim();

  // Cartesia
  const cartesia = await ask(
    rl,
    `Cartesia API key${config.cartesiaApiKey ? chalk.dim(" (enter to keep current)") : ""}: `
  );
  if (cartesia.trim()) config.cartesiaApiKey = cartesia.trim();

  // Relay URL
  const relay = await ask(
    rl,
    `Relay URL${config.relayUrl ? chalk.dim(` (${config.relayUrl})`) : ""}: `
  );
  if (relay.trim()) config.relayUrl = relay.trim();

  rl.close();

  saveConfig(config);
  console.log("");
  console.log(chalk.green("✓") + ` Config saved to ${getConfigDir()}/config.json`);
  console.log("");
  console.log(`Run ${chalk.bold("overwatch start")} to begin.`);
}
