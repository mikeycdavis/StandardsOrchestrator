/**
 * Tests for the outcome algebra.
 *
 * The exhaustive table is the cheap part. The four property tests are the load-bearing part, because
 * they survive the outcome vocabulary changing: an enumeration proves the six classes behave today,
 * whereas "adding a non-PASS can never produce PASS" constrains a seventh class before it is written.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregate,
  carryCoverage,
  exitCodeFor,
  OutcomeError,
  OUTCOME_CLASSES,
  APPLICABILITY_STATES,
  DEPENDENCY_STATES,
} from "../scripts/outcome.mjs";

const NON_PASS = OUTCOME_CLASSES.filter((c) => c !== "PASS");
const r = (pack, outcomeClass, extra = {}) => ({ pack, class: outcomeClass, ...extra });

// ---------------------------------------------------------------------------------------------
// Guard 1 — the empty set must not aggregate to PASS.
// ---------------------------------------------------------------------------------------------

test("the empty set is INDETERMINATE, not PASS", () => {
  // An empty conjunction is mathematically true. Operationally it means nothing ran, and "nothing ran"
  // becoming green is the exact failure this repository exists to prevent.
  const result = aggregate([]);
  assert.equal(result.outcome, "INDETERMINATE");
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0].reason, /no standards authority was evaluated/);
});

test("every pack NOT_APPLICABLE is INDETERMINATE, not PASS", () => {
  // The empty set reached by a different route: a project that declared its way out of every authority
  // evaluated nothing. If this returned PASS, `required: false` everywhere would be a green button.
  const result = aggregate([
    r("betting", "PASS", { applicability: "NOT_APPLICABLE" }),
    r("prediction", "PASS", { applicability: "NOT_APPLICABLE" }),
  ]);
  assert.equal(result.outcome, "INDETERMINATE");
  assert.match(result.reasons[0].reason, /nothing was evaluated/);
});

// ---------------------------------------------------------------------------------------------
// Guard 2 — adding any non-PASS can never turn a result into PASS. (Monotonicity.)
// ---------------------------------------------------------------------------------------------

test("PROPERTY: adding a non-PASS result to any set can never yield PASS", () => {
  const bases = [
    [],
    [r("a", "PASS")],
    [r("a", "PASS"), r("b", "PASS")],
    [r("a", "FAIL")],
    [r("a", "PASS"), r("b", "UNRESOLVED")],
    [r("a", "PASS", { applicability: "NOT_APPLICABLE" })],
  ];

  let checked = 0;
  for (const base of bases) {
    for (const cls of NON_PASS) {
      const grown = [...base, r("added", cls)];
      assert.notEqual(aggregate(grown).outcome, "PASS", `${JSON.stringify(grown)} must not be PASS`);
      checked += 1;
    }
  }
  assert.equal(checked, bases.length * NON_PASS.length);
});

test("PROPERTY: a PASS result carrying an unsatisfied dependency or a CONFLICT is also non-PASS", () => {
  // The other two ways a set can contain something non-passing without containing a non-PASS class.
  // Monotonicity has to cover these too, or a dependency failure could be added to a green set for free.
  for (const base of [[], [r("a", "PASS")], [r("a", "PASS"), r("b", "PASS")]]) {
    assert.notEqual(
      aggregate([...base, r("added", "PASS", { dependencyStatus: "unsatisfied" })]).outcome,
      "PASS",
    );
    assert.notEqual(aggregate([...base, r("added", "PASS", { applicability: "CONFLICT" })]).outcome, "PASS");
  }
});

test("PROPERTY: aggregation is order-independent", () => {
  // A conjunction over a set. If order mattered, the first green pack could shadow a later red one.
  const set = [r("a", "PASS"), r("b", "FAIL"), r("c", "UNRESOLVED"), r("d", "BLOCKED")];
  const forward = aggregate(set).outcome;
  const backward = aggregate([...set].reverse()).outcome;
  assert.equal(forward, backward);
  assert.equal(forward, "BLOCKED");
});

// ---------------------------------------------------------------------------------------------
// Guard 3 — removing the only non-PASS may permit PASS, but never guarantees it.
// ---------------------------------------------------------------------------------------------

test("removing the only non-PASS class permits PASS but does not guarantee it", () => {
  // Permits:
  assert.equal(aggregate([r("a", "PASS"), r("b", "FAIL")]).outcome, "FAIL");
  assert.equal(aggregate([r("a", "PASS")]).outcome, "PASS");

  // Does not guarantee — the dependency condition still applies:
  assert.equal(
    aggregate([r("a", "PASS"), r("b", "PASS", { dependencyStatus: "unsatisfied" })]).outcome,
    "FAIL",
  );

  // Nor the applicability condition:
  assert.equal(
    aggregate([r("a", "PASS"), r("b", "PASS", { applicability: "CONFLICT" })]).outcome,
    "FAIL",
  );

  // Nor the empty-set condition, reached by removing the last evaluated pack entirely:
  assert.equal(aggregate([]).outcome, "INDETERMINATE");
});

// ---------------------------------------------------------------------------------------------
// Guard 4 — BLOCKED retains precedence regardless of siblings.
// ---------------------------------------------------------------------------------------------

test("PROPERTY: BLOCKED wins over every sibling class, in either order", () => {
  for (const cls of OUTCOME_CLASSES) {
    assert.equal(aggregate([r("a", "BLOCKED"), r("b", cls)]).outcome, "BLOCKED", `BLOCKED vs ${cls}`);
    assert.equal(aggregate([r("a", cls), r("b", "BLOCKED")]).outcome, "BLOCKED", `${cls} vs BLOCKED`);
  }
});

test("BLOCKED survives an unsatisfied dependency and a conflict on the same run", () => {
  // Nothing may demote BLOCKED. It is stop semantics, not fix-and-rerun, and the report must say so
  // even when there is also ordinary failing work in the same run.
  const result = aggregate([
    r("a", "BLOCKED"),
    r("b", "PASS", { dependencyStatus: "unsatisfied" }),
    r("c", "PASS", { applicability: "CONFLICT" }),
  ]);
  assert.equal(result.outcome, "BLOCKED");
  assert.equal(result.reasons.length, 3);
});

// ---------------------------------------------------------------------------------------------
// The exhaustive table.
// ---------------------------------------------------------------------------------------------

test("EXHAUSTIVE: every ordered pair of classes aggregates correctly", () => {
  for (const left of OUTCOME_CLASSES) {
    for (const right of OUTCOME_CLASSES) {
      const expected =
        left === "BLOCKED" || right === "BLOCKED"
          ? "BLOCKED"
          : left === "PASS" && right === "PASS"
            ? "PASS"
            : "FAIL";
      assert.equal(
        aggregate([r("a", left), r("b", right)]).outcome,
        expected,
        `${left} + ${right}`,
      );
    }
  }
});

test("EXHAUSTIVE: only PASS + PASS is green across every pair", () => {
  let green = 0;
  for (const left of OUTCOME_CLASSES) {
    for (const right of OUTCOME_CLASSES) {
      if (aggregate([r("a", left), r("b", right)]).outcome === "PASS") green += 1;
    }
  }
  assert.equal(green, 1, "exactly one of the 36 ordered pairs may be PASS");
});

test("EXHAUSTIVE: singletons", () => {
  assert.equal(aggregate([r("a", "PASS")]).outcome, "PASS");
  for (const cls of NON_PASS) {
    const expected = cls === "BLOCKED" ? "BLOCKED" : "FAIL";
    assert.equal(aggregate([r("a", cls)]).outcome, expected, cls);
  }
});

// ---------------------------------------------------------------------------------------------
// The reason classes are preserved, not rewritten.
// ---------------------------------------------------------------------------------------------

test("overall FAIL preserves the underlying class of each reason", () => {
  // The gate result is FAIL. That must not overwrite the fact that prediction was INDETERMINATE while
  // betting was PASS-on-an-unsatisfied-dependency: those send someone to fix entirely different things.
  const result = aggregate([
    r("prediction", "INDETERMINATE", { detail: "No prediction record was evaluated." }),
    r("betting", "PASS", { dependencyStatus: "unsatisfied" }),
  ]);

  assert.equal(result.outcome, "FAIL");
  assert.deepEqual(result.reasons, [
    { pack: "prediction", class: "INDETERMINATE", reason: "No prediction record was evaluated." },
    {
      pack: "betting",
      class: "PASS",
      dependencyStatus: "unsatisfied",
      reason: "a required upstream authority did not pass",
    },
  ]);
});

test("UNRESOLVED and INDETERMINATE are distinguishable in the report, not both just FAIL", () => {
  // prediction@1.0.0 (tag does not exist) vs prediction@1.1.0 that ran and found nothing to evaluate.
  // Both fail the gate; conflating them sends someone to fix the wrong thing.
  const result = aggregate([
    r("prediction", "UNRESOLVED", { detail: "requested release does not exist (available: v1.1.0)" }),
    r("engineering", "INDETERMINATE", { detail: "no policy file; nothing was evaluated" }),
  ]);

  assert.equal(result.outcome, "FAIL");
  const classes = result.reasons.map((x) => x.class);
  assert.deepEqual(classes, ["UNRESOLVED", "INDETERMINATE"]);
  assert.equal(JSON.stringify(result).includes("UNRESOLVED"), true, "must survive JSON serialisation");
});

test("a PASS run reports no reasons", () => {
  const result = aggregate([r("a", "PASS", { applicability: "CONFIRMED", dependencyStatus: "satisfied" })]);
  assert.equal(result.outcome, "PASS");
  assert.deepEqual(result.reasons, []);
});

test("one result can contribute two reasons", () => {
  // A pack can be indeterminate AND sitting on an unsatisfied upstream. Reporting only the first hides
  // work that still remains after it is fixed.
  const result = aggregate([r("betting", "INDETERMINATE", { dependencyStatus: "unsatisfied" })]);
  assert.equal(result.reasons.length, 2);
  assert.equal(result.reasons[0].class, "INDETERMINATE");
  assert.equal(result.reasons[1].dependencyStatus, "unsatisfied");
});

// ---------------------------------------------------------------------------------------------
// Coverage is carried, never combined.
// ---------------------------------------------------------------------------------------------

test("coverage is carried through verbatim, per pack, by reference", () => {
  const bettingCoverage = { cataloguedRules: 51, evaluatedRules: 41, note: "eight rules require review" };
  const predictionCoverage = { rules: 30, invariants: 4, kinds: 7 };

  const result = aggregate([
    r("betting", "PASS", { coverage: bettingCoverage }),
    r("prediction", "PASS", { coverage: predictionCoverage }),
  ]);

  // Identity, not equality: nothing recomputed, reshaped, or normalised on the way through.
  assert.equal(result.coverage.betting, bettingCoverage);
  assert.equal(result.coverage.prediction, predictionCoverage);
});

test("there is no portfolio coverage figure anywhere in the aggregate result", () => {
  // The three packs' coverage shapes are not commensurable. A combined percentage would assert a
  // comparability that does not exist, so the absence is asserted rather than left to convention.
  const result = aggregate([
    r("betting", "PASS", { coverage: { cataloguedRules: 51, evaluatedRules: 41 } }),
    r("prediction", "PASS", { coverage: { rules: 30, invariants: 4 } }),
  ]);

  assert.deepEqual(Object.keys(result).sort(), ["coverage", "outcome", "reasons"]);
  assert.deepEqual(Object.keys(result.coverage).sort(), ["betting", "prediction"]);
  for (const forbidden of ["total", "percentage", "percent", "score", "combined", "overall"]) {
    assert.equal(forbidden in result.coverage, false, `coverage must not carry a '${forbidden}' key`);
  }
});

test("carryCoverage omits packs that reported none rather than inventing a zero", () => {
  const coverage = carryCoverage([r("a", "PASS", { coverage: { rules: 1 } }), r("b", "PASS")]);
  assert.deepEqual(Object.keys(coverage), ["a"]);
});

// ---------------------------------------------------------------------------------------------
// Malformed input is an orchestrator fault, never a silently-dropped entry.
// ---------------------------------------------------------------------------------------------

test("an unknown outcome class is rejected, not ignored", () => {
  // Ignoring it would leave a set looking unanimously green. This is the aggregation-layer form of
  // "unknown verdict is never a pass".
  assert.throws(() => aggregate([r("a", "COMPLIANT")]), OutcomeError);
  assert.throws(() => aggregate([r("a", "PASSED")]), OutcomeError);
  assert.throws(() => aggregate([r("a", undefined)]), OutcomeError);
});

test("a malformed result is rejected before any outcome is computed", () => {
  assert.throws(() => aggregate([r("a", "PASS"), null]), OutcomeError);
  assert.throws(() => aggregate([r("a", "PASS"), { class: "PASS" }]), OutcomeError);
  assert.throws(() => aggregate([r("a", "PASS", { applicability: "MAYBE" })]), OutcomeError);
  assert.throws(() => aggregate([r("a", "PASS", { dependencyStatus: "probably" })]), OutcomeError);
  assert.throws(() => aggregate("not an array"), OutcomeError);
});

test("the declared vocabularies are exactly what the algebra accepts", () => {
  // Pins the enumerations so a class added to the list without teaching the algebra about it is caught
  // here rather than discovered in production.
  assert.deepEqual([...OUTCOME_CLASSES], ["PASS", "FAIL", "BLOCKED", "INDETERMINATE", "UNRESOLVED", "CONFLICT"]);
  assert.deepEqual([...APPLICABILITY_STATES], ["CONFIRMED", "DECLARED_ONLY", "NOT_APPLICABLE", "CONFLICT"]);
  assert.deepEqual([...DEPENDENCY_STATES], ["satisfied", "unsatisfied", "not-applicable"]);
});

// ---------------------------------------------------------------------------------------------
// Exit contract.
// ---------------------------------------------------------------------------------------------

test("exit codes: 0 only for PASS, and 2 is never reachable from an outcome", () => {
  assert.equal(exitCodeFor("PASS"), 0);
  assert.equal(exitCodeFor("FAIL"), 1);
  assert.equal(exitCodeFor("BLOCKED"), 1);
  assert.equal(exitCodeFor("INDETERMINATE"), 1);
  // 2 means the orchestrator itself could not run. A broken orchestrator must never be reported as a
  // non-compliant project, so no outcome may map to it.
  for (const outcome of ["PASS", "FAIL", "BLOCKED", "INDETERMINATE"]) {
    assert.notEqual(exitCodeFor(outcome), 2);
  }
  assert.throws(() => exitCodeFor("UNRESOLVED"), OutcomeError);
});
