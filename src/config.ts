import "dotenv/config";
import os from "node:os";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().default(8787),
  ANTHROPIC_API_KEY: z.string().optional(),
  DEEPGRAM_API_KEY: z.string().optional(),
  DEEPGRAM_STT_MODEL: z.string().optional(),
  DEEPGRAM_TTS_MODEL: z.string().optional(),
  HARNESS_PROVIDER: z
    .enum(["pi-coding-agent", "claude-code-cli", "hermes"])
    .default("pi-coding-agent"),
  HERMES_BASE_URL: z.string().default("http://127.0.0.1:8642"),
  HERMES_API_KEY: z.string().default(""),
  HERMES_SESSION_ID: z.string().default(""),
  HERMES_SKILL_NAME: z.string().default("overwatch"),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(): AppConfig {
  const parsed = envSchema.parse(process.env);
  return {
    ...parsed,
    HERMES_SESSION_ID:
      parsed.HERMES_SESSION_ID || `overwatch-${os.hostname()}`,
  };
}
