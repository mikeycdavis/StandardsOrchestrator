/**
 * The outcome algebra. [POLICY]
 *
 * This module is the orchestrator's definition of truth, and it deliberately exists before any code
 * that can execute an external authority. Nothing here knows how to run a pack, parse an envelope, or
 * resolve a ref — it knows only what a set of pack results is allowed to combine into.
 *
 * The central invariant, in its aggregation form:
 *
 *     The orchestrator may compose standards authorities, but it may neither invent their conclusions
 *     nor convert absence, ambiguity, incompatibility, or failure into compliance.
 *
 * THE ALGEBRA
 *
 *     nothing was evaluated              → INDETERMINATE
 *     any BLOCKED present                → BLOCKED
 *     otherwise any non-PASS present     → FAIL
 *     otherwise dependencies unsatisfied → FAIL
 *     otherwise applicability conflict   → FAIL
 *     otherwise                          → PASS
 *
 * HOW IT IS BUILT, AND WHY THAT MATTERS
 *
 * Each result is reduced to a gate effect drawn from a three-level lattice — `pass` < `fail` <
 * `blocked` — and the overall effect is the maximum over the set. Two properties then hold by
 * construction rather than by test:
 *
 *   - MONOTONICITY WITH RESPECT TO FAILURE. Adding a result can only raise the maximum, never lower
 *     it. No addition to the set can turn a non-`PASS` outcome into `PASS`. This survives the outcome
 *     vocabulary growing: a seventh class added to `OUTCOME_CLASSES` that is not `PASS` maps to at
 *     least `fail` without this function changing.
 *   - NO OFFSETTING. `max` over a set is not a sum and not an average, so a green pack cannot dilute a
 *     red one. There is no arithmetic here at all.
 *
 * THE EMPTY SET. Mathematically an empty conjunction is true. Operationally, "nothing ran" becoming
 * green is precisely the failure this repository exists to prevent, so the empty set is
 * `INDETERMINATE` and is checked before anything else. The same applies when every pack is
 * `NOT_APPLICABLE`: a portfolio that declared its way out of every authority evaluated nothing, and
 * evaluated nothing is not a pass.
 *
 * REASONS ARE NOT REWRITTEN. The overall outcome is the gate result. It is not a lossy replacement for
 * why: each contributing result keeps its own class, verbatim, in `reasons`. `UNRESOLVED` (the
 * authority could not be obtained) and `INDETERMINATE` (the authority ran but established nothing)
 * both fail the gate for operationally different reasons and send someone to fix different things.
 * Collapsing them in the report would make CI tell people the wrong remedy.
 */

/**
 * The orchestrator's own vocabulary that every pack verdict maps into. Only `PASS` is green.
 *
 *   PASS          — the authority ran, reached a positive conclusion, and its evidence gate was met.
 *   FAIL          — the authority ran and reached a negative conclusion.  Remedy: fix the project.
 *   BLOCKED       — a prohibition fired.  Remedy: stop; this is not a fix-and-rerun.
 *   INDETERMINATE — the authority ran but no honest conclusion could be established.
 *                   Remedy: give it something to evaluate, or fix the project's adoption.
 *   UNRESOLVED    — the authority could not be obtained or verified; nothing ran.
 *                   Remedy: fix the pin, push the tag, add an adapter.
 *   CONFLICT      — declaration and detection disagree.  Remedy: a human adjudicates.
 */
export const OUTCOME_CLASSES = Object.freeze([
  "PASS",
  "FAIL",
  "BLOCKED",
  "INDETERMINATE",
  "UNRESOLVED",
  "CONFLICT",
]);

/** Applicability states. `CONFLICT` is a gate failure; `NOT_APPLICABLE` is not an evaluation. */
export const APPLICABILITY_STATES = Object.freeze([
  "CONFIRMED",
  "DECLARED_ONLY",
  "NOT_APPLICABLE",
  "CONFLICT",
]);

export const DEPENDENCY_STATES = Object.freeze(["satisfied", "unsatisfied", "not-applicable"]);

/**
 * The gate lattice. Ordering is the whole mechanism: aggregation is `max`, so a higher effect can
 * never be undone by adding more results.
 */
const EFFECT_ORDER = Object.freeze({ pass: 0, fail: 1, blocked: 2 });

/** Overall outcomes this module can return. A superset of `pass`/`fail`/`blocked` by one. */
const EFFECT_OUTCOME = Object.freeze({ pass: "PASS", fail: "FAIL", blocked: "BLOCKED" });

export class OutcomeError extends Error {
  constructor(message) {
    super(message);
    this.name = "OutcomeError";
  }
}

/**
 * Validate a single pack result. Rejection rather than coercion is deliberate: a malformed result is
 * an orchestrator fault (exit 2), and the one thing it must never become is a silently ignored entry
 * that leaves a set looking unanimously green.
 */
function validate(result, index) {
  if (result === null || typeof result !== "object") {
    throw new OutcomeError(`result[${index}] is not an object`);
  }
  if (typeof result.pack !== "string" || result.pack.length === 0) {
    throw new OutcomeError(`result[${index}] has no pack name`);
  }
  if (!OUTCOME_CLASSES.includes(result.class)) {
    throw new OutcomeError(
      `result[${index}] (${result.pack}) has unknown outcome class ${JSON.stringify(result.class)}; ` +
        `expected one of ${OUTCOME_CLASSES.join(", ")}`,
    );
  }
  if (result.applicability !== undefined && !APPLICABILITY_STATES.includes(result.applicability)) {
    throw new OutcomeError(
      `result[${index}] (${result.pack}) has unknown applicability ${JSON.stringify(result.applicability)}`,
    );
  }
  if (result.dependencyStatus !== undefined && !DEPENDENCY_STATES.includes(result.dependencyStatus)) {
    throw new OutcomeError(
      `result[${index}] (${result.pack}) has unknown dependencyStatus ${JSON.stringify(result.dependencyStatus)}`,
    );
  }
}

/**
 * Reduce one result to its gate effect, and to the reasons that produced it.
 *
 * A result can contribute more than one reason — a pack can be `INDETERMINATE` *and* sit on an
 * unsatisfied dependency — and both are reported, because suppressing the second would hide work that
 * still needs doing after the first is fixed.
 *
 * Note the ordering of the `PASS` test: everything that is not exactly `PASS` fails. There is no
 * default-to-pass branch anywhere in this function, and adding an outcome class without touching this
 * file cannot create one.
 */
function effectOf(result) {
  const reasons = [];
  let effect = "pass";

  if (result.class === "BLOCKED") {
    effect = "blocked";
    reasons.push({ pack: result.pack, class: result.class, reason: result.detail ?? "a prohibition fired" });
  } else if (result.class !== "PASS") {
    effect = "fail";
    reasons.push({ pack: result.pack, class: result.class, reason: result.detail ?? describe(result.class) });
  }

  if (result.dependencyStatus === "unsatisfied") {
    effect = raise(effect, "fail");
    reasons.push({
      pack: result.pack,
      class: result.class,
      dependencyStatus: "unsatisfied",
      reason: result.dependencyReason ?? "a required upstream authority did not pass",
    });
  }

  if (result.applicability === "CONFLICT") {
    effect = raise(effect, "fail");
    reasons.push({
      pack: result.pack,
      class: result.class,
      applicability: "CONFLICT",
      reason: result.applicabilityReason ?? "declaration and detection disagree; a human must adjudicate",
    });
  }

  return { effect, reasons };
}

function raise(a, b) {
  return EFFECT_ORDER[a] >= EFFECT_ORDER[b] ? a : b;
}

function describe(outcomeClass) {
  switch (outcomeClass) {
    case "FAIL":
      return "the authority ran and reached a negative conclusion";
    case "INDETERMINATE":
      return "the authority ran but no conclusion could be established";
    case "UNRESOLVED":
      return "the authority could not be obtained or verified; nothing ran";
    case "CONFLICT":
      return "declaration and detection disagree; a human must adjudicate";
    default:
      return outcomeClass;
  }
}

/**
 * Aggregate pack results into one gate outcome.
 *
 * Returns `{ outcome, reasons, coverage }`. `coverage` is each pack's own coverage object under that
 * pack's name, verbatim — see `carryCoverage`.
 */
export function aggregate(results) {
  if (!Array.isArray(results)) {
    throw new OutcomeError("aggregate() expects an array of pack results");
  }
  results.forEach(validate);

  const evaluated = results.filter((r) => r.applicability !== "NOT_APPLICABLE");

  if (evaluated.length === 0) {
    return {
      outcome: "INDETERMINATE",
      reasons: [
        {
          pack: null,
          class: "INDETERMINATE",
          reason:
            results.length === 0
              ? "no standards authority was evaluated"
              : "every declared standards authority was not-applicable; nothing was evaluated",
        },
      ],
      coverage: carryCoverage(results),
    };
  }

  let effect = "pass";
  const reasons = [];
  for (const result of evaluated) {
    const contribution = effectOf(result);
    effect = raise(effect, contribution.effect);
    reasons.push(...contribution.reasons);
  }

  return { outcome: EFFECT_OUTCOME[effect], reasons, coverage: carryCoverage(results) };
}

/**
 * Carry each pack's coverage through verbatim, keyed by pack name.
 *
 * There is no portfolio coverage percentage, and adding one would be a defect rather than a feature.
 * The recon found three incompatible coverage shapes across four packs — Prediction counts catalogued
 * and evaluated rules, ML counts rules and invariants and kinds — and a combined number would assert a
 * comparability that does not exist. Each object keeps its own field names and its own note, so a
 * reader sees what each authority actually measured.
 */
export function carryCoverage(results) {
  const coverage = {};
  for (const result of results) {
    if (result.coverage !== undefined) coverage[result.pack] = result.coverage;
  }
  return coverage;
}

/**
 * The process exit contract. `2` is reserved for the orchestrator itself failing and is never produced
 * from an outcome — a broken orchestrator must never be reported as a non-compliant project.
 */
export function exitCodeFor(outcome) {
  if (!["PASS", "FAIL", "BLOCKED", "INDETERMINATE"].includes(outcome)) {
    throw new OutcomeError(`exitCodeFor() received a non-outcome ${JSON.stringify(outcome)}`);
  }
  return outcome === "PASS" ? 0 : 1;
}
