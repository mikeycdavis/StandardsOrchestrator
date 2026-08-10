/**
 * Applicability signals for the prediction authority.
 *
 * See detectors/betting.mjs for the contract. In short: these produce evidence, never a verdict, and
 * finding nothing establishes nothing.
 */

export const pack = "prediction";

export const signals = [
  {
    id: "probability-forecast-call",
    basis: "a call that produces a probability estimate from a model, which is the output the prediction authority governs",
    confidence: "high",
    extensions: [".py", ".js", ".mjs", ".ts", ".tsx", ".cs", ".go", ".rb", ".java"],
    pattern: /\.(predict_proba|predictproba|predict_prob)\s*\(/i,
  },
  {
    id: "forecast-record-store",
    basis: "a persisted store of forecasts, which is what a project keeps only if it makes and later scores them",
    confidence: "moderate",
    extensions: [".sql"],
    pattern: /\bcreate\s+table\s+[\w.\[\]"`]*\b\w*(predictions|forecasts)\b/i,
  },
];
