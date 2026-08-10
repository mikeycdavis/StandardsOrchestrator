/**
 * End-to-end tests for the gate.
 *
 * Applicability, resolution, prerequisites, aggregation and the report all run for real — resolution
 * included, against the live remotes. Only acquisition and execution are substituted, because running
 * two real standards packs per case would test their behaviour rather than the orchestration of it,
 * and their behaviour is already pinned by the adapter and interpreter tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { orchestrate } from "../scripts/orchestrate.mjs";
import { exitCodeFor } from "../scripts/report.mjs";

const cleanup = [];
test.after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true });
});

async function makeProject(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "so-e2e-"));
  cleanup.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

/** Signals that make both authorities genuinely detected, so applicability is CONFIRMED. */
const DETECTED_SOURCES = {
  "src/client.py": 'return await self._post("/portfolio/orders", payload)',
  "src/model.py": "probs = model.predict_proba(features)",
};

const MANIFEST = [
  "standards:",
  "  betting:",
  "    required: true",
  "    version: 1.0.0",
  "  prediction:",
  "    required: true",
  "    version: 1.1.0",
  "  ml:",
  "    required: false",
  "  engineering:",
  "    required: false",
  "",
].join("\n");

const acquireOk = async (resolution) => ({ ok: true, packRoot: "/fake", commit: resolution.commit });

/** An execute stub returning a chosen class per pack, and recording who was actually run. */
function executor(byPack, ran = []) {
  return async (resolution) => {
    ran.push(`${resolution.pack}@${resolution.version}`);
    const chosen = byPack[resolution.pack] ?? { class: "PASS", verdict: "OK" };
    return { ...chosen, authority: `${resolution.pack}@${resolution.version}`, pack: resolution.pack, exitCode: 0 };
  };
}

const run = (projectRoot, byPack = {}, ran = []) =>
  orchestrate({
    projectRoot,
    generatedAt: "2026-08-10T00:00:00Z",
    acquireFn: acquireOk,
    executeFn: executor(byPack, ran),
  });

// ---------------------------------------------------------------------------------------------

test("E2E: every applicable authority passes and every prerequisite holds", async () => {
  const project = await makeProject({ "standards.yml": MANIFEST, ...DETECTED_SOURCES });
  const report = await run(project, {
    betting: { class: "PASS", verdict: "COMPLIANT", coverage: { cataloguedRules: 51, evaluatedRules: 41 } },
    prediction: { class: "PASS", verdict: "SUPPORTED", coverage: { basis: "perRecord", records: [] } },
  });

  assert.equal(report.outcome, "PASS");
  assert.deepEqual(report.reasons, []);
  assert.equal(exitCodeFor(report), 0);
  assert.deepEqual(Object.keys(report.coverage).sort(), ["betting", "prediction"]);
});

test("E2E: prerequisites are executed before their dependents", async () => {
  const project = await makeProject({ "standards.yml": MANIFEST, ...DETECTED_SOURCES });
  const ran = [];
  await run(project, {}, ran);
  assert.deepEqual(ran, ["prediction@1.1.0", "betting@1.0.0"]);
});

test("E2E: an unsupported prediction fails the gate while betting's own verdict stands", async () => {
  // The ADR 0001 composition case, end to end. Betting's mechanics really were valid; what fails is
  // the composed result, and the report says which.
  const project = await makeProject({ "standards.yml": MANIFEST, ...DETECTED_SOURCES });
  const report = await run(project, {
    betting: { class: "PASS", verdict: "COMPLIANT" },
    prediction: { class: "FAIL", verdict: "INSUFFICIENTLY_SUPPORTED" },
  });

  assert.equal(report.outcome, "FAIL");
  const betting = report.authorities.find((a) => a.pack === "betting");
  assert.equal(betting.class, "PASS", "the orchestrator does not overwrite a pack's verdict");
  assert.equal(betting.packVerdict, "COMPLIANT");
  assert.equal(betting.dependencyStatus, "unsatisfied");
  assert.match(betting.dependencyReason, /prediction@1\.1\.0/);
});

test("E2E: a pinned release with no adapter is UNRESOLVED and is never executed", async () => {
  const project = await makeProject({
    "standards.yml": MANIFEST.replace("version: 1.1.0", "version: 1.0.0"),
    ...DETECTED_SOURCES,
  });
  const ran = [];
  const report = await run(project, {}, ran);

  const prediction = report.authorities.find((a) => a.pack === "prediction");
  assert.equal(prediction.class, "UNRESOLVED");
  assert.match(prediction.detail, /UNSUPPORTED_RELEASE/);
  assert.equal(ran.includes("prediction@1.0.0"), false, "an unresolved authority is never run");
  assert.equal(report.outcome, "FAIL");
});

test("E2E: a required pack with no version pin names nothing", async () => {
  const project = await makeProject({
    "standards.yml": "standards:\n  betting:\n    required: true\n",
    ...DETECTED_SOURCES,
  });
  const report = await run(project);
  const betting = report.authorities.find((a) => a.pack === "betting");
  assert.equal(betting.class, "UNRESOLVED");
  assert.match(betting.detail, /pinned to no version/);
});

test("ADVERSARIAL E2E: a project that adopted nothing does not pass", async () => {
  // No manifest, no signals a detector understands. Every authority is UNSPECIFIED with detection
  // INDETERMINATE, which is unresolved applicability — not a determination that nothing applies.
  const project = await makeProject({ "README.md": "a project that has adopted no standards" });
  const report = await run(project);

  assert.equal(report.outcome, "FAIL");
  assert.notEqual(report.outcome, "PASS");
  assert.ok(report.authorities.every((a) => a.applicability.state === "UNRESOLVED"));
  assert.equal(exitCodeFor(report), 1);
});

test("ADVERSARIAL E2E: declaring every pack not-applicable does not pass either", async () => {
  // M1's empty-set protection reached through the whole pipeline. Nothing was evaluated, and nothing
  // evaluated is not compliance.
  const project = await makeProject({
    "standards.yml": [
      "standards:",
      "  betting:",
      "    required: false",
      "  prediction:",
      "    required: false",
      "  ml:",
      "    required: false",
      "  engineering:",
      "    required: false",
      "",
    ].join("\n"),
    // Readable source with no signal in it, so detection is a genuine NOT_DETECTED rather than a
    // failure to look — otherwise this fixture would be testing the CONFLICT path instead.
    "src/app.py": "def main():\n    return 'nothing to see'\n",
  });
  const ran = [];
  const report = await run(project, {}, ran);

  assert.equal(report.outcome, "INDETERMINATE");
  assert.equal(exitCodeFor(report), 1);
  assert.deepEqual(ran, [], "nothing was executed, which is exactly why this cannot be a pass");
});

test("ADVERSARIAL E2E: declaring a pack not-applicable while it is detected is a CONFLICT", async () => {
  const project = await makeProject({
    "standards.yml": "standards:\n  betting:\n    required: false\n",
    ...DETECTED_SOURCES,
  });
  const report = await run(project);

  const betting = report.authorities.find((a) => a.pack === "betting");
  assert.equal(betting.applicability.disposition, "CONFLICT");
  assert.ok(betting.applicability.evidence.length > 0, "the evidence a human must adjudicate is reported");
  assert.equal(report.outcome, "FAIL");
});

test("E2E: a blocked authority blocks, and says so distinctly from a failure", async () => {
  const project = await makeProject({ "standards.yml": MANIFEST, ...DETECTED_SOURCES });
  const report = await run(project, {
    prediction: { class: "BLOCKED", verdict: "BLOCKED_BY_INVARIANT" },
    betting: { class: "PASS", verdict: "COMPLIANT" },
  });

  assert.equal(report.outcome, "BLOCKED");
  assert.notEqual(report.outcome, "FAIL");
  assert.equal(exitCodeFor(report), 1);
});

test("E2E: the report keeps both evidence sources beside every conclusion", async () => {
  const project = await makeProject({ "standards.yml": MANIFEST, ...DETECTED_SOURCES });
  const report = await run(project);

  const betting = report.authorities.find((a) => a.pack === "betting");
  assert.equal(betting.applicability.declaration, "REQUIRED");
  assert.equal(betting.applicability.detection, "DETECTED");
  assert.equal(betting.resolution.commit, "a4e7e680ca9213d6bf9f5042a3ae7fd7383b7545");
});
