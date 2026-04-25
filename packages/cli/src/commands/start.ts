import chalk from "chalk";
import { loadConfig } from "../config.js";
import { getRunningGatewayPid, readGatewayStatus } from "../gateway-state.js";
import { printPairingDetails, runGateway } from "../gateway-runtime.js";
import { startGatewayService } from "./gateway.js";

export async function startCommand(options?: { foreground?: boolean }): Promise<void> {
  const config = loadConfig();

  if (config.gateway?.autoStart && !options?.foreground) {
    startGatewayService();
    const status = readGatewayStatus();
    const pid = getRunningGatewayPid();
    console.log("");
    console.log(chalk.green("✓") + ` Overwatch gateway is running${pid ? ` (PID ${pid})` : ""}`);
    if (status?.room && status.hostPublicKey) {
      const qrData = JSON.stringify({
        r: status.room,
        k: status.hostPublicKey,
        ...(config.deepgramApiKey && { d: config.deepgramApiKey }),
      });
      console.log("");
      printPairingDetails(status.room, qrData);
      console.log(chalk.dim("Use `overwatch gateway status` for live connection details."));
    }
    return;
  }

  console.log("");
  console.log(chalk.bold("Starting Overwatch..."));
  console.log("");
  await runGateway({ foreground: true, printPairing: true });
}
