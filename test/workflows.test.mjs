/**
 * The enforcement workflows, checked structurally.
 *
 * The shipped files must lint clean, and — more importantly — each mutation that would reintroduce a
 * known false-enforcement mode must be caught. A linter that passes everything is decoration.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lintReusable, lintCaller, lintShippedWorkflows, PIN_PLACEHOLDER } from "../scripts/workflows.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REUSABLE = path.join(ROOT, ".github", "workflows", "validate.yml");
const CALLER = path.join(ROOT, "templates", "caller", "standards.yml");

const reusable = await readFile(REUSABLE, "utf8");
const caller = await readFile(CALLER, "utf8");

/** A caller with the placeholder replaced, as an adopting repository would have it. */
const PINNED = "0123456789abcdef0123456789abcdef01234567";
const adopted = caller.replaceAll(PIN_PLACEHOLDER, PINNED).replaceAll("ORCHESTRATOR_OWNER", "an-org");

test("the shipped workflows lint clean", async () => {
  for (const { file, problems } of await lintShippedWorkflows(ROOT)) {
    assert.deepEqual(problems, [], `${path.basename(file)}: ${problems.join("; ")}`);
  }
});

test("a caller with the placeholder replaced by a real commit lints clean", () => {
  assert.deepEqual(lintCaller(adopted), []);
});

// --- skipped-job mutations ----------------------------------------------------------------------

test("MUTATION: a path filter on the caller is rejected", () => {
  const mutated = adopted.replace("  pull_request:\n", "  pull_request:\n    paths:\n      - src/**\n");
  const problems = lintCaller(mutated);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /sits pending/);
});

test("MUTATION: a job-level condition on the caller is rejected", () => {
  const mutated = adopted.replace("    name: Standards\n", "    name: Standards\n    if: github.event_name == 'push'\n");
  assert.match(lintCaller(mutated).join(" "), /conditional check is not a required check/);
});

test("MUTATION: a second job splits the check identity and is rejected", () => {
  const mutated = `${adopted}\n  extra:\n    name: Extra\n    runs-on: ubuntu-latest\n`;
  assert.match(lintCaller(mutated).join(" "), /one stable check identity/);
});

test("MUTATION: a caller that does not trigger on pull_request is rejected", () => {
  const mutated = adopted.replace("  pull_request:\n", "");
  assert.match(lintCaller(mutated).join(" "), /cannot gate a merge/);
});

// --- swallowed-failure mutations ------------------------------------------------------------------

test("MUTATION: continue-on-error on the gate step is rejected", () => {
  const mutated = reusable.replace(
    "      - name: Run the standards gate\n",
    "      - name: Run the standards gate\n        continue-on-error: true\n",
  );
  assert.match(lintReusable(mutated).join(" "), /report as success/);
});

test("MUTATION: appending `|| true` to the gate command is rejected", () => {
  const mutated = reusable.replace("--out=gate-record'\n\n      #", "--out=gate-record || true'\n\n      #");
  assert.match(lintReusable(mutated).join(" "), /can turn a failure into a pass/);
});

test("MUTATION: removing the always() guard is rejected", () => {
  const mutated = reusable.replace("        if: ${{ always() }}\n", "");
  assert.match(lintReusable(mutated).join(" "), /no terminal result/);
});

test("MUTATION: demoting the guard from the last step is rejected", () => {
  const mutated = `${reusable}\n      - name: Something afterwards\n        run: 'echo done'\n`;
  assert.match(lintReusable(mutated).join(" "), /not the last step/);
});

// --- floating-engine mutations --------------------------------------------------------------------

test("MUTATION: a caller pinned to a branch is rejected", () => {
  const mutated = caller.replaceAll(PIN_PLACEHOLDER, "main").replaceAll("ORCHESTRATOR_OWNER", "an-org");
  assert.match(lintCaller(mutated).join(" "), /not a 40-character commit SHA/);
});

test("MUTATION: a caller pinned to a tag is rejected", () => {
  const mutated = caller.replaceAll(PIN_PLACEHOLDER, "v1.0.0").replaceAll("ORCHESTRATOR_OWNER", "an-org");
  assert.match(lintCaller(mutated).join(" "), /not a 40-character commit SHA/);
});

test("MUTATION: an engine checked out at a branch rather than the invoked commit is rejected", () => {
  const mutated = reusable.replace("          ref: ${{ github.workflow_sha }}\n", "          ref: main\n");
  assert.match(lintReusable(mutated).join(" "), /need not be the engine the caller pinned/);
});

test("the unreplaced placeholder is a template affordance, not a valid pin", () => {
  // It lints clean as a template and fails as a caller. Shipping the template must not make an
  // unfinished adoption look finished.
  assert.deepEqual(lintCaller(caller, { template: true }), []);
  assert.match(lintCaller(caller).join(" "), /not a 40-character commit SHA/);
});

// --- missing-invocation ---------------------------------------------------------------------------

test("MUTATION: a caller that no longer invokes the orchestrator is rejected", () => {
  const mutated = adopted.replace(
    /    uses: .*\n/,
    "    runs-on: ubuntu-latest\n    steps:\n      - run: 'echo standards ok'\n",
  );
  assert.match(lintCaller(mutated).join(" "), /does not invoke the orchestrator/);
});

test("MUTATION: a caller invoking some other workflow is rejected", () => {
  const mutated = adopted.replace("/.github/workflows/validate.yml@", "/.github/workflows/lint.yml@");
  assert.match(lintCaller(mutated).join(" "), /does not invoke the orchestrator/);
});

test("a repository with no caller at all passes every check here, which is the honest limit", () => {
  // Stated as a test so the gap cannot be forgotten: these checks read a file that exists. Whether the
  // file exists, and whether its check is registered as required, is the portfolio audit's question.
  assert.deepEqual(lintCaller("on:\n  pull_request:\njobs:\n  standards:\n    uses: o/StandardsOrchestrator/.github/workflows/validate.yml@" + PINNED + "\n"), []);
});
