/**
 * Interpreter for PredictionStandards v1.1.0 (ebe232b). [FACT]
 *
 * Derived by reading that release and running its verdict command. Carries forward to no other
 * release.
 *
 * The reason this release needs a derivation at all: its envelope has NO top-level conclusion field.
 * Top level is {schemaVersion, command, policy, asOf, parameters, records[], aggregate}, and each
 * record carries its own status. The run-level answer therefore has to be composed, and composing it
 * silently in shared orchestrator code would mean inventing a conclusion the pack never stated. It is
 * written out here instead, in one place, ordered, and testable.
 */

export const pack = "prediction";
export const version = "1.1.0";

const COUNTS = [
  "supported",
  "supportedWithExceptions",
  "insufficientlySupported",
  "blockedByInvariant",
  "notEvaluated",
];

/**
 * Derive the run-level conclusion from the aggregate counts, in this order:
 *
 *     blockedByInvariant      > 0 → BLOCKED_BY_INVARIANT
 *     notEvaluated            > 0 → NOT_EVALUATED
 *     insufficientlySupported > 0 → INSUFFICIENTLY_SUPPORTED
 *     supported(+exceptions)  > 0 → SUPPORTED / SUPPORTED_WITH_EXCEPTIONS
 *     every count zero            → NOT_EVALUATED
 *
 * The ordering is severity-first so that no positive count can mask a blocked or unevaluated record.
 * The final clause is the one that matters: all-zero means no record was evaluated. That is not a
 * quiet success, and it is the same hazard as the empty set at the aggregation layer.
 *
 * The returned string is always a term from the release's own vocabulary, so it must still pass
 * through the adapter's verdictMap. This function never returns an outcome class directly — inventing
 * one here would route around the exhaustiveness check on that map.
 */
export function readVerdict(envelope) {
  const aggregate = envelope?.aggregate;
  if (aggregate === null || typeof aggregate !== "object") return null;
  for (const key of COUNTS) {
    if (!Number.isInteger(aggregate[key]) || aggregate[key] < 0) return null;
  }

  if (aggregate.blockedByInvariant > 0) return "BLOCKED_BY_INVARIANT";
  if (aggregate.notEvaluated > 0) return "NOT_EVALUATED";
  if (aggregate.insufficientlySupported > 0) return "INSUFFICIENTLY_SUPPORTED";
  if (aggregate.supportedWithExceptions > 0) return "SUPPORTED_WITH_EXCEPTIONS";
  if (aggregate.supported > 0) return "SUPPORTED";
  return "NOT_EVALUATED";
}

export function describeEvidence() {
  return "at least one record reached a positive conclusion (aggregate.supported + aggregate.supportedWithExceptions > 0)";
}

/**
 * Whether the release evaluated enough to support a positive conclusion.
 *
 * This release reports `denominator` PER RECORD, not per run, so there is no top-level field to read.
 * The run-level evidence question is answered by the aggregate counts instead — which is precisely why
 * a generic cross-pack gate reading `denominator.scored` would have been wrong here, and would have
 * been wrong silently.
 */
export function positiveEvidence(envelope) {
  const aggregate = envelope?.aggregate;
  if (aggregate === null || typeof aggregate !== "object") {
    return { satisfied: false, detail: "the envelope carried no aggregate, so nothing establishes what ran" };
  }
  const positive = (aggregate.supported ?? 0) + (aggregate.supportedWithExceptions ?? 0);
  if (!Number.isInteger(positive) || positive <= 0) {
    return { satisfied: false, detail: "no record reached a positive conclusion" };
  }
  if (!Array.isArray(envelope.records) || envelope.records.length === 0) {
    return { satisfied: false, detail: "the aggregate reported positive counts but no records were present" };
  }
  return { satisfied: true, detail: `${positive} record(s) reached a positive conclusion` };
}

/**
 * Coverage for this release is per record, so it is returned as one entry per record with the file it
 * came from. Not summed, not averaged, not reduced to a single figure — the records are separate
 * subjects and a combined number would assert they were one.
 */
export function readCoverage(envelope) {
  if (!Array.isArray(envelope?.records)) return undefined;
  const perRecord = envelope.records
    .filter((r) => r?.frameworkCoverage !== undefined)
    .map((r) => ({ file: r.file, frameworkCoverage: r.frameworkCoverage }));
  return perRecord.length > 0 ? { basis: "perRecord", records: perRecord } : undefined;
}
