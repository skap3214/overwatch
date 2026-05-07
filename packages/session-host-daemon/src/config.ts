import "dotenv/config";
import os from "node:os";
import { z } from "zod";

const envSchema = z.object({
  // Daemon HTTP server (REST API for monitors/tmux/health, plus Hermes webhook).
  PORT: z.coerce.number().default(8787),
  // Bind hostname for the local REST API. Loopback by default — the API
  // can spawn tmux sessions and inject keystrokes, so we never want it on
  // a public interface unless the operator opts in. Set to "0.0.0.0" only
  // when you need cross-machine access AND have OVERWATCH_API_TOKEN set.
  OVERWATCH_LISTEN_HOST: z.string().default("127.0.0.1"),

  // Provider auth.
  ANTHROPIC_API_KEY: z.string().optional(),

  // Harness selection.
  HARNESS_PROVIDER: z
    .enum(["pi-coding-agent", "claude-code-cli", "hermes"])
    .default("pi-coding-agent"),
  HERMES_BASE_URL: z.string().default("http://127.0.0.1:8642"),
  HERMES_API_KEY: z.string().default(""),
  HERMES_SESSION_ID: z.string().default(""),
  HERMES_SKILL_NAME: z.string().default("overwatch"),

  // Adapter-protocol — outbound connection to the cloud orchestrator via the relay.
  RELAY_URL: z.string().default("https://overwatch-relay.soami.workers.dev"),
  OVERWATCH_USER_ID: z.string().default(""),
  ORCHESTRATOR_PAIRING_TOKEN: z.string().default(""),
  ORCHESTRATOR_URL: z.string().default(""),

  // Catch-all logger — when set, every wire event from each adapter is appended
  // to a JSONL file under ~/.overwatch/catch-all/<provider>/<date>.jsonl.
  CATCH_ALL_LOGGER: z.coerce.boolean().default(false),

  // Audit log location for cloud-originated commands.
  AUDIT_LOG_PATH: z.string().default(""),

  // Daemon API token for the local /api/v1/tmux endpoint (existing).
  OVERWATCH_API_TOKEN: z.string().optional(),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);
  const home = process.env.HOME ?? os.homedir();
  return {
    ...parsed,
    HERMES_SESSION_ID:
      parsed.HERMES_SESSION_ID || `overwatch-${os.hostname()}`,
    AUDIT_LOG_PATH:
      parsed.AUDIT_LOG_PATH || `${home}/.overwatch/audit.jsonl`,
  };
}
