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

/**
 * What the detectors observed.
 *
 * `INDETERMINATE` means the detectors could not look — an unreadable tree, or a stack none of them
 * understands. `NO_DETECTOR` means there was nothing configured to look in the first place, which is a
 * fact about this repository rather than about the project being evaluated. Collapsing the two would
 * make a pack with no detector permanently un-declarable: every `NOT_APPLICABLE` would conflict with a
 * detection that was never going to happen, and no portfolio containing such a pack could ever pass.
 */
export const DETECTIONS = Object.freeze(["DETECTED", "NOT_DETECTED", "INDETERMINATE", "NO_DETECTOR"]);

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

  // The NO_DETECTOR column. Here the declaration is the only evidence that exists, because this
  // repository configured nothing to look. That is not the declaration overriding a detection — there
  // is no detection to override — and the report says so, so a reader can see that the corroboration
  // is missing rather than assume it was obtained.
  "REQUIRED/NO_DETECTOR": {
    disposition: "APPLICABLE",
    applicability: "DECLARED_ONLY",
    rationale: "declared required; no detector is configured for this authority, so nothing corroborates it",
  },
  "NOT_APPLICABLE/NO_DETECTOR": {
    disposition: "NOT_APPLICABLE",
    applicability: "NOT_APPLICABLE",
    rationale:
      "declared not applicable, on the declaration alone: no detector is configured for this authority, " +
      "so there is no independent evidence either way. Detector coverage is this repository's own gap, " +
      "and stating it is more honest than blocking on a corroboration that was never going to arrive",
    detectionDisagreement: false,
  },
  "UNSPECIFIED/NO_DETECTOR": {
    disposition: "UNRESOLVED",
    applicability: "UNRESOLVED",
    rationale: "nobody declared anything and nothing was configured to look; applicability is unknown",
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
    const required = readRequired(entry.required, pack);
    if (required === undefined) {
      // An entry that exists but does not say. Not a default to guess at.
      declarations.set(pack, { declaration: "UNSPECIFIED", version: entry.version });
    } else {
      declarations.set(pack, { declaration: required ? "REQUIRED" : "NOT_APPLICABLE", version: entry.version });
    }
  }
  return declarations;
}

/**
 * Read one `required` value.
 *
 * Both the boolean and its string form are accepted, because the manifest reader is untyped and
 * `required: true` in YAML arrives here as `"true"`. Anything else THROWS rather than falling through
 * to `UNSPECIFIED`. That direction matters: a typo like `required: yes` silently becoming "nobody
 * said" would turn a malformed declaration into the same escape hatch as omitting the pack entirely,
 * and the person who wrote it would believe they had declared something.
 */
function readRequired(value, pack) {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new ApplicabilityError(
    `${pack}: 'required' must be true or false, not ${JSON.stringify(value)}. A value that cannot be ` +
      `read is not the same as saying nothing, and must not quietly become it.`,
  );
}

/** One line per pack, phrased so a reader sees both sources rather than only the conclusion. */
export function renderApplicability(result) {
  const head = `${result.pack}: ${result.disposition}`;
  const sources = `declaration=${result.declaration} detection=${result.detection}`;
  const count = result.evidence.length === 0 ? "no evidence" : `${result.evidence.length} signal(s)`;
  return `${head} (${sources}, ${count}) — ${result.rationale}`;
}
