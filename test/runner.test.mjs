/**
 * The test runner (scripts/test.mjs) must never turn "found nothing" into "passed".
 *
 * Each case runs the real runner as a child process against a temporary directory, so the shipped
 * suite is untouched. NODE_TEST_CONTEXT is removed from the child's environment: left in, a nested
 * `node --test` believes it is a worker of this run and prints nothing the exit code could be judged on.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTests } from "../scripts/test.mjs";

const RUNNER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "test.mjs");
const cleanup = [];
test.after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true });
});

async function tempDir(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "so-runner-"));
  cleanup.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

function runRunner(dir) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [RUNNER, dir], { encoding: "utf8", env });
}

const PASSING = 'import test from "node:test";\ntest("ok", () => {});\n';
const FAILING = 'import test from "node:test";\nimport assert from "node:assert";\ntest("bad", () => assert.equal(1, 2));\n';

test("ZERO DISCOVERY: an empty directory exits non-zero and says why", async () => {
  const result = runRunner(await tempDir({}));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no \*\.test\.mjs files found/);
});

test("ZERO DISCOVERY: files that are not *.test.mjs do not count as tests", async () => {
  const dir = await tempDir({ "helper.mjs": PASSING, "notes.md": "x", "nested/deep.test.mjs": PASSING });
  const result = runRunner(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no \*\.test\.mjs files found/);
});

test("ZERO DISCOVERY: a missing directory exits non-zero", async () => {
  const dir = await tempDir({});
  const result = runRunner(path.join(dir, "does-not-exist"));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot read the test directory/);
});

test("a passing test file is run and the runner exits 0", async () => {
  const result = runRunner(await tempDir({ "a.test.mjs": PASSING }));
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /tests 1\b/);
});

test("a failing test file makes the runner exit non-zero", async () => {
  const result = runRunner(await tempDir({ "a.test.mjs": PASSING, "b.test.mjs": FAILING }));
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /fail 1\b/);
});

test("discovery is sorted, direct-children only, and finds this repository's own suite", async () => {
  const dir = await tempDir({ "b.test.mjs": PASSING, "a.test.mjs": PASSING, "sub/c.test.mjs": PASSING });
  assert.deepEqual(discoverTests(dir).map((f) => path.basename(f)), ["a.test.mjs", "b.test.mjs"]);
  const own = discoverTests(path.dirname(fileURLToPath(import.meta.url)));
  assert.ok(own.length >= 10, `expected the real suite, found ${own.length} files`);
  assert.ok(own.some((f) => f.endsWith("runner.test.mjs")));
});
