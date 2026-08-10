/**
 * Historical portfolio membership, read from this repository's own git history.
 *
 * THE PROBLEM. A repository can leave governance by being deleted from `portfolio.yml`. Nothing in
 * the resulting file records that it was ever there, so an audit that reads only the current file
 * reports a clean portfolio — the enforcement disappeared and the audit went green in the same
 * commit. Absence must not silently mean "no longer governed".
 *
 * THE MECHANISM. Every commit that touched `portfolio.yml` is read, and the union of every
 * repository ever listed is the historical membership. A name in that union which is neither
 * currently governed nor explicitly retired is a governance change that happened without a record.
 *
 * WHAT THIS IS NOT. It is not an approval mechanism. It does not know whether a removal was
 * authorised, because nothing inside these repositories can know that — validating approval needs an
 * external authority this project does not have, and inventing one would produce a rubber stamp that
 * looks like governance. What it does is make the removal state its reasons in the same commit that
 * performs it, and make a silent removal impossible to distinguish from a loud one only by looking.
 *
 * THE HONEST LIMIT. Someone who edits the adopting repository, edits the portfolio, and writes a
 * retirement record has removed a repository from governance legitimately as far as this audit can
 * tell. Someone who rewrites this repository's history has removed the evidence entirely. Both are
 * outside the surface this can inspect. The claim is that a removal leaves a trace, not that a
 * removal cannot happen.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./yaml.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class MembershipError extends Error {
  constructor(message) {
    super(message);
    this.name = "MembershipError";
  }
}

/** Run git in this repository. Injectable so tests need no fixture history on disk. */
export function runGit(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 });
  if (result.error) return { ok: false, detail: result.error.message };
  if (result.status !== 0) return { ok: false, detail: (result.stderr || "").trim() || `git exited ${result.status}` };
  return { ok: true, stdout: result.stdout };
}

/**
 * Every repository name that has ever appeared under `repositories:` in `portfolio.yml`.
 *
 * A commit whose `portfolio.yml` cannot be parsed is skipped rather than fatal — an older revision
 * predating the current schema is not evidence about membership today, and refusing to run because of
 * it would make the audit fragile in the direction of not running at all. A failure to read the
 * history itself is different, and is reported as unreadable.
 */
export function historicalMembership({ root = ROOT, git = runGit, file = "portfolio.yml" } = {}) {
  const log = git(root, ["log", "--format=%H", "--", file]);
  if (!log.ok) {
    return { status: "unreadable", detail: `the history of ${file} could not be read: ${log.detail}` };
  }

  const commits = log.stdout.split(/\r?\n/).filter((line) => /^[0-9a-f]{40}$/.test(line.trim()));
  const everGoverned = new Map();
  const unparseable = [];

  for (const commit of commits) {
    const show = git(root, ["show", `${commit}:${file}`]);
    if (!show.ok) continue;
    let document;
    try {
      document = parseYaml(show.stdout);
    } catch (error) {
      unparseable.push({ commit, detail: error.message });
      continue;
    }
    const repositories = document?.repositories;
    if (repositories === null || typeof repositories !== "object") continue;
    for (const [name, entry] of Object.entries(repositories)) {
      // First sighting wins, so the recorded identity is the one governance began under.
      if (!everGoverned.has(name)) everGoverned.set(name, { name, firstSeen: commit, repository: entry?.repository });
    }
  }

  return { status: "readable", commits: commits.length, everGoverned, unparseable };
}

/**
 * Compare historical membership against the current file.
 *
 * Returns one finding per repository that left governance without a retirement record. A retirement
 * record must carry a rationale: "removed" is not a reason, and a field that may be empty is a field
 * that will be.
 */
export function auditMembership(document, history) {
  if (history.status !== "readable") {
    return { status: "unevaluable", detail: history.detail, findings: [] };
  }

  const current = new Set(Object.keys(document?.repositories ?? {}));
  const retired = document?.retired ?? {};
  const findings = [];

  for (const [name, record] of history.everGoverned) {
    if (current.has(name)) continue;
    const retirement = retired?.[name];
    if (retirement === undefined) {
      findings.push({
        repository: name,
        finding: "left-without-record",
        detail:
          `${name} was governed as of ${record.firstSeen.slice(0, 7)} and is no longer listed, with no ` +
          `entry under 'retired'. Removing a repository from governance is itself a governance change; ` +
          `record why, or restore it.`,
      });
      continue;
    }
    if (typeof retirement.rationale !== "string" || retirement.rationale.trim().length === 0) {
      findings.push({
        repository: name,
        finding: "retired-without-rationale",
        detail: `${name} is retired but records no rationale. A retirement with no reason is a deletion with a label on it.`,
      });
    }
  }

  // A retirement record for something never governed is not a failure, but it is a claim about
  // history that history does not support, and it should not sit in the file unchallenged.
  for (const name of Object.keys(retired)) {
    if (!history.everGoverned.has(name) && !current.has(name)) {
      findings.push({
        repository: name,
        finding: "retired-but-never-governed",
        detail: `${name} is recorded as retired, but no commit of this file ever governed it.`,
      });
    }
  }

  return { status: "evaluated", findings };
}
