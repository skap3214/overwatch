import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ClaudeCodeCliHarness } from "../src/harness/claude-code-cli.js";

test("claude cli history chain: second invocation resumes first session id", async () => {
  const spawnedArgs: string[][] = [];
  const spawnImpl = ((_cmd: string, args: string[]) => {
    spawnedArgs.push(args);
    const child = new EventEmitter() as any;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdout.on("end", () => {
      setTimeout(() => child.emit("close", 0), 0);
    });

    process.nextTick(() => {
      child.stdout.write(
        `${JSON.stringify({
          type: "system",
          subtype: "init",
          session_id: "sess-abc",
        })}\n`,
      );
      child.stdout.write(
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          result: "ok",
        })}\n`,
      );
      child.stdout.end();
    });
    return child;
  }) as any;

  const harness = new ClaudeCodeCliHarness({
    claudePath: "claude",
    spawnImpl,
  });

  for await (const _ of harness.runTurn({ prompt: "one", correlation_id: "c1" })) {}
  for await (const _ of harness.runTurn({ prompt: "two", correlation_id: "c2" })) {}

  assert.equal(spawnedArgs.length, 2);
  assert.equal(spawnedArgs[0].includes("--resume"), false);
  const resumeIndex = spawnedArgs[1].indexOf("--resume");
  assert.notEqual(resumeIndex, -1);
  assert.equal(spawnedArgs[1][resumeIndex + 1], "sess-abc");
});
