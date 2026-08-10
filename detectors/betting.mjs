/**
 * Applicability signals for the betting authority.
 *
 * WHAT A DETECTOR IS. A detector produces EVIDENCE about applicability. It does not produce an
 * applicability verdict, and nothing it returns can decide whether a pack runs. Finding a signal
 * raises a question; finding none answers nothing. That constraint is what keeps a file like this on
 * the right side of the authority boundary: it holds no rule about what constitutes good betting work,
 * only observations about whether this project appears to do betting work at all — and even those are
 * handed to a human or a declaration to act on.
 *
 * WHY THESE FILES LIVE OUTSIDE rules/, schemas/, AND registry/. Detectors necessarily name domain
 * vocabulary; that is their whole function. They are kept out of the normative directories because
 * they carry no normative weight, and `scripts/boundary.mjs` checks them for the opposite property
 * instead: a detector must never reference an outcome class. A detector that could conclude has
 * stopped being a detector.
 *
 * SIGNALS ARE STRUCTURAL, NOT LEXICAL. The true positive for a project that places real orders is a
 * call that submits one — not the word "odds" appearing somewhere. A repository is allowed to discuss
 * betting at length precisely because its documentation explains that it does not place bets, and a
 * detector that fired on that would be worse than no detector: it would train people to dismiss it.
 */

export const pack = "betting";

/**
 * `confidence` is recorded for a reader and is deliberately qualitative. It is never compared,
 * summed, or thresholded — turning it into a number would put human judgement behind a decimal, where
 * 0.91 and 0.89 would mean entirely different things for no defensible reason.
 */
export const signals = [
  {
    id: "order-placement-call",
    basis: "a call that submits an order to a trading or market venue, which is the act itself rather than a discussion of it",
    confidence: "high",
    extensions: [".py", ".js", ".mjs", ".ts", ".tsx", ".cs", ".go", ".rb", ".java"],
    // A POST to an orders endpoint. Deliberately requires the verb and the path together: a URL
    // constant on its own is configuration, and a bare `post(` is every HTTP client ever written.
    //
    // The leading `_?` is not decoration. Run against a real portfolio, the first version of this
    // pattern matched four call sites in a test file and missed the production one, because the
    // client wraps its transport as `self._post(path, payload)`. A private-method convention is the
    // normal shape for exactly the code most worth detecting.
    pattern: /[._]\s*_{0,2}(post|postasync|send)\s*\(\s*[^)]{0,120}["'`][^"'`]*\/(orders|order)\b/i,
  },
  {
    id: "stake-sizing-computation",
    basis: "a defined function that computes how much to stake, which only exists where stakes are placed",
    confidence: "moderate",
    extensions: [".py", ".js", ".mjs", ".ts", ".tsx", ".cs", ".go", ".rb", ".java"],
    pattern: /\b(def|function|fn|public|private|const)\s+[a-z_$][\w$]*(stake_size|stake_sizing|position_size|sizing_for_bet)/i,
  },
  {
    id: "settlement-ledger-schema",
    basis: "a persisted record of placed orders and their settlement, which is what a project keeps only if it places them",
    confidence: "moderate",
    extensions: [".sql"],
    pattern: /\bcreate\s+table\s+[\w.\[\]"`]*\b\w*(orders|fills|settlements)\b/i,
  },
];
