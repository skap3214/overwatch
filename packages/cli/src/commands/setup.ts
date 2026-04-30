import { createInterface } from "node:readline";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import chalk from "chalk";
import prompts from "prompts";
import { getConfigDir, loadConfig, saveConfig } from "../config.js";
import {
  installGatewayService,
  setGatewayEnabled,
  startGatewayService,
  stopGatewayService,
  uninstallGatewayService,
} from "./gateway.js";
import {
  configureHermesHarnessConfig,
  enableHermesPlugin,
} from "../hermes-config.js";
import {
  installOverwatchSkills,
  normalizeSkillsSetupMode,
} from "../skills-setup.js";
import {
  configureTerminalsNonInteractive,
  hasOverwatchAutoStartConfigured,
  setupTerminal,
  userHasCmux,
} from "../terminal-setup.js";

function ask(
  rl: ReturnType<typeof createInterface>,
  question: string
): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function askYesNo(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultValue = true
): Promise<boolean> {
  const suffix = defaultValue ? " (Y/n): " : " (y/N): ";
  const answer = (await ask(rl, `${question}${suffix}`)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return answer === "y" || answer === "yes";
}

interface AgentAuthState {
  configured: boolean;
  authPath: string;
  providers: string[];
}

function getAgentAuthPath(): string {
  return join(homedir(), ".pi", "agent", "auth.json");
}

function getAgentAuthState(): AgentAuthState {
  const authPath = getAgentAuthPath();
  if (!existsSync(authPath)) {
    return { configured: false, authPath, providers: [] };
  }

  try {
    const raw = JSON.parse(readFileSync(authPath, "utf-8")) as Record<
      string,
      Record<string, unknown>
    >;
    const providers = Object.entries(raw)
      .filter(([, value]) => Boolean(value) && Object.keys(value).length > 0)
      .map(([provider]) => provider);
    return { configured: providers.length > 0, authPath, providers };
  } catch {
    return { configured: false, authPath, providers: [] };
  }
}

function importAgentAuth(sourcePath: string): string {
  const resolvedSource = sourcePath.startsWith("~")
    ? join(homedir(), sourcePath.slice(2))
    : sourcePath;
  if (!existsSync(resolvedSource)) {
    throw new Error(`Auth file not found: ${resolvedSource}`);
  }

  const raw = JSON.parse(readFileSync(resolvedSource, "utf-8")) as Record<
    string,
    Record<string, unknown>
  >;
  if (Object.keys(raw).length === 0) {
    throw new Error(`Auth file is empty: ${resolvedSource}`);
  }

  const authPath = getAgentAuthPath();
  mkdirSync(dirname(authPath), { recursive: true });
  if (existsSync(authPath) && resolvedSource !== authPath) {
    copyFileSync(authPath, `${authPath}.overwatch-backup`);
  }
  writeFileSync(authPath, JSON.stringify(raw, null, 2), "utf-8");
  chmodSync(authPath, 0o600);
  return authPath;
}

function getRawPiCommand(): string {
  try {
    execSync("command -v pi", { stdio: "ignore", shell: "/bin/bash" });
    return "pi";
  } catch {
    // continue to local fallbacks
  }
  const installed = join(homedir(), ".overwatch", "app", "node_modules", ".bin", "pi");
  if (existsSync(installed)) return installed;
  const local = join(process.cwd(), "node_modules", ".bin", "pi");
  if (existsSync(local)) return local;
  // Intentionally NOT returning `npx @mariozechner/pi-coding-agent` here. With
  // a global npmrc that enforces a minimum release age, an `npx` invocation
  // would hang trying to find an allowed version of a daily-publishing
  // package. Caller should treat an empty string as "pi not installed" and
  // print install instructions instead of shelling out blindly.
  return "";
}

function isPiInstalled(): boolean {
  return getRawPiCommand() !== "";
}

function piInstallInstruction(): string {
  return "npm install -g @mariozechner/pi-coding-agent";
}

async function loginWithSDK(
  rl: ReturnType<typeof createInterface>,
  preferredProvider?: string
): Promise<boolean> {
  const { AuthStorage } = await import("@mariozechner/pi-coding-agent");
  const auth = AuthStorage.create();
  const providers = auth.getOAuthProviders();

  let providerId = preferredProvider?.trim().toLowerCase();
  if (providerId) {
    const match = providers.find(
      (provider: { id: string; name: string }) =>
        provider.id.toLowerCase() === providerId ||
        provider.name.toLowerCase() === providerId
    );
    if (!match) {
      console.log(
        chalk.yellow("  !") +
          ` Unknown provider "${preferredProvider}". Available: ${providers
            .map((provider: { id: string }) => provider.id)
            .join(", ")}\n`
      );
      return false;
    }
    providerId = match.id;
  } else {
    const response = await prompts({
      type: "select",
      name: "provider",
      message: "Select a provider to login",
      choices: providers.map((provider: { id: string; name: string }) => ({
        title: auth.hasAuth(provider.id)
          ? `${provider.name} ${chalk.green("✓ logged in")}`
          : provider.name,
        value: provider.id,
      })),
    });

    if (!response.provider) {
      console.log(
        chalk.dim(
          "  Skipped — you can rerun `overwatch setup --agent-provider <provider>` later.\n"
        )
      );
      return false;
    }
    providerId = response.provider;
  }

  if (!providerId) return false;

  try {
    const callbacks: Parameters<typeof auth.login>[1] & {
      onDeviceCode?: (info: {
        userCode: string;
        verificationUri: string;
      }) => void;
    } = {
      onAuth: (info: { url: string; instructions?: string }) => {
        console.log(chalk.dim(`  Opening browser for ${providerId} authentication...`));
        if (info.instructions) console.log(chalk.dim(`  ${info.instructions}`));
        try {
          execSync(`open "${info.url}"`);
        } catch {
          console.log(`  Open this URL: ${info.url}`);
        }
      },
      onDeviceCode: (info: { userCode: string; verificationUri: string }) => {
        console.log(chalk.yellow("  Human action required"));
        console.log(`  Visit: ${info.verificationUri}`);
        console.log(`  Enter code: ${chalk.bold(info.userCode)}`);
      },
      onPrompt: async (prompt: { message: string }) => {
        if (!process.stdin.isTTY) {
          throw new Error(
            `This provider requires typed input: "${prompt.message}". Run the command in a terminal and paste the requested value.`
          );
        }
        return ask(rl, `  ${prompt.message} `);
      },
      onProgress: (message: string) => {
        console.log(chalk.dim(`  ${message}`));
      },
    };

    await auth.login(providerId, callbacks);

    const updated = getAgentAuthState();
    const success = updated.providers.includes(providerId);
    if (success) {
      console.log(chalk.green("\n  ✓") + ` Logged into ${providerId}\n`);
    }
    return success;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Authentication failed";
    console.log(chalk.yellow("\n  !") + ` ${message}\n`);
    return false;
  }
}


interface SetupOptions {
  agent?: string;
  agentAuthFile?: string;
  agentProvider?: string;
  terminal?: string[];
  deepgramKey?: string;
  stt?: string;
  tts?: string;
  sttModel?: string;
  ttsModel?: string;
  gateway?: string;
  skills?: string;
  nonInteractive?: boolean;
}

type AgentId = "pi-coding-agent" | "claude-code-cli" | "hermes";

function normalizeAgentId(value: string | undefined): AgentId {
  const normalized = (value ?? "pi-coding-agent").trim().toLowerCase();
  if (
    normalized === "pi-coding-agent" ||
    normalized === "claude-code-cli" ||
    normalized === "hermes"
  ) {
    return normalized;
  }
  throw new Error(
    `Unknown agent "${value}". Use one of: pi-coding-agent, claude-code-cli, hermes.`,
  );
}

function normalizeSpeechProvider(kind: "stt" | "tts", value: string): "deepgram" {
  const normalized = value.trim().toLowerCase();
  if (normalized === "deepgram") return "deepgram";
  throw new Error(`Unknown ${kind.toUpperCase()} provider "${value}". Only deepgram is supported for now.`);
}

function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command}`, { stdio: "ignore", shell: "/bin/bash" });
    return true;
  } catch {
    return false;
  }
}

function configureGateway(mode: string): void {
  const normalized = mode.trim().toLowerCase();
  if (normalized === "on") {
    installGatewayService();
    startGatewayService();
    setGatewayEnabled(true);
    console.log(chalk.green("✓") + " Gateway enabled");
    return;
  }
  if (normalized === "off") {
    setGatewayEnabled(false);
    stopGatewayService();
    uninstallGatewayService();
    console.log(chalk.green("✓") + " Gateway disabled");
    return;
  }
  throw new Error(`Unknown gateway mode "${mode}". Use "on" or "off".`);
}

function printRemainingActions(options: {
  configHasDeepgram: boolean;
  agentId: AgentId;
  agentState: AgentAuthState;
  terminalReady: boolean;
  skillsReady: boolean;
}): void {
  const actions: string[] = [];
  if (options.agentId === "pi-coding-agent" && !options.agentState.configured) {
    if (isPiInstalled()) {
      actions.push(
        `Authenticate a Pi provider. Best path: \`overwatch setup --agent-provider anthropic\`. Raw fallback: \`${getRawPiCommand()}\` then run \`/login\`.`
      );
    } else {
      actions.push(
        `Install pi-coding-agent first: \`${piInstallInstruction()}\`, then run \`overwatch setup --agent-provider anthropic\`.`
      );
    }
  } else if (options.agentId === "claude-code-cli" && !commandExists("claude")) {
    actions.push("Install Claude Code CLI so `claude` is available on PATH.");
  }
  if (!options.configHasDeepgram) {
    actions.push(
      "Add a Deepgram key with `overwatch setup --deepgram-key <KEY>`."
    );
  }
  if (!options.terminalReady) {
    actions.push(
      "Configure a supported terminal with `overwatch setup --terminal ghostty` (or kitty/alacritty/iterm2), or skip for an existing tmux setup with `--terminal existing-tmux`."
    );
  }
  if (!options.skillsReady) {
    actions.push(
      "Install the Overwatch skill by rerunning `overwatch setup --skills on`; setup uses `npx skills@latest add <skill-source> --global --all --copy` for `.agents/skills/overwatch`."
    );
  }

  if (actions.length === 0) {
    console.log(chalk.green("\n✓ Setup complete"));
    console.log("Run `overwatch start` to begin.");
    return;
  }

  console.log(chalk.yellow("\n! Setup still needs attention"));
  for (const action of actions) {
    console.log(`  - ${action}`);
  }
  console.log("");
}

export async function setupCommand(options: SetupOptions = {}): Promise<void> {
  const nonInteractive = options.nonInteractive ?? false;
  const skillsMode = normalizeSkillsSetupMode(options.skills);
  let rl = createInterface({ input: process.stdin, output: process.stdout });
  let config = loadConfig();
  const agentId = normalizeAgentId(
    options.agent ??
      (options.agentProvider || options.agentAuthFile ? "pi-coding-agent" : config.harness),
  );

  console.log("");
  console.log(chalk.bold("Overwatch Setup"));
  console.log(chalk.dim("───────────────"));
  console.log("");

  console.log(chalk.green("✓") + ` Agent set to ${agentId}`);
  config.harness = agentId;

  let agentState = getAgentAuthState();
  if (agentId === "pi-coding-agent") {
    if (agentState.configured) {
      console.log(
        chalk.green("✓") +
          ` Pi agent auth present (${agentState.providers.join(", ")})`
      );
    } else {
      console.log(chalk.yellow("!") + " Pi agent auth not configured yet");
    }

    if (options.agentAuthFile) {
      try {
        const authPath = importAgentAuth(options.agentAuthFile);
        agentState = getAgentAuthState();
        console.log(chalk.green("✓") + ` Imported agent auth into ${authPath}`);
      } catch (error) {
        console.log(
          chalk.red("✗") +
            ` ${
              error instanceof Error ? error.message : "Failed to import agent auth"
            }`
        );
      }
    } else if (!agentState.configured || options.agentProvider) {
      // Skip the login flow if pi-coding-agent isn't installed at all — the
      // dynamic import inside loginWithSDK would crash with a confusing module
      // resolution error. Tell the user how to install it instead.
      if (!isPiInstalled()) {
        console.log(
          chalk.yellow("  !") +
            " pi-coding-agent is not installed yet — skipping provider login."
        );
        console.log(
          chalk.dim(
            `  Install it with: ${chalk.bold(piInstallInstruction())}\n` +
              "  Then re-run: overwatch setup --agent-provider anthropic\n"
          )
        );
      } else if (options.agentProvider) {
        const loggedIn = await loginWithSDK(rl, options.agentProvider);
        if (loggedIn) agentState = getAgentAuthState();
        rl.close();
        rl = createInterface({ input: process.stdin, output: process.stdout });
      } else if (!nonInteractive) {
        const shouldLogin = await askYesNo(
          rl,
          "Configure Pi provider login now?",
          !agentState.configured
        );
        if (shouldLogin) {
          const loggedIn = await loginWithSDK(rl);
          if (loggedIn) agentState = getAgentAuthState();
          rl.close();
          rl = createInterface({ input: process.stdin, output: process.stdout });
        }
      }
    }
  } else if (agentId === "hermes") {
    config = configureHermesHarnessConfig(config);
    console.log(chalk.green("✓") + " Hermes harness configured from ~/.hermes/config.yaml");
    try {
      await enableHermesPlugin(config);
      console.log(chalk.green("✓") + " Hermes Overwatch plugin enabled");
    } catch (error) {
      console.log(
        chalk.yellow("!") +
          ` Hermes plugin setup skipped: ${
            error instanceof Error ? error.message : "unknown error"
          }`
      );
    }
  } else if (!commandExists("claude")) {
    console.log(chalk.yellow("!") + " Claude Code CLI is not installed or not on PATH.");
  }

  console.log("");

  if (options.stt) {
    config.sttProvider = normalizeSpeechProvider("stt", options.stt);
    console.log(chalk.green("✓") + ` STT provider set to ${config.sttProvider}`);
  }
  if (options.tts) {
    config.ttsProvider = normalizeSpeechProvider("tts", options.tts);
    console.log(chalk.green("✓") + ` TTS provider set to ${config.ttsProvider}`);
  }
  if (options.sttModel) {
    config.sttProvider = config.sttProvider ?? "deepgram";
    config.sttModel = options.sttModel.trim();
    console.log(chalk.green("✓") + ` STT model set to ${config.sttModel}`);
  }
  if (options.ttsModel) {
    config.ttsProvider = config.ttsProvider ?? "deepgram";
    config.ttsModel = options.ttsModel.trim();
    console.log(chalk.green("✓") + ` TTS model set to ${config.ttsModel}`);
  }
  if (options.deepgramKey) {
    config.deepgramApiKey = options.deepgramKey.trim();
    config.sttProvider = config.sttProvider ?? "deepgram";
    config.ttsProvider = config.ttsProvider ?? "deepgram";
    console.log(chalk.green("✓") + " Deepgram API key set for STT + TTS");
  } else if (!nonInteractive) {
    const answer = await ask(
      rl,
      `Deepgram API key (used for STT + TTS)${
        config.deepgramApiKey ? chalk.dim(" (enter to keep current)") : ""
      }: `
    );
    if (answer.trim()) {
      config.deepgramApiKey = answer.trim();
      console.log(chalk.green("✓") + " Deepgram API key updated");
    }
  }

  saveConfig(config);
  console.log(chalk.green("✓") + ` Config saved to ${getConfigDir()}/config.json`);

  if (options.gateway) {
    configureGateway(options.gateway);
  }

  let skillsReady = true;
  if (skillsMode === "on") {
    console.log("");
    console.log(chalk.bold("Agent Skills"));
    console.log(chalk.dim("────────────"));
    const installed = installOverwatchSkills();
    for (const result of installed) {
      if (result.ok) {
        console.log(chalk.green("✓") + ` Installed ${result.name} skill`);
      } else {
        skillsReady = false;
        console.log(
          chalk.yellow("!") +
            ` ${result.name} skill setup failed: ${result.error}`
        );
      }
    }
  } else {
    console.log(chalk.dim("  Agent skills setup skipped by flag."));
  }

  let terminalSetup = { configuredAny: false, skipped: false };
  if (options.terminal && options.terminal.length > 0) {
    terminalSetup = configureTerminalsNonInteractive(options.terminal);
  } else if (!nonInteractive) {
    terminalSetup = await setupTerminal();
  }

  rl.close();

  const terminalReady =
    terminalSetup.skipped || userHasCmux() || hasOverwatchAutoStartConfigured();
  if (terminalSetup.configuredAny) {
    console.log(
      chalk.yellow(
        "\n  Restart your terminal after this setup so new tabs pick up the tmux bootstrap."
      )
    );
  }

  printRemainingActions({
    configHasDeepgram: Boolean(config.deepgramApiKey),
    agentId,
    agentState,
    terminalReady,
    skillsReady,
  });
}
