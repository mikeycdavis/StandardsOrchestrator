#!/usr/bin/env node
/**
 * The authority-boundary check.
 *
 * This repository composes standards authorities. It must never become one. A normative domain
 * requirement living here would be a second definition of something a domain pack already defines —
 * and since CI gates on the orchestrator, its copy would be the one that actually bound, quietly
 * relocating authority away from the repository that reasoned about the subject.
 *
 * WHAT THIS CHECKS, and the distinction that makes it usable: domain vocabulary is forbidden in the
 * files that carry *normative weight* — `rules/`, `schemas/`, `registry/`. It is expected and fine in
 * documentation, in tests, and in adapter metadata that must name the pack it points at. A check that
 * banned the word "betting" everywhere would fail on the sentence explaining why it exists.
 *
 * WHAT IT CANNOT ESTABLISH. It matches vocabulary, not intent. A domain rule phrased entirely in
 * generic language would pass. It catches the realistic case — someone adding `rules/betting/...`
 * because it was convenient — and it is not a proof that the boundary holds. Stated here rather than
 * implied, because a check that oversells itself is the failure this whole family of repositories
 * exists to prevent.
 *
 * Exit 0 clean, 1 violations found, 2 the check could not run.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Directories whose contents carry normative weight for the orchestrator.
 *
 * `registry/` is included with a carve-out below: an adapter MUST name its pack, so the pack name
 * itself is permitted there in the declared identity fields. What is not permitted anywhere is a
 * domain *concept* — an edge, a wager, a model, a proof.
 */
const NORMATIVE_DIRS = ["rules", "schemas", "registry"];

/**
 * Domain concepts owned by other repositories. Deliberately concepts rather than pack names: the
 * question is whether this repository has started reasoning about a subject, not whether it mentions
 * a neighbour.
 */
const DOMAIN_CONCEPTS = [
  // BettingStandards
  "wager", "bankroll", "kelly", "parlay", "sportsbook", "vig", "overround", "martingale",
  "closing line", "expected value", "edge",
  // MachineLearningStandards
  "overfit", "target leakage", "train/test", "hyperparameter", "feature importance", "model drift",
  // PredictionStandards
  "calibration", "brier", "base rate", "forecast horizon",
  // MathematicalStandards
  "theorem", "lemma", "proof obligation", "numerical proof",
  // FinancialStandards
  "portfolio return", "tax treatment", "amortisation", "amortization",
];

/** Fields in an adapter where naming the pack is the whole point. */
const IDENTITY_FIELDS = new Set(["pack", "repository", "ref", "binary", "entryPoint", "verdictCommand"]);

/**
 * Detectors are the one place domain vocabulary is unavoidable — describing what a signal looks like
 * is their entire function — so they live outside the normative directories. They are checked for the
 * opposite property instead: a detector must never name an outcome class. Detection produces evidence
 * about applicability and nothing else, and a detector that could reach a conclusion would be deciding
 * a domain matter under another name. This is the narrowest exception that lets detection exist at
 * all, rather than a hole in the boundary.
 */
const DETECTOR_DIR = "detectors";
const CONCLUSION_VOCABULARY = ["PASS", "FAIL", "BLOCKED", "INDETERMINATE", "UNRESOLVED", "CONFLICT", "COMPLIANT"];

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // A normative directory that does not exist yet is not a violation.
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/**
 * Strip the values of identity fields before scanning, so `"pack": "betting"` does not read as this
 * repository reasoning about betting. Everything else in the file is still scanned.
 */
function maskIdentityFields(text) {
  return text.replace(/"([a-zA-Z$]+)"\s*:\s*"([^"]*)"/g, (match, key) =>
    IDENTITY_FIELDS.has(key) ? `"${key}": ""` : match,
  );
}

export async function checkBoundary(root = ROOT) {
  const violations = [];

  for (const dir of NORMATIVE_DIRS) {
    for await (const file of walk(path.join(root, dir))) {
      const relative = path.relative(root, file).replace(/\\/g, "/");
      const raw = await readFile(file, "utf8");
      const haystack = maskIdentityFields(raw).toLowerCase();

      for (const concept of DOMAIN_CONCEPTS) {
        if (haystack.includes(concept)) {
          violations.push({ file: relative, concept });
        }
      }
    }
  }

  for await (const file of walk(path.join(root, DETECTOR_DIR))) {
    const relative = path.relative(root, file).replace(/\\/g, "/");
    const raw = await readFile(file, "utf8");
    for (const term of CONCLUSION_VOCABULARY) {
      // Word-boundary matched: a detector may say "confidence", it may not say "COMPLIANT".
      if (new RegExp(`\\b${term}\\b`).test(raw)) {
        violations.push({ file: relative, concept: term, kind: "detector-concludes" });
      }
    }
  }

  return violations;
}

function render(violations) {
  if (violations.length === 0) {
    return [
      "Authority boundary: clean.",
      "",
      "No domain concept appears in rules/, schemas/, or registry/ outside adapter identity fields,",
      "and no detector names an outcome class.",
      "",
      "This establishes that no domain vocabulary was found. It does NOT establish that the boundary",
      "holds — a domain rule phrased in generic language would pass this check. The boundary is",
      "ultimately maintained by review; this catches the realistic accident.",
      "",
    ].join("\n");
  }

  const out = ["Authority boundary: VIOLATED", ""];
  out.push("This repository composes standards authorities. It must not become one.");
  out.push("");
  for (const v of violations) {
    out.push(`  ${v.file}`);
    if (v.kind === "detector-concludes") {
      out.push(`      names the outcome class '${v.concept}'. Detectors produce evidence, never conclusions.`);
    } else {
      out.push(`      contains the domain concept '${v.concept}'`);
    }
  }
  out.push("");
  out.push("A normative requirement about a domain belongs to that domain's pack, which is the");
  out.push("authority on it. Move it there, or express the orchestrator's concern in terms of");
  out.push("adoption, resolution, applicability, ordering, execution, or aggregation instead.");
  out.push("");
  return out.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  let violations;
  try {
    violations = await checkBoundary();
  } catch (error) {
    process.stderr.write(`boundary: ${error.message}\n`);
    process.exit(2);
  }
  process.stdout.write(render(violations));
  process.exit(violations.length > 0 ? 1 : 0);
}
