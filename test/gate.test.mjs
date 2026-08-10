/**
 * The terminality contract.
 *
 * Every test here is about one question: can this check end in anything other than a terminal
 * result, and can anything other than a genuine PASS end in a green one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGate, verifyGate, TERMINAL } from "../scripts/gate.mjs";

const cleanup = [];
test.after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true });
});

async function scratch() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "so-gate-"));
  cleanup.push(dir);
  return dir;
}

/** A report of the shape buildReport produces, reduced to the fields the gate reads. */
const reportOf = (outcome, reasons = []) => ({
  schemaVersion: "1.0.0",
  project: "fixture",
  outcome,
  reasons,
  authorities: [],
  coverage: {},
});

const stub = (outcome, reasons) => async () => reportOf(outcome, reasons);

// --- run ---------------------------------------------------------------------------------------

test("a passing run records a report and exits 0", async () => {
  const out = path.join(await scratch(), "record");
  const result = await runGate({ projectRoot: ".", outDir: out, orchestrateFn: stub("PASS") });

  assert.equal(result.exitCode, TERMINAL.PASS);
  assert.equal(result.status.kind, "report");
  const written = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
  assert.equal(written.outcome, "PASS");
});

test("a failing gate exits 1 and records the failure", async () => {
  const out = path.join(await scratch(), "record");
  const result = await runGate({
    projectRoot: ".",
    outDir: out,
    orchestrateFn: stub("FAIL", [{ pack: "betting", reason: "unsatisfied prerequisite" }]),
  });

  assert.equal(result.exitCode, TERMINAL.GATE_FAILURE);
  assert.equal(result.status.outcome, "FAIL");
});

test("an engine that cannot run records a fault, not a finding", async () => {
  const out = path.join(await scratch(), "record");
  const result = await runGate({
    projectRoot: ".",
    outDir: out,
    orchestrateFn: async () => {
      throw new Error("registry/packs.json could not be read");
    },
  });

  assert.equal(result.exitCode, TERMINAL.ENFORCEMENT_FAULT);
  assert.equal(result.status.kind, "fault");
  assert.equal(result.status.outcome, null);
  assert.match(result.text, /not a conclusion about this project/);
  // The record survives the crash, so the guard step has something to read back.
  const status = JSON.parse(await readFile(path.join(out, "status.json"), "utf8"));
  assert.equal(status.kind, "fault");
});

// --- verify ------------------------------------------------------------------------------------

test("verify honours a genuine pass", async () => {
  const out = path.join(await scratch(), "record");
  await runGate({ projectRoot: ".", outDir: out, orchestrateFn: stub("PASS") });
  const verdict = await verifyGate({ outDir: out });

  assert.equal(verdict.exitCode, TERMINAL.PASS);
  assert.equal(verdict.kind, "verified");
});

test("verify carries a gate failure through unchanged", async () => {
  const out = path.join(await scratch(), "record");
  await runGate({ projectRoot: ".", outDir: out, orchestrateFn: stub("BLOCKED", [{ reason: "a prohibition fired" }]) });
  const verdict = await verifyGate({ outDir: out });

  assert.equal(verdict.exitCode, TERMINAL.GATE_FAILURE);
  assert.match(verdict.message, /BLOCKED/);
});

test("verify keeps an engine fault distinct from non-compliance", async () => {
  const out = path.join(await scratch(), "record");
  await runGate({
    projectRoot: ".",
    outDir: out,
    orchestrateFn: async () => {
      throw new Error("the adapter registry is unreadable");
    },
  });
  const verdict = await verifyGate({ outDir: out });

  assert.equal(verdict.exitCode, TERMINAL.ENFORCEMENT_FAULT);
  assert.notEqual(verdict.exitCode, TERMINAL.PASS, "an engine fault is never green");
  assert.match(verdict.message, /not a finding about this project/);
});

test("ADVERSARIAL: a run that never happened reports a failure rather than nothing", async () => {
  // The Pending case, which is the one that actually removes checks from branch protection. There is
  // no record because the step never ran; the guard must still speak, and must speak red.
  const out = path.join(await scratch(), "record");
  await mkdir(out, { recursive: true });
  const verdict = await verifyGate({ outDir: out });

  assert.equal(verdict.exitCode, TERMINAL.GATE_FAILURE);
  assert.equal(verdict.kind, "no-terminal-record");
  assert.match(verdict.message, /is not a pass/);
});

test("ADVERSARIAL: a green exit code with no report behind it is not a pass", async () => {
  const out = path.join(await scratch(), "record");
  await mkdir(out, { recursive: true });
  await writeFile(
    path.join(out, "status.json"),
    JSON.stringify({ kind: "report", outcome: "PASS", exitCode: 0 }),
    "utf8",
  );
  const verdict = await verifyGate({ outDir: out });

  assert.equal(verdict.exitCode, TERMINAL.GATE_FAILURE);
  assert.equal(verdict.kind, "missing-report");
});

test("ADVERSARIAL: a recorded PASS beside a report that says otherwise fails closed", async () => {
  // The swallowed-failure shape, reduced to its essentials: something claims green while the evidence
  // it points at says red. The verdict is re-derived from the report, so the claim loses.
  const out = path.join(await scratch(), "record");
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "status.json"), JSON.stringify({ kind: "report", outcome: "PASS", exitCode: 0 }), "utf8");
  await writeFile(path.join(out, "report.json"), JSON.stringify(reportOf("FAIL", [{ reason: "x" }])), "utf8");
  const verdict = await verifyGate({ outDir: out });

  assert.equal(verdict.exitCode, TERMINAL.GATE_FAILURE);
  assert.equal(verdict.kind, "inconsistent-record");
});

test("ADVERSARIAL: an unrecognised record is not a pass", async () => {
  const out = path.join(await scratch(), "record");
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, "status.json"), JSON.stringify({ kind: "skipped", outcome: "PASS", exitCode: 0 }), "utf8");
  const verdict = await verifyGate({ outDir: out });

  assert.equal(verdict.exitCode, TERMINAL.GATE_FAILURE);
  assert.equal(verdict.kind, "unrecognised-record");
});

test("no verify outcome is ever green except a verified PASS", async () => {
  // Exhaustive over the kinds verify can return, since this is the only place a green check can be
  // produced and there must be exactly one route to it.
  const out = path.join(await scratch(), "record");
  const cases = ["FAIL", "BLOCKED", "INDETERMINATE"];
  for (const outcome of cases) {
    await runGate({ projectRoot: ".", outDir: out, orchestrateFn: stub(outcome, [{ reason: "r" }]) });
    const verdict = await verifyGate({ outDir: out });
    assert.notEqual(verdict.exitCode, TERMINAL.PASS, `${outcome} must not exit 0`);
  }
});
