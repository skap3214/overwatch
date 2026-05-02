// CI guard: regenerate protocol types and fail if anything changed.
// Catches schema edits that didn't refresh the generated TS/Python.
//
// Run via: npm run protocol:check

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
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
const pyDir = join(
  repoRoot,
  "pipecat",
  "overwatch_pipeline",
  "protocol",
  "generated"
);

function readSafely(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

// Snapshot every generated python file (multi-file output from
// datamodel-code-generator). Drift detection compares the full set —
// added, removed, or modified files all count as drift.
function snapshotDir(dir) {
  const snapshot = {};
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return snapshot;
  }
  for (const name of entries) {
    if (!name.endsWith(".py")) continue;
    const full = join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
    } catch {
      continue;
    }
    snapshot[name] = readSafely(full);
  }
  return snapshot;
}

function diffSnapshots(before, after, dir) {
  const drifted = [];
  const allKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of allKeys) {
    if (before[key] !== after[key]) drifted.push(join(dir, key));
  }
  return drifted;
}

const tsBefore = readSafely(tsFile);
const pyBefore = snapshotDir(pyDir);

const result = spawnSync("npm", ["run", "protocol:gen"], {
  cwd: repoRoot,
  stdio: "inherit",
});
if (result.status !== 0) {
  console.error("protocol:gen failed");
  process.exit(result.status || 1);
}

const tsAfter = readSafely(tsFile);
const pyAfter = snapshotDir(pyDir);

const drifted = [];
if (tsBefore !== tsAfter) drifted.push(tsFile);
drifted.push(...diffSnapshots(pyBefore, pyAfter, pyDir));

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
