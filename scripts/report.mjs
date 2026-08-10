/**
 * The combined report.
 *
 * Two properties this file exists to hold:
 *
 * 1. THE SIX OUTCOME CLASSES SURVIVE TO THE JSON. The gate result is one of PASS / FAIL / BLOCKED /
 *    INDETERMINATE. It is the answer to "may this merge", and it is NOT a replacement for why. Each
 *    authority keeps its own class — UNRESOLVED, CONFLICT, INDETERMINATE and the rest — because they
 *    fail for operationally different reasons and send someone to fix different things. Anyone reading
 *    only the top-level outcome would learn that something is wrong; they need the rest to learn what.
 *
 * 2. COVERAGE IS PER AUTHORITY, VERBATIM. Each pack's own coverage object under that pack's name, with
 *    its own field names and its own note. There is no portfolio coverage figure anywhere, because the
 *    shapes are not commensurable and a combined number would assert a comparability that does not
 *    exist.
 */

import { aggregate } from "./outcome.mjs";

const EXIT = { PASS: 0, FAIL: 1, BLOCKED: 1, INDETERMINATE: 1 };

/**
 * Assemble the report.
 *
 * `authorities` is the per-authority record: identity, resolution, applicability, outcome class, the
 * pack's own verdict string, its coverage, and its dependency status.
 */
export function buildReport({ project, authorities, generatedAt }) {
  const gate = aggregate(
    authorities.map((a) => ({
      pack: a.pack,
      class: a.class,
      applicability: a.applicability,
      dependencyStatus: a.dependencyStatus,
      dependencyReason: a.dependencyReason,
      applicabilityReason: a.applicabilityReason,
      detail: a.detail,
      coverage: a.coverage,
    })),
  );

  return {
    schemaVersion: "1.0.0",
    project,
    generatedAt,
    outcome: gate.outcome,
    reasons: gate.reasons,
    authorities: authorities.map((a) => ({
      authority: a.authority,
      pack: a.pack,
      version: a.version,
      // Resolution and execution facts, kept beside the conclusion so a reader can tell whether an
      // authority failed, never ran, or ran on code nobody expected.
      resolution: {
        status: a.resolution?.status,
        reasonCode: a.resolution?.reasonCode,
        ref: a.resolution?.ref,
        commit: a.commit ?? a.resolution?.commit,
        detail: a.resolution?.detail,
      },
      applicability: {
        disposition: a.disposition,
        state: a.applicability,
        declaration: a.declaration,
        detection: a.detection,
        evidence: a.evidence,
        rationale: a.applicabilityRationale,
      },
      // The orchestrator's class AND the pack's own word for it, never one in place of the other.
      class: a.class,
      packVerdict: a.verdict ?? null,
      detail: a.detail,
      dependencyStatus: a.dependencyStatus,
      dependencyReason: a.dependencyReason,
      exitCode: a.exitCode,
      invocation: a.invocation,
      hazardsMitigated: a.hazardsMitigated,
      // Verbatim. Not reshaped, not normalised, not combined with anything.
      coverage: a.coverage,
    })),
    coverage: gate.coverage,
  };
}

/**
 * The exit contract. 0 for a pass, 1 for any gate failure. 2 is reserved for the orchestrator itself
 * failing and is never produced from a report — a broken orchestrator must never be reported as a
 * non-compliant project.
 */
export function exitCodeFor(report) {
  return EXIT[report.outcome] ?? 1;
}

/** The readable rendering. Every non-PASS authority states what would fix it. */
export function renderReport(report) {
  const out = [];
  out.push(`Standards gate: ${report.outcome}`);
  out.push(`Project: ${report.project}`);
  out.push("");

  for (const a of report.authorities) {
    const commit = a.resolution?.commit ? ` @ ${a.resolution.commit.slice(0, 7)}` : "";
    out.push(`  ${a.authority}${commit}`);
    out.push(`      applicability  ${a.applicability.disposition} (declared ${a.applicability.declaration}, detected ${a.applicability.detection})`);
    if (a.resolution?.status !== undefined) {
      const reason = a.resolution.reasonCode ? ` — ${a.resolution.reasonCode}` : "";
      out.push(`      resolution     ${a.resolution.status}${reason}`);
    }
    out.push(`      outcome        ${a.class}${a.packVerdict ? ` (reported ${a.packVerdict})` : ""}`);
    if (a.dependencyStatus === "unsatisfied") {
      out.push(`      prerequisite   UNSATISFIED — ${a.dependencyReason}`);
    }
    if (a.detail) out.push(`      ${a.detail}`);
    if (a.coverage !== undefined) {
      // Printed under the authority that reported it, in that authority's own shape.
      out.push(`      coverage       ${JSON.stringify(a.coverage)}`);
    }
    out.push("");
  }

  if (report.outcome === "PASS") {
    out.push("Every applicable authority passed and every prerequisite was satisfied.");
  } else {
    out.push(`The gate is ${report.outcome} for ${report.reasons.length} reason(s):`);
    for (const reason of report.reasons) {
      const where = reason.pack ?? "the portfolio";
      const label = reason.dependencyStatus ?? reason.applicability ?? reason.class;
      out.push(`  ${where}: ${label} — ${reason.reason}`);
    }
  }
  out.push("");
  out.push("Coverage figures are each authority's own and are never combined; there is no portfolio total.");
  out.push("");
  return out.join("\n");
}
