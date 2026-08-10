/**
 * Interpreter for BettingStandards v1.0.0 (a4e7e68). [FACT]
 *
 * Everything here was derived by reading that release and running its verdict command. It carries
 * forward to no other release: a new version gets a new interpreter, even if nothing changed.
 *
 * This is code rather than a declarative expression on purpose. "The authority meaningfully evaluated
 * something" has different semantics in every pack — this release answers it with a run-level
 * denominator, the neighbouring one answers it with per-record aggregate counts, and a future one may
 * have no denominator at all. A generic field the orchestrator interpreted uniformly would be exactly
 * the cross-pack inference this architecture forbids.
 */

export const pack = "betting";
export const version = "1.0.0";

/**
 * The release's own conclusion, verbatim. Returns null when the envelope does not carry one in the
 * declared shape — which is an execution-contract failure, never a guess at the nearest term.
 */
export function readVerdict(envelope) {
  if (envelope === null || typeof envelope !== "object") return null;
  return typeof envelope.status === "string" ? envelope.status : null;
}

export function describeEvidence() {
  return "at least one required-level rule was actually scored (denominator.scored > 0)";
}

/**
 * Whether the release evaluated enough to support a positive conclusion.
 *
 * This release reports `denominator.scored` with basis "required-level rules that were evaluated". A
 * run in which every rule was skipped as not-applicable therefore reports scored: 0 while still
 * reaching a positive status — the green-from-nothing shape. The gate makes that visible.
 *
 * Note what is NOT read: the envelope also carries a numeric score, and this function never touches
 * it. A percentage from a run that concluded nothing is the most convincing false green available.
 */
export function positiveEvidence(envelope) {
  const denominator = envelope?.denominator;
  if (denominator === null || typeof denominator !== "object") {
    return {
      satisfied: false,
      detail: "the envelope carried no denominator, so it is not possible to tell what was evaluated",
    };
  }
  const scored = denominator.scored;
  if (!Number.isInteger(scored) || scored < 0) {
    return { satisfied: false, detail: `denominator.scored was ${JSON.stringify(scored)}, not a count` };
  }
  if (scored === 0) {
    return {
      satisfied: false,
      detail: `no required-level rule was scored (applicable: ${denominator.applicable ?? "unknown"}, scored: 0)`,
    };
  }
  return { satisfied: true, detail: `${scored} required-level rule(s) were scored` };
}

/** The release's own coverage object, verbatim. Never reshaped, never combined with another pack's. */
export function readCoverage(envelope) {
  return envelope?.frameworkCoverage;
}
