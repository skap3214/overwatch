import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getNonInteractiveSetupIssues,
  type SetupOptions,
} from "../packages/cli/src/commands/setup.js";

type ValidationContext = Parameters<typeof getNonInteractiveSetupIssues>[1];

function context(overrides: Record<string, unknown> = {}) {
  return {
    config: {},
    agentId: "pi-coding-agent",
    agentState: { configured: false, authPath: "/tmp/auth.json", providers: [] },
    hasCmux: false,
    hasOverwatchAutoStart: false,
    commandAvailable: (command: string) => command === "npx",
    agentAuthFileUsable: () => false,
    hermesConfigUsable: () => false,
    ...overrides,
  } as ValidationContext;
}

test("non-interactive setup requires all values needed for a working default setup", () => {
  const issues = getNonInteractiveSetupIssues(
    { nonInteractive: true },
    context(),
  );

  assert.match(issues.join("\n"), /Deepgram/);
  assert.match(issues.join("\n"), /Pi auth/);
  assert.match(issues.join("\n"), /terminal setup/i);
});

test("non-interactive setup accepts explicit auth import and terminal skip", () => {
  const options: SetupOptions = {
    nonInteractive: true,
    deepgramKey: "dg-key",
    agentAuthFile: "/tmp/auth.json",
    terminal: ["existing-tmux"],
  };

  const issues = getNonInteractiveSetupIssues(
    options,
    context({ agentAuthFileUsable: () => true }),
  );

  assert.deepEqual(issues, []);
});

test("non-interactive setup rejects provider login because it needs a human OAuth handoff", () => {
  const issues = getNonInteractiveSetupIssues(
    {
      nonInteractive: true,
      deepgramKey: "dg-key",
      agentProvider: "anthropic",
      terminal: ["existing-tmux"],
    },
    context(),
  );

  assert.match(issues.join("\n"), /interactive OAuth/);
});

test("non-interactive setup validates terminal names before editing files", () => {
  const issues = getNonInteractiveSetupIssues(
    {
      nonInteractive: true,
      deepgramKey: "dg-key",
      agentAuthFile: "/tmp/auth.json",
      terminal: ["ghostty,warp"],
    },
    context({ agentAuthFileUsable: () => true }),
  );

  assert.match(issues.join("\n"), /Unsupported terminal/);
  assert.match(issues.join("\n"), /warp/);
});

test("non-interactive setup validates agent-specific prerequisites", () => {
  const claudeIssues = getNonInteractiveSetupIssues(
    { nonInteractive: true, deepgramKey: "dg-key", terminal: ["existing-tmux"] },
    context({
      agentId: "claude-code-cli",
      commandAvailable: (command: string) => command === "npx",
    }),
  );
  assert.match(claudeIssues.join("\n"), /claude/);

  const hermesIssues = getNonInteractiveSetupIssues(
    { nonInteractive: true, deepgramKey: "dg-key", terminal: ["existing-tmux"] },
    context({ agentId: "hermes" }),
  );
  assert.match(hermesIssues.join("\n"), /Hermes/);
});
