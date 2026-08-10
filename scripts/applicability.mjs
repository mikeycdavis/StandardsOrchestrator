/**
 * Applicability: two independent evidence sources, and a disposition derived from both.
 *
 * THE DISTINCTION THIS MODULE EXISTS TO PRESERVE:
 *
 *     Detection is evidence about applicability, not an applicability verdict.
 *     Declaration is evidence about applicability, not unilateral authority to suppress detection.
 *
 * So both inputs are carried through verbatim and the disposition is derived beside them, never in
 * place of them. A reader can always see what each source said and disagree with the derivation.
 *
 * WHAT `NOT_DETECTED` MEANS. Exactly this: the configured detectors found no affirmative signal. It
 * does NOT mean the authority does not apply. If it meant that, every gap in detector recall would
 * become authority to waive a standards pack — the cheapest possible way out of a gate, available to
 * anyone who writes their code in a shape no detector was taught.
 *
 * THE ASYMMETRY AROUND `REQUIRED` IS DELIBERATE. A project that voluntarily requires a stronger
 * authority does not need a detector's permission. Detection never downgrades an explicit requirement;
 * a disagreement is recorded and the pack still runs.
 *
 * WHAT THIS MODULE WILL NOT DO. It will not manufacture certainty. Three of the nine cells refuse to
 * decide and say so, which is the honest answer when one evidence source is silent and the other is
 * ambiguous.
 */

/** What the project's manifest says. `UNSPECIFIED` is a real state, not a default to be filled in. */
export const DECLARATIONS = Object.freeze(["REQUIRED", "NOT_APPLICABLE", "UNSPECIFIED"]);

/** What the detectors observed. `INDETERMINATE` means they could not look, not that they saw nothing. */
export const DETECTIONS = Object.freeze(["DETECTED", "NOT_DETECTED", "INDETERMINATE"]);

/**
 * The derived disposition.
 *
 *   APPLICABLE   — run this authority.
 *   NOT_APPLICABLE — do not run it; it is also not an evaluation, so it cannot contribute a pass.
 *   CONFLICT     — the two sources cannot both be right. A human adjudicates.
 *   UNRESOLVED   — applicability was never established. Not the same as "does not apply".
 */
export const DISPOSITIONS = Object.freeze(["APPLICABLE", "NOT_APPLICABLE", "CONFLICT", "UNRESOLVED"]);

/**
 * The full nine-cell table, written out rather than computed, because every cell is a decision someone
 * should be able to read and argue with.
 */
const TABLE = {
  "REQUIRED/DETECTED": {
    disposition: "APPLICABLE",
    applicability: "CONFIRMED",
    rationale: "declared required and independently detected",
  },
  "REQUIRED/NOT_DETECTED": {
    disposition: "APPLICABLE",
    applicability: "DECLARED_ONLY",
    rationale:
      "declared required; no detector signal was found. The declaration stands — a project may hold " +
      "itself to an authority a detector cannot see, and detector recall is not a waiver mechanism",
    detectionDisagreement: true,
  },
  "REQUIRED/INDETERMINATE": {
    disposition: "APPLICABLE",
    applicability: "DECLARED_ONLY",
    rationale: "declared required; detection could not run, which changes nothing about the declaration",
  },
  "NOT_APPLICABLE/DETECTED": {
    disposition: "CONFLICT",
    applicability: "CONFLICT",
    rationale:
      "declared not applicable while detectors found an affirmative signal. Neither side wins " +
      "automatically: the declaration may be wrong, or the signal may be a false positive, and only a " +
      "person looking at the evidence can say which",
  },
  "NOT_APPLICABLE/NOT_DETECTED": {
    disposition: "NOT_APPLICABLE",
    applicability: "NOT_APPLICABLE",
    rationale: "declared not applicable and no signal contradicts it",
  },
  "NOT_APPLICABLE/INDETERMINATE": {
    disposition: "CONFLICT",
    applicability: "CONFLICT",
    rationale:
      "declared not applicable while detection could not run, so nothing corroborates the declaration. " +
      "Accepting it unexamined would make a broken detector the easiest route out of a gate",
  },
  "UNSPECIFIED/DETECTED": {
    disposition: "CONFLICT",
    applicability: "CONFLICT",
    rationale:
      "an affirmative signal was found and the project has said nothing about this authority. The " +
      "signal does not prove applicability, and silence does not refute it; someone must decide",
  },
  "UNSPECIFIED/NOT_DETECTED": {
    disposition: "UNRESOLVED",
    applicability: "UNRESOLVED",
    rationale:
      "the project has said nothing and no signal was found. This is not a determination that the " +
      "authority does not apply — it is the absence of one, and treating it as not-applicable would " +
      "make omission the cheapest way past a standards gate",
  },
  "UNSPECIFIED/INDETERMINATE": {
    disposition: "UNRESOLVED",
    applicability: "UNRESOLVED",
    rationale: "neither evidence source said anything; applicability was never established",
  },
};

export class ApplicabilityError extends Error {
  constructor(message) {
    super(message);
    this.name = "ApplicabilityError";
  }
}

/**
 * Derive a disposition from the two evidence sources, preserving both.
 *
 * `evidence` is whatever the detectors produced, carried through untouched — including when the
 * disposition ignores it. A `REQUIRED` pack whose detectors found nothing still reports the empty
 * evidence set, because "we looked and found nothing, and ran it anyway" is a different statement from
 * "we never looked".
 */
export function deriveApplicability({ pack, declaration, detection, evidence = [] }) {
  if (typeof pack !== "string" || pack === "") throw new ApplicabilityError("no pack named");
  if (!DECLARATIONS.includes(declaration)) {
    throw new ApplicabilityError(`unknown declaration ${JSON.stringify(declaration)} for ${pack}`);
  }
  if (!DETECTIONS.includes(detection)) {
    throw new ApplicabilityError(`unknown detection ${JSON.stringify(detection)} for ${pack}`);
  }

  const cell = TABLE[`${declaration}/${detection}`];
  return {
    pack,
    declaration,
    detection,
    disposition: cell.disposition,
    applicability: cell.applicability,
    rationale: cell.rationale,
    detectionDisagreement: cell.detectionDisagreement === true,
    evidence,
  };
}

/**
 * Read declarations from a project manifest.
 *
 * A pack absent from the manifest is `UNSPECIFIED`, never `NOT_APPLICABLE`. The distinction is the
 * whole point: saying nothing is not the same as saying no, and only one of them is a decision anyone
 * made.
 */
export function readDeclarations(manifest, packs) {
  const declared = manifest?.standards ?? {};
  const declarations = new Map();
  for (const pack of packs) {
    const entry = declared[pack];
    if (entry === undefined) {
      declarations.set(pack, { declaration: "UNSPECIFIED", version: undefined });
      continue;
    }
    if (entry.required === true) {
      declarations.set(pack, { declaration: "REQUIRED", version: entry.version });
    } else if (entry.required === false) {
      declarations.set(pack, { declaration: "NOT_APPLICABLE", version: entry.version });
    } else {
      // An entry that exists but does not say. Not a default to guess at.
      declarations.set(pack, { declaration: "UNSPECIFIED", version: entry.version });
    }
  }
  return declarations;
}

/** One line per pack, phrased so a reader sees both sources rather than only the conclusion. */
export function renderApplicability(result) {
  const head = `${result.pack}: ${result.disposition}`;
  const sources = `declaration=${result.declaration} detection=${result.detection}`;
  const count = result.evidence.length === 0 ? "no evidence" : `${result.evidence.length} signal(s)`;
  return `${head} (${sources}, ${count}) — ${result.rationale}`;
}
