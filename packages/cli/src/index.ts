#!/usr/bin/env node

import { Command } from "commander";
import { setupCommand } from "./commands/setup.js";
import { statusCommand } from "./commands/status.js";
import { buildGatewayCommand, startGatewayAndPrintInfo } from "./commands/gateway.js";
import { buildAgentCommand } from "./commands/agent.js";
import { updateCommand } from "./commands/update.js";

const program = new Command();

function collectValues(value: string, previous: string[] = []): string[] {
  return previous.concat(value);
}

program
  .name("overwatch")
  .description("Voice-controlled orchestrator for tmux-hosted coding sessions")
  .version("0.1.0");

program
  .command("setup")
  .description("Configure Overwatch desired state")
  .option("--agent <id>", "Agent harness (pi-coding-agent, claude-code-cli, hermes)")
  .option("--deepgram-key <key>", "Deepgram API key")
  .option("--stt <provider>", "Speech-to-text provider (deepgram)")
  .option("--tts <provider>", "Text-to-speech provider (deepgram)")
  .option("--stt-model <model>", "Speech-to-text model")
  .option("--tts-model <model>", "Text-to-speech model")
  .option("--skills <mode>", "Install the Overwatch agent skill (on, off)")
  .option(
    "--terminal <name>",
    "Configure terminal; repeatable or comma-separated (ghostty, kitty, alacritty, iterm2, cmux, none, existing-tmux)",
    collectValues
  )
  .option(
    "--agent-provider <provider>",
    "Run Pi provider login directly (for example: anthropic, openai-codex, github-copilot)"
  )
  .option(
    "--agent-auth-file <path>",
    "Import an existing ~/.pi/agent/auth.json file"
  )
  .option("--non-interactive", "Skip all prompts, use provided flags only")
  .action(setupCommand);

program
  .command("start")
  .description("Start the background Overwatch gateway and print pairing info")
  .action(startGatewayAndPrintInfo);

program
  .command("update")
  .description("Update the installed Overwatch CLI and app")
  .action(updateCommand);

program.addCommand(buildGatewayCommand());
program.addCommand(buildAgentCommand());

program
  .command("status")
  .description("Show connection and configuration status")
  .action(statusCommand);

program.parse();
