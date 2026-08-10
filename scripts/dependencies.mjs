/**
 * Composition prerequisites between independent authorities.
 *
 * THREE SEPARATE THINGS, KEPT SEPARATE. Conflating any two of them is the standard way this goes
 * wrong, and the usual conflation is "the prerequisite ran first" with "the prerequisite passed well
 * enough to be depended upon":
 *
 *     prerequisites                     ->  execution order        (topological)
 *     results + applicability           ->  dependency satisfaction
 *     dependency satisfaction + algebra ->  the portfolio gate
 *
 * WHAT A PREREQUISITE IS. An authority requires another authority to be SATISFIED before its own
 * result may contribute to a composed conclusion. That is the entire vocabulary — dependency,
 * prerequisite, authority, satisfaction — and it is precise on purpose. This file encodes no domain
 * reasoning: it says nothing about either subject, only about which conclusions may be relied upon by
 * which others.
 *
 * DORMANT PREREQUISITES IMPOSE NOTHING. A prerequisite becomes an obligation because the DEPENDENT
 * authority is applicable, never because a line exists in the registry. If the dependent is
 * not-applicable, its prerequisite is not thereby dragged into the run.
 *
 * NO REVERSE INFERENCE. A dependent passing establishes nothing whatsoever about its prerequisite.
 * Satisfaction is read from the prerequisite's own result and its own applicability, never inferred
 * backwards from anything downstream.
 *
 * TRANSITIVITY, PRECISELY. If A requires B and B requires C, this module does NOT claim A requires C.
 * What it does claim is narrower and follows from the word "satisfied": B cannot be satisfied while
 * standing on an unsatisfied prerequisite of its own, so A's requirement on B fails. The `requires`
 * relation stays direct; only the satisfaction relation composes. Execution order is transitive
 * because ordering must be, and that is a separate computation.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validate as validateSchema, assertSchemaSupported } from "./jsonschema.mjs";
import { adapterKey } from "./registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class DependencyError extends Error {
  constructor(message) {
    super(message);
    this.name = "DependencyError";
  }
}

/**
 * Load and fully validate the prerequisites.
 *
 * Every check here is a load-time check. A cycle discovered during execution would already have
 * produced a partial run whose ordering was arbitrary, and an unregistered authority discovered during
 * execution would be a typo that had already silently become an absent prerequisite.
 */
export async function loadDependencies(registry, root = ROOT) {
  const schema = JSON.parse(await readFile(path.join(root, "schemas", "dependencies.schema.json"), "utf8"));
  assertSchemaSupported(schema);

  let document;
  try {
    document = JSON.parse(await readFile(path.join(root, "registry", "dependencies.json"), "utf8"));
  } catch (error) {
    throw new DependencyError(`registry/dependencies.json could not be read: ${error.message}`);
  }

  const errors = validateSchema(document, schema);
  if (errors.length > 0) {
    const detail = errors.map((e) => `  ${e.path || "(root)"}: ${e.message}`).join("\n");
    throw new DependencyError(`registry/dependencies.json does not satisfy its schema:\n${detail}`);
  }

  const requires = new Map();
  for (const [dependent, entry] of Object.entries(document.dependencies)) {
    // Both ends must name a registered authority at an exact version. A typo must not be able to
    // become a prerequisite that quietly does not exist.
    if (!registry.adapters.has(dependent)) {
      throw new DependencyError(`'${dependent}' is not a registered authority, so it cannot depend on anything`);
    }
    const seen = new Set();
    for (const requirement of entry.requires) {
      if (!registry.adapters.has(requirement.authority)) {
        throw new DependencyError(
          `${dependent} requires '${requirement.authority}', which is not a registered authority`,
        );
      }
      if (requirement.authority === dependent) {
        throw new DependencyError(`${dependent} lists itself as its own prerequisite`);
      }
      if (seen.has(requirement.authority)) {
        throw new DependencyError(`${dependent} lists ${requirement.authority} as a prerequisite twice`);
      }
      seen.add(requirement.authority);
    }
    requires.set(dependent, entry.requires);
  }

  assertAcyclic(requires);
  return { requires };
}

/**
 * Reject cycles at load. A cycle has no valid execution order, and the failure mode of discovering
 * that during a run is an arbitrary order that looks deliberate.
 */
function assertAcyclic(requires) {
  const state = new Map();
  const stack = [];

  const visit = (node) => {
    if (state.get(node) === "done") return;
    if (state.get(node) === "open") {
      const cycle = [...stack.slice(stack.indexOf(node)), node].join(" -> ");
      throw new DependencyError(`the prerequisites form a cycle: ${cycle}`);
    }
    state.set(node, "open");
    stack.push(node);
    for (const requirement of requires.get(node) ?? []) visit(requirement.authority);
    stack.pop();
    state.set(node, "done");
  };

  for (const node of requires.keys()) visit(node);
}

/**
 * The order in which authorities may be executed: every prerequisite before its dependent.
 *
 * This answers ONLY "what order", and answering it is not evidence about anything. An authority
 * appearing earlier in this list has not thereby passed, and the satisfaction computation below never
 * consults the order.
 */
export function executionOrder(dependencies, authorities) {
  const wanted = [...authorities].sort();
  const ordered = [];
  const placed = new Set();

  const visit = (node, trail) => {
    if (placed.has(node)) return;
    if (trail.includes(node)) throw new DependencyError(`the prerequisites form a cycle: ${trail.join(" -> ")}`);
    for (const requirement of dependencies.requires.get(node) ?? []) {
      // A prerequisite outside the requested set is ordered only if it is actually being run.
      if (wanted.includes(requirement.authority)) visit(requirement.authority, [...trail, node]);
    }
    placed.add(node);
    ordered.push(node);
  };

  for (const node of wanted) visit(node, []);
  return ordered;
}

/** An authority's result is usable as a prerequisite only under these applicability states. */
const RAN_AND_COUNTED = new Set(["CONFIRMED", "DECLARED_ONLY"]);

/**
 * Evaluate whether each authority's prerequisites were satisfied.
 *
 * `results` maps an authority key to `{ class, applicability }` — the outcome class from execution and
 * the disposition from applicability. Returns a Map of authority key to
 * `{ dependencyStatus, unsatisfiedBy }`, ready to hand to the outcome algebra.
 *
 * The satisfaction test is a conjunction and every term is required. A prerequisite is satisfied when
 * it actually ran and counted, reached `PASS`, and stood on satisfied prerequisites of its own. Every
 * other state — not-applicable, unresolved, conflicting, indeterminate, failed, blocked, or simply
 * absent from the run — leaves it unsatisfied.
 */
export function evaluateSatisfaction(dependencies, results) {
  const satisfaction = new Map();

  const dependentsFirst = [...results.keys()].sort();
  const ordered = executionOrder(dependencies, dependentsFirst);

  for (const authority of ordered) {
    const own = results.get(authority);
    const requirements = dependencies.requires.get(authority) ?? [];

    if (requirements.length === 0) {
      satisfaction.set(authority, { dependencyStatus: "not-applicable", unsatisfiedBy: [] });
      continue;
    }

    // A dormant dependent imposes nothing. The prerequisite is not dragged into the run merely because
    // a line exists in the registry; it becomes an obligation because the dependent is applicable.
    if (own?.applicability === "NOT_APPLICABLE") {
      satisfaction.set(authority, {
        dependencyStatus: "not-applicable",
        unsatisfiedBy: [],
        note: "the dependent authority is not applicable, so its prerequisites impose no obligation",
      });
      continue;
    }

    const unsatisfiedBy = [];
    for (const requirement of requirements) {
      const prerequisite = results.get(requirement.authority);
      const prerequisiteSatisfaction = satisfaction.get(requirement.authority);

      if (prerequisite === undefined) {
        unsatisfiedBy.push({
          authority: requirement.authority,
          because: "the prerequisite authority was not part of this run at all",
        });
        continue;
      }
      if (!RAN_AND_COUNTED.has(prerequisite.applicability)) {
        unsatisfiedBy.push({
          authority: requirement.authority,
          because:
            `the prerequisite authority's applicability is ${prerequisite.applicability}. This is not a ` +
            `finding against that authority — it is that the prerequisites for a composed result have ` +
            `not been met`,
        });
        continue;
      }
      if (prerequisite.class !== "PASS") {
        unsatisfiedBy.push({
          authority: requirement.authority,
          because: `the prerequisite authority is ${prerequisite.class}`,
        });
        continue;
      }
      if (prerequisiteSatisfaction?.dependencyStatus === "unsatisfied") {
        // Not a claim that this authority requires its prerequisite's prerequisites. It is that an
        // authority standing on an unsatisfied prerequisite is not itself satisfied.
        unsatisfiedBy.push({
          authority: requirement.authority,
          because: "the prerequisite authority passed but stands on an unsatisfied prerequisite of its own",
        });
      }
    }

    satisfaction.set(authority, {
      dependencyStatus: unsatisfiedBy.length === 0 ? "satisfied" : "unsatisfied",
      unsatisfiedBy,
    });
  }

  for (const authority of results.keys()) {
    if (!satisfaction.has(authority)) {
      satisfaction.set(authority, { dependencyStatus: "not-applicable", unsatisfiedBy: [] });
    }
  }

  return satisfaction;
}

/**
 * Fold satisfaction into the results the outcome algebra consumes.
 *
 * An unsatisfied prerequisite does NOT suppress the dependent's execution or overwrite its verdict —
 * its evidence is genuinely useful, and reporting that the mechanics were sound conditional on
 * something unsupported says more than refusing to run it. What it does is invalidate the dependent's
 * contribution to the composed result.
 */
export function applySatisfaction(results, satisfaction) {
  return [...results.entries()].map(([authority, result]) => {
    const status = satisfaction.get(authority) ?? { dependencyStatus: "not-applicable", unsatisfiedBy: [] };
    const [pack] = authority.split("@");
    return {
      pack,
      authority,
      class: result.class,
      applicability: result.applicability,
      dependencyStatus: status.dependencyStatus,
      dependencyReason:
        status.dependencyStatus === "unsatisfied"
          ? status.unsatisfiedBy.map((u) => `${u.authority}: ${u.because}`).join("; ")
          : undefined,
      coverage: result.coverage,
    };
  });
}

export { adapterKey };
