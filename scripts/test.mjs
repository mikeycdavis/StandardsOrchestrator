/**
 * The test entry point: `npm test`.
 *
 * WHY THIS EXISTS. `node --test "test/*.test.mjs"` does not mean the same thing everywhere. Node
 * expands a glob itself only from v21; the hosted job runs Node 20, which takes the quoted pattern as
 * a literal file name and fails with "Could not find '.../test/*.test.mjs'". Dropping the quotes
 * relies on a POSIX shell to expand it, which npm's Windows shell (cmd) does not. The directory form
 * (`node --test test/`) works on Node 20 and fails on Node 22 and 24. No single pattern is correct on
 * every supported Node and operating system, so the files are enumerated here, with no shell and no
 * glob, and handed to `node --test` explicitly.
 *
 * WHAT IT REFUSES. An empty file list is a failure, never a pass. A runner that finds nothing and
 * exits 0 is the quiet way for a test suite to stop testing.
 *
 * Usage: node scripts/test.mjs [directory]     (default: test/ at the repository root)
 * Zero dependencies.
 */

import { readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The `*.test.mjs` files directly inside `dir`, sorted. Not recursive: fixtures live in subfolders. */
export function discoverTests(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

/** Returns the exit code the process should end with. */
export function runTests(dir = path.join(ROOT, "test")) {
  let files;
  try {
    files = discoverTests(dir);
  } catch (error) {
    console.error(`test runner: cannot read the test directory '${dir}': ${error.message}`);
    return 1;
  }
  if (files.length === 0) {
    console.error(`test runner: no *.test.mjs files found in '${dir}'. Zero tests is a failure, not a pass.`);
    return 1;
  }
  const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
  if (result.error) {
    console.error(`test runner: could not start node --test: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(runTests(process.argv[2] ? path.resolve(process.argv[2]) : undefined));
}
