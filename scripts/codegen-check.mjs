// CI guard: regenerate protocol types and fail if anything changed.
// Catches schema edits that didn't refresh the generated TS/Python.
//
// Run via: npm run protocol:check

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const tsFile = join(
  repoRoot,
  "packages",
  "shared",
  "src",
  "protocol",
  "types.generated.ts"
);
const pyFile = join(
  repoRoot,
  "pipecat",
  "overwatch_pipeline",
  "protocol",
  "types_generated.py"
);

function readSafely(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

const tsBefore = readSafely(tsFile);
const pyBefore = readSafely(pyFile);

const result = spawnSync("npm", ["run", "protocol:gen"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (result.status !== 0) {
  console.error("protocol:gen failed");
  process.exit(result.status || 1);
}

const tsAfter = readSafely(tsFile);
const pyAfter = readSafely(pyFile);

const drifted = [];
if (tsBefore !== tsAfter) drifted.push(tsFile);
if (pyBefore !== pyAfter) drifted.push(pyFile);

if (drifted.length > 0) {
  console.error("\nProtocol codegen drift detected:");
  for (const f of drifted) console.error(`  ${f}`);
  console.error(
    "\nThe schema in /protocol/schema/ changed but generated types were not regenerated."
  );
  console.error("Run `npm run protocol:gen` and commit the result.");
  process.exit(1);
}

console.log("Protocol types are up to date.");
