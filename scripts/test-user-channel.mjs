#!/usr/bin/env node
/**
 * Smoke-tests the relay's UserChannel by connecting two WebSocket peers
 * (a fake "host" and a fake "orchestrator") and exchanging JSON envelopes
 * between them.
 *
 * Verifies:
 *   - Both peers can connect with a matching pairing token
 *   - A second connection with a wrong token is rejected (403)
 *   - JSON sent from orchestrator arrives at host
 *   - JSON sent from host arrives at orchestrator
 *   - peer_connected notifications fire
 *
 * Run: node scripts/test-user-channel.mjs
 */

import WebSocket from "ws";

const RELAY = process.env.RELAY_URL ?? "wss://overwatch-relay.soami.workers.dev";
const USER_ID = `e2e-${Date.now()}`;
const TOKEN = "test-token-abc";
const BAD_TOKEN = "wrong-token-xyz";

function url(role, token) {
  const base = RELAY.replace(/^https?:\/\//, "wss://").replace(/\/+$/, "");
  return `${base}/api/users/${USER_ID}/ws/${role}?token=${token}`;
}

function open(role, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url(role, token));
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (req, res) =>
      reject(new Error(`unexpected ${res.statusCode} for ${role}`)),
    );
  });
}

const received = { host: [], orchestrator: [] };

function setupReceiver(ws, role) {
  ws.on("message", (raw) => {
    try {
      const parsed = JSON.parse(raw.toString());
      received[role].push(parsed);
    } catch {
      received[role].push({ raw: raw.toString() });
    }
  });
}

async function expectMessage(role, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = received[role].find(predicate);
    if (found) return found;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(
    `timeout waiting on ${role}; received: ${JSON.stringify(received[role])}`,
  );
}

async function main() {
  console.log(`==> Testing UserChannel for user ${USER_ID}`);

  // 1. Host connects first.
  const host = await open("host", TOKEN);
  setupReceiver(host, "host");
  console.log("✓ host connected");

  // 2. Orchestrator connects with matching token.
  const orchestrator = await open("orchestrator", TOKEN);
  setupReceiver(orchestrator, "orchestrator");
  console.log("✓ orchestrator connected");

  // 3. Host should have received peer_connected for orchestrator.
  await expectMessage(
    "host",
    (m) =>
      m.type === "channel.peer_connected" && m.role === "orchestrator",
  );
  console.log("✓ host got peer_connected:orchestrator");

  // 4. Orchestrator → host
  const cmd = {
    protocol_version: "1.0",
    kind: "harness_command",
    id: "msg-1",
    timestamp: new Date().toISOString(),
    payload: {
      kind: "submit_text",
      correlation_id: "turn-1",
      target: "claude-code",
      payload: { text: "hello" },
    },
  };
  orchestrator.send(JSON.stringify(cmd));
  await expectMessage("host", (m) => m.kind === "harness_command");
  console.log("✓ command from orchestrator routed to host");

  // 5. Host → orchestrator
  const evt = {
    protocol_version: "1.0",
    kind: "harness_event",
    id: "msg-2",
    timestamp: new Date().toISOString(),
    payload: {
      type: "text_delta",
      correlation_id: "turn-1",
      target: "claude-code",
      text: "Hi there",
      raw: null,
    },
  };
  host.send(JSON.stringify(evt));
  await expectMessage(
    "orchestrator",
    (m) => m.kind === "harness_event" && m.payload?.text === "Hi there",
  );
  console.log("✓ event from host routed to orchestrator");

  // 6. Bad token rejected.
  let rejected = false;
  try {
    await open("orchestrator", BAD_TOKEN);
  } catch (err) {
    rejected = err.message.includes("403") || err.message.includes("ECONN");
  }
  if (!rejected) throw new Error("bad-token connect was NOT rejected");
  console.log("✓ wrong token rejected");

  // 7. Cleanup
  host.close();
  orchestrator.close();

  console.log("\n✅ UserChannel routing verified end-to-end.");
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
