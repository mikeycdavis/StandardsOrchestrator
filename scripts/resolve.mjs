/**
 * Resolution: establishing that the requested authority exists and is exactly the object we expect.
 *
 * WHAT RESOLUTION ESTABLISHES, AND WHAT IT DOES NOT. Resolution establishes IDENTITY, not
 * compatibility. It proves that a named immutable ref exists on the declared remote and dereferences
 * to the expected commit. It says nothing about whether the orchestrator understands that release's
 * interface — that is what the existence of an adapter establishes, and the two must never substitute
 * for each other. An adapter without a resolvable ref is a contract for something we cannot obtain; a
 * resolvable ref without an adapter is code we could fetch and would not know how to read.
 *
 * The happy path is a conjunction, and every term is required:
 *
 *     known pack
 *     + an adapter for the exact version
 *     + the ref exists on the declared remote
 *     + it is a tag, of the declared kind, and dereferences correctly
 *     + the resolved commit equals the expected commit
 *     = RESOLVED
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: clone, fetch, or write anything to disk. `git ls-remote`
 * is sufficient to establish remote ref identity, and keeping acquisition separate means the
 * orchestrator can prove "we know exactly which authority should run" before "we downloaded and ran
 * it" — two claims worth being able to make independently.
 *
 * NEVER: fall back to `main`, to another tag, to a newer version, to "latest", or to a local ref. The
 * authority being consumed is the declared REMOTE authority. A tag sitting in someone's local clone
 * cannot rescue a tag that was never pushed, because the tag that was never pushed is not something CI
 * or a reviewer can obtain. This is the ML and Engineering case today, and it stays a failure.
 */

import { spawnSync } from "node:child_process";
import os from "node:os";
import { resolveAdapter } from "./registry.mjs";

/**
 * Why resolution failed, kept more precise than the outcome class.
 *
 * The outcome algebra only needs to know this is `UNRESOLVED`. A person needs to know which of these
 * it was, because the remedy differs completely — push a tag, fix a typo, investigate a moved tag,
 * retry a network call, derive an adapter. Keeping the detail here rather than in the algebra is what
 * stops operational specifics leaking into the aggregation rules.
 */
export const RESOLUTION_REASONS = Object.freeze({
  REMOTE_UNAVAILABLE: "the remote could not be queried, so nothing was established either way",
  REF_NOT_FOUND: "the remote has no such ref",
  REF_NOT_TAG: "a ref of that name exists, but it is not a tag",
  DEREFERENCE_MISSING: "the tag did not dereference as its declared kind requires",
  COMMIT_MISMATCH: "the tag resolved to a different commit than the adapter pins",
  MALFORMED_REMOTE_RESPONSE: "the remote listing could not be parsed in full",
  UNSUPPORTED_RELEASE: "no adapter establishes how to compose that release",
});

/** Configuration faults. These are the orchestrator's own inputs being wrong, not a pack failing. */
export const CONFIGURATION_REASONS = Object.freeze({
  UNKNOWN_PACK: "the manifest names a standards authority this registry does not know",
});

const SHA = /^[0-9a-f]{40}$/;
const LS_REMOTE_LINE = /^([0-9a-f]{40})\t(\S+)$/;

/**
 * Query a remote's refs.
 *
 * Runs outside any repository, so no local clone's refs or remotes can influence the answer — the
 * question is strictly what the declared remote advertises. The ambient credential helper IS left
 * intact: a private authority still has to be reachable, and reaching it is not the same as letting a
 * local ref stand in for a remote one. Interactive prompts are disabled so a missing credential fails
 * closed as REMOTE_UNAVAILABLE rather than hanging a CI job forever.
 */
export function runGit(repository, patterns) {
  const result = spawnSync("git", ["ls-remote", repository, ...patterns], {
    cwd: os.tmpdir(),
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
  });
  if (result.error) return { ok: false, detail: result.error.message };
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim().split("\n").slice(0, 3).join("; ");
    return { ok: false, detail: stderr || `git exited ${result.status}` };
  }
  return { ok: true, stdout: result.stdout ?? "" };
}

function unresolved(adapter, reasonCode, detail, extra = {}) {
  return {
    status: "unresolved",
    outcome: "UNRESOLVED",
    pack: adapter.pack,
    version: adapter.version,
    ref: adapter.ref,
    repository: adapter.repository,
    reasonCode,
    reason: RESOLUTION_REASONS[reasonCode],
    detail,
    ...extra,
  };
}

/**
 * Establish that one adapter's pinned release exists and is the expected object.
 *
 * `git` is injectable so the failure modes that are awkward to provoke — a malformed listing, an
 * unreachable host — are testable without depending on the state of the internet.
 */
export function resolveRelease(adapter, { git = runGit } = {}) {
  const tagRef = `refs/tags/${adapter.ref}`;
  const peeledRef = `${tagRef}^{}`;
  const headRef = `refs/heads/${adapter.ref}`;

  const result = git(adapter.repository, [tagRef, peeledRef, headRef]);

  // A failure to reach the remote establishes nothing. It is emphatically not evidence that the
  // release does not exist, and reporting it as REF_NOT_FOUND would send someone to re-tag a release
  // that was already tagged correctly.
  if (!result.ok) {
    return unresolved(adapter, "REMOTE_UNAVAILABLE", result.detail);
  }

  const refs = new Map();
  for (const line of result.stdout.split("\n")) {
    if (line.trim() === "") continue;
    const match = LS_REMOTE_LINE.exec(line.replace(/\r$/, ""));
    if (match === null) {
      // Partially interpreting a listing we do not fully understand is how a wrong SHA gets accepted.
      return unresolved(adapter, "MALFORMED_REMOTE_RESPONSE", `unparseable line: ${JSON.stringify(line)}`);
    }
    if (refs.has(match[2])) {
      return unresolved(adapter, "MALFORMED_REMOTE_RESPONSE", `the remote listed ${match[2]} twice`);
    }
    refs.set(match[2], match[1]);
  }

  const tagSha = refs.get(tagRef);
  if (tagSha === undefined) {
    // A branch named v1.0.0 is a mutable ref. It can be force-pushed after review, which is the exact
    // property pinning exists to remove, so it never satisfies a tag pin.
    if (refs.has(headRef)) {
      return unresolved(
        adapter,
        "REF_NOT_TAG",
        `${adapter.repository} has a branch named '${adapter.ref}' but no tag of that name; a branch is ` +
          `mutable and cannot serve as an immutable pin`,
      );
    }
    return unresolved(
      adapter,
      "REF_NOT_FOUND",
      `${adapter.repository} advertises no ${tagRef}. The release may never have been tagged, or the ` +
        `tag may exist only in a local clone, which is not an authority anyone else can obtain.`,
    );
  }

  const peeled = refs.get(peeledRef);

  // The declared kind decides what a correct listing looks like. An annotated tag advertises both the
  // tag object and its peeled commit; a lightweight tag advertises only the commit. A tag that changed
  // kind between releases changed the released object, and absorbing that silently would defeat the
  // point of recording an expected commit at all.
  if (adapter.tagKind === "annotated" && peeled === undefined) {
    return unresolved(
      adapter,
      "DEREFERENCE_MISSING",
      `the adapter declares an annotated tag, but the remote advertised no ${peeledRef}`,
      { tagObject: tagSha },
    );
  }
  if (adapter.tagKind === "lightweight" && peeled !== undefined) {
    return unresolved(
      adapter,
      "DEREFERENCE_MISSING",
      `the adapter declares a lightweight tag, but the remote advertised ${peeledRef}, so the tag is ` +
        `annotated and the released object is not what was recorded`,
      { tagObject: tagSha, dereferenced: peeled },
    );
  }

  // The commit, never the tag object. An annotated tag has two SHAs and only one of them is the code.
  const commit = adapter.tagKind === "annotated" ? peeled : tagSha;
  if (!SHA.test(commit)) {
    return unresolved(adapter, "MALFORMED_REMOTE_RESPONSE", `'${commit}' is not a commit identifier`);
  }

  if (commit !== adapter.expectedCommit) {
    // Deliberately no second look. Whether that commit happens to contain a matching VERSION file, or
    // even identical content, is irrelevant: the pin names an object, the remote offers a different
    // one, and the difference is the finding. Verifying identity by re-reading the contents of the
    // thing whose identity is in question is not verification.
    return unresolved(
      adapter,
      "COMMIT_MISMATCH",
      `${tagRef} resolves to ${commit} but the adapter pins ${adapter.expectedCommit}. The tag has ` +
        `moved, or the adapter is stale. Either way the reviewed commit is not the one that would run.`,
      { resolvedCommit: commit, expectedCommit: adapter.expectedCommit, tagObject: tagSha },
    );
  }

  return {
    status: "resolved",
    outcome: null,
    pack: adapter.pack,
    version: adapter.version,
    ref: adapter.ref,
    repository: adapter.repository,
    tagKind: adapter.tagKind,
    tagObject: tagSha,
    commit,
    establishes: "identity only; that this release's interface is understood is established by its adapter",
  };
}

/**
 * Resolve one manifest requirement: registry lookup, then release identity.
 *
 * Three terminal shapes, kept distinct:
 *   - `resolved`             — every term of the conjunction held.
 *   - `unresolved`           — an outcome class; the gate fails and the reasonCode says what to fix.
 *   - `configuration-error`  — the orchestrator's own inputs are wrong. Not a verdict about any
 *                              project, and never reported as one.
 */
export function resolveRequirement(registry, { pack, version }, options = {}) {
  const found = resolveAdapter(registry, pack, version);

  if (found.status === "unknown-pack") {
    return {
      status: "configuration-error",
      outcome: null,
      pack,
      version,
      reasonCode: "UNKNOWN_PACK",
      reason: CONFIGURATION_REASONS.UNKNOWN_PACK,
      detail: `${found.detail} (known: ${found.knownPacks.join(", ")})`,
    };
  }

  if (found.status === "unsupported-release") {
    return {
      status: "unresolved",
      outcome: "UNRESOLVED",
      pack,
      version,
      reasonCode: "UNSUPPORTED_RELEASE",
      reason: RESOLUTION_REASONS.UNSUPPORTED_RELEASE,
      detail: found.detail,
      supportedVersions: found.supportedVersions,
    };
  }

  return { ...resolveRelease(found.adapter, options), adapter: found.adapter, interpreter: found.interpreter };
}

/** One line per requirement, phrased so the remedy is legible without reading the JSON. */
export function renderResolution(resolution) {
  const id = `${resolution.pack}@${resolution.version}`;
  if (resolution.status === "resolved") return `${id}: resolved ${resolution.commit.slice(0, 7)} OK`;
  const label = resolution.status === "configuration-error" ? "CONFIGURATION ERROR" : "UNRESOLVED";
  return `${id}: ${label} — ${resolution.reasonCode}: ${resolution.detail}`;
}
