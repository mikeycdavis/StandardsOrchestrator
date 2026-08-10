/**
 * Tests for turning one pack's run into one outcome class.
 *
 * The adversarial case this file exists for: a pack returning its recognised positive verdict while
 * failing its positive-evidence gate must become INDETERMINATE and never FAIL. The distinction is not
 * cosmetic. FAIL asserts the project is wrong — a domain conclusion only the pack may reach. What
 * actually happened is that the authority did not establish enough evaluation to support compliance,
 * and saying so is the orchestrator's job.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadRegistry, resolveAdapter } from "../scripts/registry.mjs";
import { classify } from "../scripts/interpret.mjs";

const registry = await loadRegistry();
const betting = resolveAdapter(registry, "betting", "1.0.0");
const prediction = resolveAdapter(registry, "prediction", "1.1.0");

const run = (resolved, exitCode, envelope) =>
  classify(resolved, { exitCode, stdout: typeof envelope === "string" ? envelope : JSON.stringify(envelope) });

const BETTING_COVERAGE = { cataloguedRules: 51, evaluatedRules: 41, note: "framework maturity, not compliance" };
const bettingEnvelope = (over = {}) => ({
  schemaVersion: "1.0",
  status: "COMPLIANT",
  score: 94,
  summary: { passed: 27, failed: 0, warnings: 1, skipped: 23 },
  denominator: { total: 51, applicable: 30, scored: 18, basis: "required-level rules that were evaluated" },
  frameworkCoverage: BETTING_COVERAGE,
  ...over,
});

const predictionEnvelope = (aggregate, records = [{ file: "a.json", frameworkCoverage: { cataloguedRules: 52 } }]) => ({
  schemaVersion: "1.0.0",
  command: "check",
  records,
  aggregate: {
    supported: 0,
    supportedWithExceptions: 0,
    insufficientlySupported: 0,
    blockedByInvariant: 0,
    notEvaluated: 0,
    ...aggregate,
  },
});

// ---------------------------------------------------------------------------------------------
// The positive path, and the gate that guards it.
// ---------------------------------------------------------------------------------------------

test("a positive verdict with satisfied evidence is PASS", () => {
  const result = run(betting, 0, bettingEnvelope());
  assert.equal(result.class, "PASS");
  assert.equal(result.verdict, "COMPLIANT");
  assert.equal(result.evidence.satisfied, true);
});

test("ADVERSARIAL: a positive verdict failing its evidence gate is INDETERMINATE, never FAIL", () => {
  // The green-from-nothing shape: every rule skipped as not-applicable, so the run reports COMPLIANT
  // with nothing scored.
  const result = run(betting, 0, bettingEnvelope({ denominator: { total: 51, applicable: 0, scored: 0 } }));

  assert.equal(result.class, "INDETERMINATE");
  assert.notEqual(result.class, "FAIL", "the orchestrator has no standing to invent a violation");
  assert.notEqual(result.class, "PASS");
  assert.equal(result.verdict, "COMPLIANT", "the pack's own conclusion is reported, not overwritten");
  assert.match(result.detail, /did not establish non-compliance/);
});

test("ADVERSARIAL: the ML-shaped green-from-nothing envelope cannot reach PASS", () => {
  // COMPLIANT, exit 0, nothing applicable. An orchestrator gating on exit code alone reads this green.
  const result = run(betting, 0, bettingEnvelope({ summary: { passed: 0 }, denominator: { applicable: 0, scored: 0 } }));
  assert.equal(result.class, "INDETERMINATE");
});

test("ADVERSARIAL: a plausible score never substitutes for evidence", () => {
  // The Engineering-shaped hazard: a credible-looking 55 alongside a status that concluded nothing.
  // The gate reads denominator, never score, so the number has no route into the outcome.
  const result = run(betting, 0, bettingEnvelope({ status: "NOT_EVALUATED", score: 55, summary: { passed: 13 } }));
  assert.equal(result.class, "INDETERMINATE");
  assert.equal(result.detail.includes("55"), false, "the score must not appear in the reasoning");
});

test("a missing denominator fails the gate rather than being treated as absent-therefore-fine", () => {
  const envelope = bettingEnvelope();
  delete envelope.denominator;
  assert.equal(run(betting, 0, envelope).class, "INDETERMINATE");
});

// ---------------------------------------------------------------------------------------------
// Negative conclusions still belong to the pack.
// ---------------------------------------------------------------------------------------------

test("a negative verdict is FAIL, and exit 1 does not change that", () => {
  const result = run(betting, 1, bettingEnvelope({ status: "NON_COMPLIANT", summary: { failed: 3 } }));
  assert.equal(result.class, "FAIL");
  assert.equal(result.verdict, "NON_COMPLIANT");
});

test("the pack's own vocabulary maps exactly as declared", () => {
  const expected = { COMPLIANT: "PASS", COMPLIANT_WITH_EXCEPTIONS: "PASS", NON_COMPLIANT: "FAIL", NOT_EVALUATED: "INDETERMINATE", BLOCKED_BY_INVARIANT: "BLOCKED" };
  for (const [verdict, outcome] of Object.entries(expected)) {
    const result = run(betting, 0, bettingEnvelope({ status: verdict }));
    assert.equal(result.class, outcome, `${verdict} must classify as ${outcome}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Unknown output fails closed. It is never mapped to the nearest known thing.
// ---------------------------------------------------------------------------------------------

test("ADVERSARIAL: an unrecognised verdict is INDETERMINATE, not the nearest known verdict", () => {
  // If a release suddenly emits a term the adapter does not cover, the evidence is that the adapter
  // contract is no longer trustworthy — not that the term probably means what it sounds like.
  for (const invented of ["MOSTLY_COMPLIANT", "COMPLIANT_ISH", "SUPPORTED", "PASS", ""]) {
    const result = run(betting, 0, bettingEnvelope({ status: invented }));
    assert.equal(result.class, "INDETERMINATE", `'${invented}' must not classify as anything else`);
  }
  assert.match(run(betting, 0, bettingEnvelope({ status: "MOSTLY_COMPLIANT" })).detail, /must be re-derived/);
});

test("ADVERSARIAL: an undeclared exit code is an execution-contract failure", () => {
  // Exit 3 means blocked in a neighbouring pack. Borrowing that meaning here would be exactly the
  // cross-pack inference the architecture forbids.
  const result = run(betting, 3, bettingEnvelope());
  assert.equal(result.class, "INDETERMINATE");
  assert.match(result.detail, /no longer matches the release/);
});

test("unparseable output is not a verdict", () => {
  for (const stdout of ["", "Compliant. 27 passed.", "{oops", "null"]) {
    const result = classify(betting, { exitCode: 0, stdout });
    assert.equal(result.class, "INDETERMINATE", `${JSON.stringify(stdout)} must not classify`);
  }
});

test("an infrastructure fault is never reported as non-compliance", () => {
  // Exit 2 means the pack could not evaluate. Reporting that as failing work is the
  // configuration-fault-as-non-compliance collapse every pack in this family warns about.
  const result = run(betting, 2, bettingEnvelope({ status: "NOT_EVALUATED" }));
  assert.equal(result.class, "INDETERMINATE");
  assert.notEqual(result.class, "FAIL");
});

test("PROPERTY: no envelope, exit code, or verdict combination reaches PASS without the gate", () => {
  const statuses = [...betting.adapter.packVocabulary, "INVENTED", ""];
  const exitCodes = [0, 1, 2, 3, 127];
  const denominators = [undefined, { scored: 0 }, { scored: -1 }, { scored: "many" }];

  for (const status of statuses) {
    for (const exitCode of exitCodes) {
      for (const denominator of denominators) {
        const envelope = bettingEnvelope({ status, denominator });
        if (denominator === undefined) delete envelope.denominator;
        assert.notEqual(
          run(betting, exitCode, envelope).class,
          "PASS",
          `status=${status} exit=${exitCode} denominator=${JSON.stringify(denominator)} must not be PASS`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------
// The derived verdict: a release with no top-level conclusion field.
// ---------------------------------------------------------------------------------------------

test("the aggregate derivation is severity-first", () => {
  const cases = [
    [{ supported: 5, blockedByInvariant: 1 }, "BLOCKED", "BLOCKED_BY_INVARIANT"],
    [{ supported: 5, notEvaluated: 1 }, "INDETERMINATE", "NOT_EVALUATED"],
    [{ supported: 5, insufficientlySupported: 1 }, "FAIL", "INSUFFICIENTLY_SUPPORTED"],
    [{ supported: 2 }, "PASS", "SUPPORTED"],
    [{ supportedWithExceptions: 2 }, "PASS", "SUPPORTED_WITH_EXCEPTIONS"],
  ];
  for (const [aggregate, outcome, verdict] of cases) {
    const result = run(prediction, 0, predictionEnvelope(aggregate));
    assert.equal(result.class, outcome, JSON.stringify(aggregate));
    assert.equal(result.verdict, verdict);
  }
});

test("ADVERSARIAL: every aggregate count zero is INDETERMINATE, not PASS", () => {
  // Nothing was evaluated. This is the same hazard as the empty set one layer up, and it arrives here
  // as a run that exited 0 with a perfectly well-formed envelope.
  const result = run(prediction, 0, predictionEnvelope({}, []));
  assert.equal(result.class, "INDETERMINATE");
  assert.equal(result.verdict, "NOT_EVALUATED");
});

test("a positive aggregate with no records present fails the gate", () => {
  const result = run(prediction, 0, predictionEnvelope({ supported: 2 }, []));
  assert.equal(result.class, "INDETERMINATE");
  assert.match(result.detail, /no records were present/);
});

test("a malformed aggregate does not yield a conclusion", () => {
  for (const aggregate of [undefined, { supported: "two" }, { supported: -1 }]) {
    const envelope = predictionEnvelope(aggregate ?? {});
    if (aggregate === undefined) delete envelope.aggregate;
    else Object.assign(envelope.aggregate, aggregate);
    assert.equal(run(prediction, 0, envelope).class, "INDETERMINATE");
  }
});

test("exit 1 with no parseable envelope is an infrastructure fault, not a negative conclusion", () => {
  // This release exits 1 from an unhandled error when --policy points at a missing file. Mapping that
  // to FAIL would report a missing configuration file as failing prediction work.
  const result = classify(prediction, { exitCode: 1, stdout: "" });
  assert.equal(result.class, "INDETERMINATE");
  assert.notEqual(result.class, "FAIL");
});

// ---------------------------------------------------------------------------------------------
// Coverage.
// ---------------------------------------------------------------------------------------------

test("coverage is carried verbatim and by reference for a run-level pack", () => {
  const envelope = bettingEnvelope();
  const result = run(betting, 0, envelope);
  assert.deepEqual(result.coverage, BETTING_COVERAGE);
  assert.equal("percentage" in result.coverage, false);
});

test("a per-record pack's coverage stays per record rather than being merged", () => {
  const records = [
    { file: "a.json", frameworkCoverage: { cataloguedRules: 52, evaluatedRules: 47 } },
    { file: "b.json", frameworkCoverage: { cataloguedRules: 52, evaluatedRules: 47 } },
  ];
  const result = run(prediction, 0, predictionEnvelope({ supported: 2 }, records));
  assert.equal(result.coverage.basis, "perRecord");
  assert.equal(result.coverage.records.length, 2);
  assert.deepEqual(result.coverage.records.map((r) => r.file), ["a.json", "b.json"]);
  // Two records that happen to agree are still two records. Summing them would invent a run-level
  // coverage figure this release never reports.
  assert.equal("cataloguedRules" in result.coverage, false);
});

test("no coverage is reported when the pack reported none", () => {
  const envelope = bettingEnvelope();
  delete envelope.frameworkCoverage;
  assert.equal(run(betting, 0, envelope).coverage, undefined);
});
