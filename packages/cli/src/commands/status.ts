import chalk from "chalk";
import { loadConfig } from "../config.js";

export async function statusCommand(): Promise<void> {
  const config = loadConfig();
  const port = config.backendPort ?? 8787;

  let backendOk = false;
  try {
    const res = await fetch(`http://localhost:${port}/health`);
    backendOk = res.ok;
  } catch {
    // not running
  }

  console.log("");
  console.log(
    `  Backend:  ${backendOk ? chalk.green("running") : chalk.red("not running")} (localhost:${port})`
  );
  console.log(`  Relay:    ${chalk.dim(config.relayUrl ?? "not configured")}`);
  console.log(`  Deepgram: ${config.deepgramApiKey ? chalk.green("configured") : chalk.red("not set")} (STT + TTS)`);
  console.log("");
}
