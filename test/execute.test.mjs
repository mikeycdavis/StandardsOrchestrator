/**
 * Tests for acquisition, execution, and the combined report.
 *
 * Acquisition is tested against real local git repositories, so the fetch-by-SHA and checkout
 * semantics are git's own. Execution uses a stub pack — a real Node script that prints a real envelope
 * and exits with a chosen code — rather than a mocked spawn, so the argv, exit code, and stdout paths
 * are genuinely exercised.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquire, execute } from "../scripts/execute.mjs";
import { buildReport, renderReport, exitCodeFor } from "../scripts/report.mjs";
import { loadRegistry, resolveAdapter } from "../scripts/registry.mjs";

const registry = await loadRegistry();
const betting = resolveAdapter(registry, "betting", "1.0.0");
const prediction = resolveAdapter(registry, "prediction", "1.1.0");

const IDENTITY = ["-c", "user.email=f@example.invalid", "-c", "user.name=F", "-c", "commit.gpgsign=false"];
const git = (cwd, ...args) => spawnSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" });

const cleanup = [];
test.after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true });
});

/** A local repository standing in for a published pack, with a stub entry point at a known commit. */
async function makePackRepo(entrySource) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "so-pack-"));
  cleanup.push(dir);
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "VERSION"), "1.0.0\n", "utf8");
  const scripts = path.join(dir, "scripts");
  await mkdir(scripts, { recursive: true });
  writeFileSync(path.join(scripts, "standards.mjs"), entrySource, "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "release");
  const commit = git(dir, "rev-parse", "HEAD").stdout.trim();
  return { dir, commit };
}

const STUB = (envelope, exitCode) =>
  [
    "const argv = process.argv.slice(2);",
    `process.stdout.write(JSON.stringify(${JSON.stringify(envelope)}));`,
    "process.stderr.write(JSON.stringify(argv));",
    `process.exit(${exitCode});`,
  ].join("\n");

const COMPLIANT = {
  schemaVersion: "1.0",
  status: "COMPLIANT",
  score: 94,
  denominator: { total: 51, applicable: 30, scored: 18 },
  frameworkCoverage: { cataloguedRules: 51, evaluatedRules: 41, note: "framework maturity" },
};

// ---------------------------------------------------------------------------------------------
// Acquisition.
// ---------------------------------------------------------------------------------------------

test("acquisition fetches exactly the pinned commit and verifies it on disk", async () => {
  // ls-remote proved the tag points at this commit. This proves the working tree IS that commit —
  // a different claim, and the one that covers the code about to run.
  const pack = await makePackRepo(STUB(COMPLIANT, 0));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "so-ws-"));
  cleanup.push(workspace);

  const acquired = await acquire(
    { pack: "betting", version: "1.0.0", repository: pack.dir, commit: pack.commit },
    { workspace },
  );
  assert.equal(acquired.ok, true, JSON.stringify(acquired.failure));
  assert.equal(acquired.commit, pack.commit);
});

test("ADVERSARIAL: acquisition of a commit the remote does not have is UNRESOLVED", async () => {
  const pack = await makePackRepo(STUB(COMPLIANT, 0));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "so-ws-"));
  cleanup.push(workspace);

  const acquired = await acquire(
    { pack: "betting", version: "1.0.0", repository: pack.dir, commit: "0".repeat(40) },
    { workspace },
  );
  assert.equal(acquired.ok, false);
  assert.equal(acquired.failure.class, "UNRESOLVED");
  assert.notEqual(acquired.failure.class, "FAIL", "failing to obtain an authority is not the project's fault");
});

test("ADVERSARIAL: a workspace that lands on the wrong commit is UNRESOLVED", async () => {
  // The post-checkout verification, provoked by a git runner that fetches one commit and reports
  // another. Without the second check, the run would execute code nobody pinned.
  const pack = await makePackRepo(STUB(COMPLIANT, 0));
  const workspace = await mkdtemp(path.join(os.tmpdir(), "so-ws-"));
  cleanup.push(workspace);

  const acquired = await acquire(
    { pack: "betting", version: "1.0.0", repository: pack.dir, commit: pack.commit },
    {
      workspace,
      run: (cwd, args) =>
        args[0] === "rev-parse"
          ? { status: 0, stdout: `${"f".repeat(40)}\n`, stderr: "" }
          : { status: 0, stdout: "", stderr: "" },
    },
  );
  assert.equal(acquired.ok, false);
  assert.equal(acquired.failure.reasonCode, "COMMIT_MISMATCH");
});

test("an unreachable repository is UNRESOLVED, not a verdict", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "so-ws-"));
  cleanup.push(workspace);
  const acquired = await acquire(
    { pack: "betting", version: "1.0.0", repository: path.join(os.tmpdir(), "so-absent"), commit: "a".repeat(40) },
    { workspace },
  );
  assert.equal(acquired.failure.class, "UNRESOLVED");
});

// ---------------------------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------------------------

async function runStub(resolved, envelope, exitCode, options = {}) {
  const pack = await makePackRepo(STUB(envelope, exitCode));
  const project = await mkdtemp(path.join(os.tmpdir(), "so-proj-"));
  cleanup.push(project);
  return execute(
    { ...resolved, commit: pack.commit },
    { projectRoot: project, packRoot: pack.dir, ...options },
  );
}

test("a pack that runs and passes its evidence gate is PASS", async () => {
  const result = await runStub(betting, COMPLIANT, 0);
  assert.equal(result.class, "PASS");
  assert.equal(result.verdict, "COMPLIANT");
  assert.equal(result.exitCode, 0);
});

test("the target is passed absolutely, from the adapter's own template", async () => {
  // Omitting it would let a release default to its own fixtures and grade something else entirely.
  const result = await runStub(betting, COMPLIANT, 0);
  const dirArgument = result.invocation.argv.find((a) => a.startsWith("--dir="));
  assert.ok(dirArgument, "the template's target placeholder must be substituted");
  assert.equal(path.isAbsolute(dirArgument.slice("--dir=".length)), true);
  assert.equal(result.invocation.argv[0], "validate", "the verdict subcommand comes first, as declared");
});

test("ADVERSARIAL: a missing policy file is INDETERMINATE, never FAIL", async () => {
  // This release exits 1 from an unhandled error when its policy is absent. Verified here first, so a
  // configuration fault cannot arrive at the gate wearing the shape of failing work.
  const result = await runStub(prediction, {}, 0, { policyPath: path.join(os.tmpdir(), "so-no-policy.yml") });
  assert.equal(result.class, "INDETERMINATE");
  assert.notEqual(result.class, "FAIL");
  assert.match(result.detail, /does not exist/);
});

test("a release that requires a policy path and is given none does not run", async () => {
  const result = await runStub(prediction, {}, 0);
  assert.equal(result.class, "INDETERMINATE");
  assert.match(result.detail, /requires an explicit policy path/);
});

test("the pack's own verdict is reported beside the orchestrator's class", async () => {
  const result = await runStub(betting, { ...COMPLIANT, status: "NON_COMPLIANT" }, 1);
  assert.equal(result.class, "FAIL");
  assert.equal(result.verdict, "NON_COMPLIANT");
});

test("ADVERSARIAL: an undeclared exit code does not become a verdict", async () => {
  const result = await runStub(betting, COMPLIANT, 3);
  assert.equal(result.class, "INDETERMINATE");
  assert.match(result.detail, /no longer matches the release/);
});

test("the mitigations that shaped the invocation are reported, not silently applied", async () => {
  const result = await runStub(betting, COMPLIANT, 0);
  assert.ok(result.hazardsMitigated.length > 0);
  assert.ok(result.hazardsMitigated.some((m) => /absolute --dir/.test(m)));
});

test("a pack that cannot be started is INDETERMINATE", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "so-proj-"));
  cleanup.push(project);
  const result = await execute(betting, {
    projectRoot: project,
    packRoot: path.join(os.tmpdir(), "so-absent-pack"),
    spawn: () => ({ error: new Error("ENOENT"), status: null, stdout: "", stderr: "" }),
  });
  assert.equal(result.class, "INDETERMINATE");
  assert.match(result.detail, /could not be started/);
});

test("a pack killed on timeout is INDETERMINATE, not a negative conclusion", async () => {
  const project = await mkdtemp(path.join(os.tmpdir(), "so-proj-"));
  cleanup.push(project);
  const result = await execute(betting, {
    projectRoot: project,
    packRoot: os.tmpdir(),
    spawn: () => ({ error: null, signal: "SIGTERM", status: null, stdout: "", stderr: "" }),
  });
  assert.equal(result.class, "INDETERMINATE");
  assert.match(result.detail, /without concluding/);
});

// ---------------------------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------------------------

const authority = (over) => ({
  authority: "betting@1.0.0",
  pack: "betting",
  version: "1.0.0",
  applicability: "CONFIRMED",
  disposition: "APPLICABLE",
  declaration: "REQUIRED",
  detection: "DETECTED",
  evidence: [],
  class: "PASS",
  verdict: "COMPLIANT",
  ...over,
});

test("the six outcome classes survive to the JSON", async () => {
  // The gate result answers "may this merge". It is not a replacement for why, and a reader of only
  // the top-level outcome would learn that something is wrong without learning what.
  const report = buildReport({
    project: "p",
    authorities: [
      authority({ pack: "prediction", authority: "prediction@1.1.0", class: "UNRESOLVED", verdict: null }),
      authority({ class: "PASS", dependencyStatus: "unsatisfied", dependencyReason: "prediction@1.1.0: unresolved" }),
    ],
  });

  assert.equal(report.outcome, "FAIL");
  const serialised = JSON.stringify(report);
  assert.ok(serialised.includes("UNRESOLVED"), "the per-authority class must survive serialisation");
  assert.equal(report.authorities[0].class, "UNRESOLVED");
  assert.equal(report.authorities[1].class, "PASS", "a dependent's own verdict is not rewritten");
  assert.equal(report.authorities[1].dependencyStatus, "unsatisfied");
});

test("coverage is per authority and there is no portfolio total", async () => {
  const report = buildReport({
    project: "p",
    authorities: [
      authority({ coverage: { cataloguedRules: 51, evaluatedRules: 41 } }),
      authority({
        pack: "prediction",
        authority: "prediction@1.1.0",
        verdict: "SUPPORTED",
        coverage: { basis: "perRecord", records: [{ file: "a.json" }] },
      }),
    ],
  });

  assert.deepEqual(Object.keys(report.coverage).sort(), ["betting", "prediction"]);
  assert.deepEqual(report.coverage.betting, { cataloguedRules: 51, evaluatedRules: 41 });
  assert.equal(report.coverage.prediction.basis, "perRecord");
  for (const forbidden of ["total", "percentage", "combined", "score", "overall"]) {
    assert.equal(forbidden in report.coverage, false, `must not carry '${forbidden}'`);
  }
  assert.match(renderReport(report), /never combined; there is no portfolio total/);
});

test("the exit contract: 0 only for PASS, and never 2 from a report", async () => {
  assert.equal(exitCodeFor(buildReport({ project: "p", authorities: [authority()] })), 0);
  for (const cls of ["FAIL", "BLOCKED", "INDETERMINATE", "UNRESOLVED", "CONFLICT"]) {
    const report = buildReport({ project: "p", authorities: [authority({ class: cls })] });
    assert.equal(exitCodeFor(report), 1, cls);
    assert.notEqual(exitCodeFor(report), 2, "a broken orchestrator is never reported as non-compliance");
  }
});

test("an empty portfolio does not exit 0", async () => {
  const report = buildReport({ project: "p", authorities: [] });
  assert.equal(report.outcome, "INDETERMINATE");
  assert.equal(exitCodeFor(report), 1);
});

test("the rendering names the remedy for every non-passing authority", async () => {
  const report = buildReport({
    project: "p",
    authorities: [
      authority({
        pack: "prediction",
        authority: "prediction@1.1.0",
        class: "UNRESOLVED",
        verdict: null,
        resolution: { status: "unresolved", reasonCode: "REF_NOT_FOUND", detail: "no such tag" },
      }),
    ],
  });
  const text = renderReport(report);
  assert.match(text, /Standards gate: FAIL/);
  assert.match(text, /resolution     unresolved — REF_NOT_FOUND/);
  assert.match(text, /prediction: UNRESOLVED/);
});
