/**
 * Running detectors over a project tree.
 *
 * Detection produces evidence and a state, never a decision. The three states mean exactly what they
 * say:
 *
 *   DETECTED       — at least one affirmative signal was found, and every one is reported with the
 *                    file and line that produced it so a reader can check it.
 *   NOT_DETECTED   — the detectors ran over readable files and matched nothing. This is a statement
 *                    about the detectors, not about the project.
 *   INDETERMINATE  — the detectors could not look. An unreadable tree, or no file of a kind any
 *                    detector knows how to read. Reporting that as NOT_DETECTED would convert a
 *                    failure to look into a finding of absence.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Directories that are never a project's own work. */
const SKIP = new Set([".git", "node_modules", "dist", "build", "out", "vendor", "__pycache__", ".venv"]);

/** Files are read only up to this size; a signal is a line of source, not a data dump. */
const MAX_BYTES = 2_000_000;

export async function loadDetectors(root = ROOT) {
  const dir = path.join(root, "detectors");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".mjs")).sort();
  const detectors = new Map();
  for (const file of files) {
    const module = await import(pathToFileURL(path.join(dir, file)).href);
    if (typeof module.pack !== "string" || !Array.isArray(module.signals)) {
      throw new Error(`detectors/${file} does not declare a pack and its signals`);
    }
    for (const signal of module.signals) {
      for (const field of ["id", "basis", "confidence", "extensions", "pattern"]) {
        if (signal[field] === undefined) {
          throw new Error(`detectors/${file}: signal '${signal.id ?? "?"}' declares no ${field}`);
        }
      }
    }
    detectors.set(module.pack, module);
  }
  return detectors;
}

async function* walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/**
 * Run every detector over one project tree.
 *
 * Returns a Map of pack to { detection, evidence }. Every evidence entry names the detector, the
 * signal, the exact location, the basis for treating it as a signal, and a qualitative confidence —
 * everything a reviewer needs to disagree, which is the point of collecting it.
 */
export async function detect(projectRoot, detectors) {
  const results = new Map();
  for (const pack of detectors.keys()) results.set(pack, { detection: "NOT_DETECTED", evidence: [] });

  let inspected = 0;
  let unreadable = 0;
  let files;
  try {
    files = [];
    for await (const file of walk(projectRoot)) files.push(file);
  } catch (error) {
    // The tree could not be walked at all. Nothing was established either way.
    for (const pack of detectors.keys()) {
      results.set(pack, {
        detection: "INDETERMINATE",
        evidence: [],
        note: `the project tree could not be read: ${error.message}`,
      });
    }
    return results;
  }

  for (const file of files) {
    const extension = path.extname(file).toLowerCase();
    const interested = [...detectors.values()].filter((d) =>
      d.signals.some((s) => s.extensions.includes(extension)),
    );
    if (interested.length === 0) continue;

    let text;
    try {
      text = await readFile(file, "utf8");
    } catch {
      unreadable += 1;
      continue;
    }
    if (text.length > MAX_BYTES) continue;
    inspected += 1;

    const lines = text.split(/\r?\n/);
    for (const detector of interested) {
      for (const signal of detector.signals) {
        if (!signal.extensions.includes(extension)) continue;
        const relative = path.relative(projectRoot, file).replace(/\\/g, "/");
        let first = null;
        let occurrences = 0;
        lines.forEach((line, index) => {
          if (!signal.pattern.test(line)) return;
          occurrences += 1;
          if (first !== null) return;
          first = {
            detector: `detectors/${detector.pack}.mjs`,
            signal: signal.id,
            location: `${relative}:${index + 1}`,
            basis: signal.basis,
            confidence: signal.confidence,
            matched: line.trim().slice(0, 200),
          };
        });
        if (first === null) continue;
        const entry = results.get(detector.pack);
        entry.detection = "DETECTED";
        // One entry per (signal, file), carrying how many times it matched. A reviewer needs to know
        // where to look, not to read the same line forty times — but the count is reported rather
        // than dropped, because a silently collapsed set reads as a smaller finding than it is.
        entry.evidence.push({ ...first, occurrences });
      }
    }
  }

  // No file of a kind any detector can read means the detectors never looked at anything. That is not
  // the same as looking and finding nothing, and collapsing the two would let an unfamiliar stack read
  // as an affirmative absence of signals.
  if (inspected === 0) {
    for (const [pack, entry] of results) {
      if (entry.detection === "NOT_DETECTED") {
        results.set(pack, {
          detection: "INDETERMINATE",
          evidence: [],
          note:
            unreadable > 0
              ? `no readable file of a kind any detector understands (${unreadable} unreadable)`
              : "no file of a kind any detector understands",
        });
      }
    }
  }

  return results;
}
