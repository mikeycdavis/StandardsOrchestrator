/**
 * Tests for composition prerequisites.
 *
 * The mutation that matters most is at the bottom: removing the shipped prerequisite must turn a
 * failing composition green. That is the proof that this registry file is carrying a boundary one pack
 * structurally cannot carry itself, rather than documenting an intention.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, cp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadDependencies,
  executionOrder,
  evaluateSatisfaction,
  applySatisfaction,
  DependencyError,
} from "../scripts/dependencies.mjs";
import { loadRegistry } from "../scripts/registry.mjs";
import { aggregate } from "../scripts/outcome.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = await loadRegistry();
const shipped = await loadDependencies(registry);

const BETTING = "betting@1.0.0";
const PREDICTION = "prediction@1.1.0";

const result = (cls, applicability = "CONFIRMED") => ({ class: cls, applicability });

/** A registry root with substituted dependency content, for the cases the shipped file cannot show. */
async function withDependencies(document) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "so-deps-"));
  await mkdir(path.join(dir, "schemas"), { recursive: true });
  await mkdir(path.join(dir, "registry"), { recursive: true });
  await cp(path.join(ROOT, "schemas", "dependencies.schema.json"), path.join(dir, "schemas", "dependencies.schema.json"));
  await writeFile(path.join(dir, "registry", "dependencies.json"), JSON.stringify(document), "utf8");
  return dir;
}

const cleanup = [];
test.after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// The shipped registry.
// ---------------------------------------------------------------------------------------------

test("the shipped prerequisites are exactly one, at exact versions", async () => {
  // Kept aggressively small. A prerequisite earns a place only when it cannot be enforced inside
  // either pack, which is far narrower than "it would be sensible for these to run in order".
  assert.deepEqual([...shipped.requires.keys()], [BETTING]);
  assert.deepEqual(shipped.requires.get(BETTING).map((r) => r.authority), [PREDICTION]);
  assert.equal(shipped.requires.get(BETTING)[0].condition, "satisfied");
});

test("the prerequisite records why it belongs to neither pack", async () => {
  const [requirement] = shipped.requires.get(BETTING);
  assert.match(requirement.rationale, /opaque input/);
  assert.match(requirement.rationale, /belongs to neither/);
});

test("a prerequisite at one version says nothing about another release", async () => {
  // Exact-version semantics, same as adapters. A future release inherits nothing.
  assert.equal(shipped.requires.has("betting@1.0.1"), false);
  assert.equal(shipped.requires.has("betting"), false);
});

// ---------------------------------------------------------------------------------------------
// Load-time validation.
// ---------------------------------------------------------------------------------------------

test("REJECTED AT LOAD: a cycle", async () => {
  const dir = await withDependencies({
    dependencies: {
      [BETTING]: { requires: [{ authority: PREDICTION, condition: "satisfied", rationale: "x" }] },
      [PREDICTION]: { requires: [{ authority: BETTING, condition: "satisfied", rationale: "x" }] },
    },
  });
  cleanup.push(dir);
  await assert.rejects(() => loadDependencies(registry, dir), /form a cycle/);
});

test("REJECTED AT LOAD: an authority depending on itself", async () => {
  const dir = await withDependencies({
    dependencies: { [BETTING]: { requires: [{ authority: BETTING, condition: "satisfied", rationale: "x" }] } },
  });
  cleanup.push(dir);
  await assert.rejects(() => loadDependencies(registry, dir), /lists itself/);
});

test("REJECTED AT LOAD: an unregistered authority at either end", async () => {
  // A typo must not be able to become a prerequisite that quietly does not exist.
  const dependent = await withDependencies({
    dependencies: { "betting@9.9.9": { requires: [{ authority: PREDICTION, condition: "satisfied", rationale: "x" }] } },
  });
  const prerequisite = await withDependencies({
    dependencies: { [BETTING]: { requires: [{ authority: "predicton@1.1.0", condition: "satisfied", rationale: "x" }] } },
  });
  cleanup.push(dependent, prerequisite);

  await assert.rejects(() => loadDependencies(registry, dependent), /not a registered authority/);
  await assert.rejects(() => loadDependencies(registry, prerequisite), /not a registered authority/);
});

test("REJECTED AT LOAD: a version-less or malformed authority key", async () => {
  for (const key of ["betting", "betting@1.0", "betting@^1.0.0", "Betting@1.0.0"]) {
    const dir = await withDependencies({
      dependencies: { [key]: { requires: [{ authority: PREDICTION, condition: "satisfied", rationale: "x" }] } },
    });
    cleanup.push(dir);
    await assert.rejects(() => loadDependencies(registry, dir), DependencyError, key);
  }
});

test("REJECTED AT LOAD: a condition v1 has no semantics for", async () => {
  const dir = await withDependencies({
    dependencies: { [BETTING]: { requires: [{ authority: PREDICTION, condition: "executed", rationale: "x" }] } },
  });
  cleanup.push(dir);
  await assert.rejects(() => loadDependencies(registry, dir), /schema/);
});

test("REJECTED AT LOAD: a prerequisite with no stated rationale", async () => {
  const dir = await withDependencies({
    dependencies: { [BETTING]: { requires: [{ authority: PREDICTION, condition: "satisfied" }] } },
  });
  cleanup.push(dir);
  await assert.rejects(() => loadDependencies(registry, dir), /schema/);
});

// ---------------------------------------------------------------------------------------------
// Execution order is not evidence.
// ---------------------------------------------------------------------------------------------

test("execution order places every prerequisite before its dependent", () => {
  const order = executionOrder(shipped, [BETTING, PREDICTION]);
  assert.ok(order.indexOf(PREDICTION) < order.indexOf(BETTING));
});

test("execution order is deterministic regardless of input order", () => {
  assert.deepEqual(executionOrder(shipped, [BETTING, PREDICTION]), executionOrder(shipped, [PREDICTION, BETTING]));
});

test("running first is not evidence of anything", () => {
  // The conflation this separation exists to prevent: "prediction ran before betting" is not
  // "prediction passed sufficiently for betting to depend on it".
  const order = executionOrder(shipped, [BETTING, PREDICTION]);
  assert.equal(order[0], PREDICTION);

  const satisfaction = evaluateSatisfaction(
    shipped,
    new Map([[PREDICTION, result("FAIL")], [BETTING, result("PASS")]]),
  );
  assert.equal(satisfaction.get(BETTING).dependencyStatus, "unsatisfied");
});

// ---------------------------------------------------------------------------------------------
// Satisfaction.
// ---------------------------------------------------------------------------------------------

test("EXHAUSTIVE: only a prerequisite that ran, counted, and passed is satisfying", () => {
  const classes = ["PASS", "FAIL", "BLOCKED", "INDETERMINATE", "UNRESOLVED", "CONFLICT"];
  const applicabilities = ["CONFIRMED", "DECLARED_ONLY", "NOT_APPLICABLE", "CONFLICT", "UNRESOLVED"];

  const satisfying = [];
  for (const cls of classes) {
    for (const applicability of applicabilities) {
      const satisfaction = evaluateSatisfaction(
        shipped,
        new Map([[PREDICTION, result(cls, applicability)], [BETTING, result("PASS")]]),
      );
      if (satisfaction.get(BETTING).dependencyStatus === "satisfied") satisfying.push(`${cls}/${applicability}`);
    }
  }
  assert.deepEqual(satisfying, ["PASS/CONFIRMED", "PASS/DECLARED_ONLY"]);
});

test("ADVERSARIAL: an applicable dependent with a not-applicable prerequisite fails composition", () => {
  // Not a claim that the upstream authority was wrong to return not-applicable. The claim is that the
  // prerequisites for a composed downstream result have not been met.
  const satisfaction = evaluateSatisfaction(
    shipped,
    new Map([
      [PREDICTION, result("PASS", "NOT_APPLICABLE")],
      [BETTING, result("PASS", "CONFIRMED")],
    ]),
  );
  assert.equal(satisfaction.get(BETTING).dependencyStatus, "unsatisfied");
  assert.match(satisfaction.get(BETTING).unsatisfiedBy[0].because, /not a finding against that authority/);
});

test("ADVERSARIAL: a dormant dependent does not drag its prerequisite into the run", () => {
  // The prerequisite becomes an obligation because the dependent is applicable, not because a line
  // exists in the registry.
  const satisfaction = evaluateSatisfaction(
    shipped,
    new Map([
      [PREDICTION, result("UNRESOLVED", "UNRESOLVED")],
      [BETTING, result("PASS", "NOT_APPLICABLE")],
    ]),
  );
  assert.equal(satisfaction.get(BETTING).dependencyStatus, "not-applicable");
  assert.deepEqual(satisfaction.get(BETTING).unsatisfiedBy, []);
});

test("a prerequisite absent from the run is unsatisfied, not assumed fine", () => {
  const satisfaction = evaluateSatisfaction(shipped, new Map([[BETTING, result("PASS")]]));
  assert.equal(satisfaction.get(BETTING).dependencyStatus, "unsatisfied");
  assert.match(satisfaction.get(BETTING).unsatisfiedBy[0].because, /not part of this run/);
});

test("ADVERSARIAL: no reverse inference — a passing dependent establishes nothing upstream", () => {
  const satisfaction = evaluateSatisfaction(
    shipped,
    new Map([[PREDICTION, result("INDETERMINATE")], [BETTING, result("PASS")]]),
  );
  // The prerequisite's own status is read from its own result. It is untouched by the dependent.
  assert.equal(satisfaction.get(PREDICTION).dependencyStatus, "not-applicable");
  assert.equal(satisfaction.get(BETTING).dependencyStatus, "unsatisfied");
});

test("an authority with no prerequisites is never unsatisfied", () => {
  const satisfaction = evaluateSatisfaction(shipped, new Map([[PREDICTION, result("PASS")]]));
  assert.equal(satisfaction.get(PREDICTION).dependencyStatus, "not-applicable");
});

// ---------------------------------------------------------------------------------------------
// Transitivity, precisely.
// ---------------------------------------------------------------------------------------------

test("satisfaction composes, but `requires` does not become transitive", async () => {
  // A requires B, B requires C, C fails. B passed on its own terms, so nothing claims A requires C —
  // what fails is A's requirement that B be SATISFIED, and B is not, because it stands on an
  // unsatisfied prerequisite of its own.
  const A = BETTING;
  const B = PREDICTION;
  const C = "engineering@2.0.0";

  const fake = {
    requires: new Map([
      [A, [{ authority: B, condition: "satisfied", rationale: "x" }]],
      [B, [{ authority: C, condition: "satisfied", rationale: "x" }]],
    ]),
  };

  const satisfaction = evaluateSatisfaction(
    fake,
    new Map([[C, result("FAIL")], [B, result("PASS")], [A, result("PASS")]]),
  );

  assert.equal(satisfaction.get(B).dependencyStatus, "unsatisfied");
  assert.equal(satisfaction.get(A).dependencyStatus, "unsatisfied");
  assert.match(satisfaction.get(A).unsatisfiedBy[0].because, /stands on an unsatisfied prerequisite of its own/);

  // A's direct requirement is on B, and only on B. C never appears in A's list.
  assert.deepEqual(satisfaction.get(A).unsatisfiedBy.map((u) => u.authority), [B]);
});

// ---------------------------------------------------------------------------------------------
// Feeding the gate.
// ---------------------------------------------------------------------------------------------

test("an unsatisfied prerequisite invalidates the contribution without overwriting the verdict", () => {
  // The dependent still ran and its own conclusion is reported unchanged. What it cannot do is
  // contribute a pass to the composed result.
  const results = new Map([
    [PREDICTION, { ...result("INDETERMINATE"), coverage: { records: 0 } }],
    [BETTING, { ...result("PASS"), coverage: { cataloguedRules: 51 } }],
  ]);
  const applied = applySatisfaction(results, evaluateSatisfaction(shipped, results));

  const betting = applied.find((r) => r.authority === BETTING);
  assert.equal(betting.class, "PASS", "the dependent's own verdict is not rewritten");
  assert.equal(betting.dependencyStatus, "unsatisfied");
  assert.deepEqual(betting.coverage, { cataloguedRules: 51 }, "its evidence is still reported");

  const gate = aggregate(applied);
  assert.equal(gate.outcome, "FAIL");
  assert.equal(
    gate.reasons.some((r) => r.pack === "betting" && r.class === "PASS" && r.dependencyStatus === "unsatisfied"),
    true,
    "the report names the upstream as the cause rather than reporting betting as failing",
  );
});

test("MUTATION: removing the prerequisite turns a failing composition green", () => {
  // This is the proof that registry/dependencies.json carries the boundary one pack structurally
  // cannot carry itself. If this ever stops holding, that file has become documentation.
  const results = new Map([
    [PREDICTION, result("INDETERMINATE", "CONFIRMED")],
    [BETTING, result("PASS", "CONFIRMED")],
  ]);

  const withPrerequisite = aggregate(applySatisfaction(results, evaluateSatisfaction(shipped, results)));
  assert.equal(withPrerequisite.outcome, "FAIL");

  // The same run with the prerequisite removed, and prediction not applicable so only betting counts.
  const withoutPrerequisite = { requires: new Map() };
  const dormant = new Map([
    [PREDICTION, result("INDETERMINATE", "NOT_APPLICABLE")],
    [BETTING, result("PASS", "CONFIRMED")],
  ]);
  const green = aggregate(applySatisfaction(dormant, evaluateSatisfaction(withoutPrerequisite, dormant)));
  assert.equal(green.outcome, "PASS", "without the prerequisite there is nothing left to fail the gate");
});

test("both authorities passing with prerequisites satisfied is PASS", () => {
  const results = new Map([[PREDICTION, result("PASS")], [BETTING, result("PASS")]]);
  const gate = aggregate(applySatisfaction(results, evaluateSatisfaction(shipped, results)));
  assert.equal(gate.outcome, "PASS");
  assert.deepEqual(gate.reasons, []);
});
