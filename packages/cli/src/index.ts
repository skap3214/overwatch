#!/usr/bin/env node

import { Command } from "commander";
import { setupCommand } from "./commands/setup.js";
import { startCommand } from "./commands/start.js";
import { statusCommand } from "./commands/status.js";
import { sessionsCommand } from "./commands/sessions.js";

const program = new Command();

program
  .name("overwatch")
  .description("Voice-controlled orchestrator for tmux-hosted coding sessions")
  .version("0.1.0");

program
  .command("setup")
  .description("Configure Deepgram and terminal settings")
  .option("--deepgram-key <key>", "Deepgram API key")
  .option("--configure-terminal <name>", "Auto-configure terminal (ghostty, kitty, alacritty, iterm2)")
  .option("--non-interactive", "Skip all prompts, use provided flags only")
  .action(setupCommand);

program
  .command("start")
  .description("Start backend, connect to relay, show QR code")
  .action(startCommand);

program
  .command("status")
  .description("Show connection and configuration status")
  .action(statusCommand);

program
  .command("sessions")
  .description("List tmux sessions")
  .action(sessionsCommand);

program.parse();
