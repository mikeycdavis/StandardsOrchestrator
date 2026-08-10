/**
 * Turning one pack's run into one outcome class.
 *
 * This is where the orchestrator is most tempted to be helpful, and where being helpful would be
 * dishonest. Three rules carry the weight:
 *
 * 1. AN UNRECOGNISED VERDICT IS NEVER MAPPED TO THE NEAREST KNOWN ONE. If a release emits a term the
 *    adapter does not cover, the evidence is that the adapter contract is no longer trustworthy — not
 *    that the term probably means what a similar term meant. The result is INDETERMINATE and the
 *    adapter needs re-deriving. The same applies to an undeclared exit code.
 *
 * 2. A POSITIVE VERDICT THAT FAILS ITS EVIDENCE GATE BECOMES INDETERMINATE, NEVER FAIL. The gate
 *    failing means the authority did not establish enough evaluation to support compliance. It does
 *    NOT mean the authority established non-compliance. The orchestrator has no standing to invent a
 *    violation on a pack's behalf — that would be authoring a domain conclusion, which is the one
 *    thing this repository may never do. FAIL says "the project is wrong"; INDETERMINATE says "not
 *    enough was evaluated to say". Only the pack may say the former.
 *
 * 3. AN INFRASTRUCTURE FAULT IS NEVER NON-COMPLIANCE. A pack that could not run, could not read its
 *    policy, or produced no parseable envelope has concluded nothing. Reporting that as failing work
 *    is the configuration-fault-as-non-compliance collapse every pack in this family warns about.
 *
 * Note that every failure path lands on INDETERMINATE rather than PASS. There is no branch in this
 * module that can produce PASS without a declared exit code, a parsed envelope, a mapped verdict, and
 * a satisfied pack-specific gate.
 */

export function classify(resolved, execution) {
  const { adapter, interpreter } = resolved;
  const { exitCode, stdout } = execution;

  const declared = adapter.exitCodes[String(exitCode)];
  if (declared === undefined) {
    return indeterminate(
      adapter,
      `exit code ${exitCode} is not declared by the adapter for ${adapter.pack}@${adapter.version}; ` +
        `the execution contract no longer matches the release`,
    );
  }

  if (declared.meaning === "blocked") {
    return { class: "BLOCKED", verdict: null, detail: declared.note, coverage: undefined, evidence: null };
  }

  if (declared.meaning === "infrastructureFault") {
    return indeterminate(adapter, `the authority could not evaluate (exit ${exitCode}): ${declared.note}`);
  }

  let envelope;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    // Covers the release that exits 1 from an unhandled error: exit 1 with no envelope is nothing
    // concluded, not a negative conclusion.
    return indeterminate(
      adapter,
      `exit ${exitCode} produced no parseable ${adapter.output.format} envelope, so nothing was concluded`,
    );
  }

  const verdict = interpreter.readVerdict(envelope);
  if (typeof verdict !== "string") {
    return indeterminate(
      adapter,
      `the envelope did not carry a conclusion in the declared shape (verdictSource: ${adapter.verdictSource})`,
    );
  }

  const outcome = adapter.verdictMap[verdict];
  if (outcome === undefined) {
    return indeterminate(
      adapter,
      `'${verdict}' is not in the vocabulary this adapter was derived against ` +
        `(${adapter.packVocabulary.join(", ")}); the adapter must be re-derived rather than guessed at`,
      { verdict, coverage: interpreter.readCoverage(envelope) },
    );
  }

  const coverage = interpreter.readCoverage(envelope);

  if (outcome !== "PASS") {
    return { class: outcome, verdict, detail: `the authority reported ${verdict}`, coverage, evidence: null };
  }

  const evidence = interpreter.positiveEvidence(envelope);
  if (evidence?.satisfied !== true) {
    return {
      class: "INDETERMINATE",
      verdict,
      detail:
        `the authority reported ${verdict} but did not establish enough evaluation to support it: ` +
        `${evidence?.detail ?? "the evidence gate returned nothing"}. This is not a finding against ` +
        `the project — the authority did not establish non-compliance, and the orchestrator has no ` +
        `standing to invent one on its behalf.`,
      coverage,
      evidence,
    };
  }

  return {
    class: "PASS",
    verdict,
    detail: `the authority reported ${verdict}; ${evidence.detail}`,
    coverage,
    evidence,
  };
}

function indeterminate(adapter, detail, extra = {}) {
  return { class: "INDETERMINATE", verdict: null, detail, coverage: undefined, evidence: null, ...extra };
}
