/**
 * Protocol invariant: submit_text against a busy target must be rejected;
 * preemption requires submit_with_steer.
 *
 * Direct unit test against AdapterProtocolServer's command-handling surface
 * with a fake harness whose runTurn yields slowly so the server is observed
 * mid-flight when a second submit_text arrives.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AdapterProtocolServer } from "../src/adapter-protocol/server.js";
import type { OrchestratorHarness } from "../src/harness/types.js";
import type { AdapterEvent } from "../src/shared/events.js";
import { createTokenValidator } from "../src/adapter-protocol/token-validator.js";

const PAIRING = "test-pairing-secret";

function makeSlowHarness(): {
  harness: OrchestratorHarness;
  startedTurns: string[];
  release: () => void;
} {
  const startedTurns: string[] = [];
  let releaseDeferred: () => void = () => {};
  const releasePromise = new Promise<void>((resolve) => {
    releaseDeferred = resolve;
  });

  const harness: OrchestratorHarness = {
    provider: "test-target",
    capabilities: {
      supports_confirmed_cancellation: true,
      survives_interruption: true,
      reliable_session_end: true,
      voice_certified: true,
    },
    async *runTurn(req): AsyncIterable<AdapterEvent> {
      startedTurns.push(req.correlation_id);
      // Race: external `release()` OR an inbound abort. Abort needs to win
      // for submit_with_steer's cancel handshake to complete.
      const aborted = new Promise<"abort">((resolve) => {
        if (req.abortSignal?.aborted) resolve("abort");
        req.abortSignal?.addEventListener("abort", () => resolve("abort"));
      });
      const won = await Promise.race([
        releasePromise.then(() => "release" as const),
        aborted,
      ]);
      if (won === "abort") {
        yield {
          type: "cancel_confirmed",
          raw: undefined,
        } as unknown as AdapterEvent;
        return;
      }
      yield {
        type: "session_end",
        subtype: "success",
        result: undefined,
        raw: undefined,
      } as unknown as AdapterEvent;
    },
  };

  return { harness, startedTurns, release: () => releaseDeferred() };
}

function makeServer(harness: OrchestratorHarness): {
  server: AdapterProtocolServer;
  sent: any[];
} {
  const sent: any[] = [];
  const server = new AdapterProtocolServer({
    deps: {
      relayUrl: "https://example.invalid",
      userId: "alpha",
      pairingToken: PAIRING,
      sessionTokenSecret: PAIRING,
      auditLogPath: join(mkdtempSync(join(tmpdir(), "audit-")), "a.jsonl"),
      catchAllLoggerEnabled: false,
    },
    harnesses: { "test-target": harness },
  });

  // Patch the private `send` method to capture envelopes that would have
  // been written to the WebSocket. The test never opens a real socket.
  (server as unknown as { send: (e: unknown) => void }).send = (env) => {
    sent.push(env);
  };

  return { server, sent };
}

function makeEnvelope(
  cmdKind: "submit_text" | "submit_with_steer" | "cancel",
  correlationId: string,
  payload: Record<string, unknown>,
  sessionToken: string,
): string {
  return JSON.stringify({
    protocol_version: "1.0",
    kind: "harness_command",
    id: `env-${correlationId}`,
    timestamp: new Date().toISOString(),
    session_token: sessionToken,
    payload: {
      kind: cmdKind,
      correlation_id: correlationId,
      target: "test-target",
      payload,
    },
  });
}

test("busy-invariant: second submit_text against busy target is rejected", async () => {
  const validator = createTokenValidator(PAIRING);
  const sessionToken = validator.issue({
    session_id: "s1",
    expires_at: Math.floor(Date.now() / 1000) + 60,
  });

  const { harness, startedTurns, release } = makeSlowHarness();
  const { server, sent } = makeServer(harness);

  // Drive onMessage directly via the private surface — equivalent to a
  // relay-delivered envelope.
  const onMessage = (server as unknown as { onMessage: (raw: string) => Promise<void> })
    .onMessage.bind(server);

  // First submit_text starts a turn; runTurn awaits release.
  const firstPromise = onMessage(
    makeEnvelope("submit_text", "turn-1", { text: "hello" }, sessionToken),
  );
  // Yield to let the turn register its active correlation.
  await new Promise((r) => setTimeout(r, 10));

  // Second submit_text arrives mid-flight — must be rejected with an
  // error_response, NOT start a second concurrent turn.
  await onMessage(
    makeEnvelope("submit_text", "turn-2", { text: "world" }, sessionToken),
  );

  // Now release the first turn so we can finish.
  release();
  await firstPromise;

  assert.deepEqual(startedTurns, ["turn-1"], "only one turn ran on the harness");

  // Find the rejection error_response for turn-2.
  const rejections = sent
    .map((e: any) => e?.payload)
    .filter(
      (p: any) =>
        p?.type === "error" || (p?.type === "error_response" && p?.error),
    );
  const turn2Errors = sent.filter(
    (e: any) =>
      (e?.payload?.type === "error" && e?.payload?.correlation_id === "turn-2") ||
      (e?.payload?.type === "error_response" &&
        String(e?.payload?.error?.message ?? "").includes("turn-2")),
  );
  assert.ok(
    turn2Errors.length >= 1 ||
      rejections.some((p: any) =>
        String(p?.message ?? p?.error?.message ?? "").includes("busy"),
      ),
    "turn-2 should have been rejected with a busy / error response",
  );
});

test("busy-invariant: submit_with_steer is allowed mid-flight (preempts)", async () => {
  const validator = createTokenValidator(PAIRING);
  const sessionToken = validator.issue({
    session_id: "s1",
    expires_at: Math.floor(Date.now() / 1000) + 60,
  });

  const { harness, release } = makeSlowHarness();
  const { server, sent } = makeServer(harness);
  const onMessage = (server as unknown as { onMessage: (raw: string) => Promise<void> })
    .onMessage.bind(server);

  const firstPromise = onMessage(
    makeEnvelope("submit_text", "turn-1", { text: "hello" }, sessionToken),
  );
  await new Promise((r) => setTimeout(r, 10));

  // submit_with_steer should NOT be rejected with the busy error — preemption
  // is the legit way to interrupt a turn. Release the slow harness so the
  // second turn (which the steer starts) can complete.
  const steerPromise = onMessage(
    makeEnvelope(
      "submit_with_steer",
      "turn-2",
      { text: "different", cancels_correlation_id: "turn-1" },
      sessionToken,
    ),
  );
  // Give the steer path a moment to fire its cancel handshake against
  // turn-1's harness, then release so turn-2's harness can finish too.
  await new Promise((r) => setTimeout(r, 20));
  release();
  await Promise.all([firstPromise, steerPromise]);

  // No "busy" error should have been emitted.
  const busyErrors = sent.filter((e: any) =>
    String(e?.payload?.error?.message ?? "").includes("busy"),
  );
  assert.equal(busyErrors.length, 0, "submit_with_steer must not get the busy error");
});
