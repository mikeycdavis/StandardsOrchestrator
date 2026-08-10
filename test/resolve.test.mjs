/**
 * Tests for resolution.
 *
 * Most fixtures are real local git repositories rather than canned strings, so the tag semantics under
 * test are git's own: an annotated tag really does advertise two SHAs, a branch really is not a tag,
 * and a moved tag really moves. Only the failures that are awkward to provoke honestly — an
 * unreachable host, a malformed listing — use an injected git.
 *
 * One test reaches the real remotes. It is not skippable: a resolution suite that quietly passes when
 * the network is down would be asserting nothing at exactly the moment resolution matters.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resolveRelease,
  resolveRequirement,
  renderResolution,
  RESOLUTION_REASONS,
} from "../scripts/resolve.mjs";
import { loadRegistry } from "../scripts/registry.mjs";

const IDENTITY = [
  "-c", "user.email=fixture@example.invalid",
  "-c", "user.name=Fixture",
  "-c", "commit.gpgsign=false",
  "-c", "tag.gpgsign=false",
];

function git(cwd, ...args) {
  const result = spawnSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return (result.stdout ?? "").trim();
}

/** A throwaway repository with one commit per requested message, then whatever refs are asked for. */
async function makeRepo({ commits = ["one"], tags = [], branches = [] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "so-repo-"));
  git(dir, "init", "-q", "-b", "main");
  const shas = [];
  commits.forEach((message, index) => {
    writeFileSync(path.join(dir, "VERSION"), `${message}\n`, "utf8");
    // A per-commit file so two commits may carry identical VERSION content and still be distinct
    // objects — which is the situation the matching-VERSION test needs.
    writeFileSync(path.join(dir, `commit-${index}.txt`), `${index}\n`, "utf8");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", message);
    shas.push(git(dir, "rev-parse", "HEAD"));
  });
  for (const { name, at = "HEAD", annotated = true } of tags) {
    if (annotated) git(dir, "tag", "-a", name, at, "-m", `release ${name}`);
    else git(dir, "tag", name, at);
  }
  for (const { name, at = "HEAD" } of branches) git(dir, "branch", name, at);
  return { dir, shas };
}

const adapterFor = (repository, over = {}) => ({
  pack: "betting",
  version: "1.0.0",
  repository,
  ref: "v1.0.0",
  expectedCommit: "0".repeat(40),
  tagKind: "annotated",
  ...over,
});

const cleanup = [];
test.after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// The positive control: every term of the conjunction holds.
// ---------------------------------------------------------------------------------------------

test("RESOLVED: an annotated tag on the declared remote at the expected commit", async () => {
  const { dir, shas } = await makeRepo({ tags: [{ name: "v1.0.0" }] });
  cleanup.push(dir);

  const resolution = resolveRelease(adapterFor(dir, { expectedCommit: shas[0] }));
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.commit, shas[0]);
  assert.notEqual(resolution.tagObject, resolution.commit, "an annotated tag has two distinct SHAs");
});

test("resolution reports that it established identity and nothing more", async () => {
  // The distinction this whole module is built around: the ref existing says nothing about whether the
  // orchestrator understands that release's interface. That is the adapter's job.
  const { dir, shas } = await makeRepo({ tags: [{ name: "v1.0.0" }] });
  cleanup.push(dir);
  const resolution = resolveRelease(adapterFor(dir, { expectedCommit: shas[0] }));
  assert.match(resolution.establishes, /identity only/);
});

test("RESOLVED: a lightweight tag, when that is what the adapter declares", async () => {
  const { dir, shas } = await makeRepo({ tags: [{ name: "v1.0.0", annotated: false }] });
  cleanup.push(dir);

  const resolution = resolveRelease(adapterFor(dir, { expectedCommit: shas[0], tagKind: "lightweight" }));
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.commit, shas[0]);
  assert.equal(resolution.tagObject, shas[0], "a lightweight tag points straight at the commit");
});

// ---------------------------------------------------------------------------------------------
// Dereferencing.
// ---------------------------------------------------------------------------------------------

test("ADVERSARIAL: the tag-object SHA is never compared to the expected commit", async () => {
  // An annotated tag has two SHAs. Pinning the tag object would break on a re-annotation that changed
  // no code, and — worse — comparing the wrong one would let a moved tag pass whenever its tag object
  // happened to match.
  const { dir } = await makeRepo({ tags: [{ name: "v1.0.0" }] });
  cleanup.push(dir);
  const tagObject = git(dir, "rev-parse", "refs/tags/v1.0.0");
  const commit = git(dir, "rev-parse", "refs/tags/v1.0.0^{}");
  assert.notEqual(tagObject, commit, "the fixture must actually be annotated");

  const resolution = resolveRelease(adapterFor(dir, { expectedCommit: tagObject }));
  assert.equal(resolution.status, "unresolved");
  assert.equal(resolution.reasonCode, "COMMIT_MISMATCH");
  assert.equal(resolution.resolvedCommit, commit);
});

test("DEREFERENCE_MISSING: a tag whose kind is not what the adapter declared", async () => {
  const lightweight = await makeRepo({ tags: [{ name: "v1.0.0", annotated: false }] });
  const annotated = await makeRepo({ tags: [{ name: "v1.0.0" }] });
  cleanup.push(lightweight.dir, annotated.dir);

  // Declared annotated, found lightweight: nothing to dereference.
  const a = resolveRelease(adapterFor(lightweight.dir, { expectedCommit: lightweight.shas[0] }));
  assert.equal(a.reasonCode, "DEREFERENCE_MISSING");

  // Declared lightweight, found annotated: the released object is a tag object, not what was recorded.
  const b = resolveRelease(
    adapterFor(annotated.dir, { expectedCommit: annotated.shas[0], tagKind: "lightweight" }),
  );
  assert.equal(b.reasonCode, "DEREFERENCE_MISSING");
});

// ---------------------------------------------------------------------------------------------
// A branch is not a tag.
// ---------------------------------------------------------------------------------------------

test("ADVERSARIAL: a branch named v1.0.0 does not satisfy a tag pin", async () => {
  // A branch is mutable. It can be force-pushed after review, which is precisely the property pinning
  // exists to remove.
  const { dir, shas } = await makeRepo({ branches: [{ name: "v1.0.0" }] });
  cleanup.push(dir);

  const resolution = resolveRelease(adapterFor(dir, { expectedCommit: shas[0] }));
  assert.equal(resolution.status, "unresolved");
  assert.equal(resolution.reasonCode, "REF_NOT_TAG");
  assert.match(resolution.detail, /mutable/);
});

// ---------------------------------------------------------------------------------------------
// A moved tag.
// ---------------------------------------------------------------------------------------------

test("ADVERSARIAL: a tag resolving to the wrong commit is UNRESOLVED", async () => {
  const { dir, shas } = await makeRepo({ commits: ["one", "two"], tags: [{ name: "v1.0.0" }] });
  cleanup.push(dir);

  const resolution = resolveRelease(adapterFor(dir, { expectedCommit: shas[0] }));
  assert.equal(resolution.reasonCode, "COMMIT_MISMATCH");
  assert.equal(resolution.resolvedCommit, shas[1]);
  assert.equal(resolution.expectedCommit, shas[0]);
});

test("ADVERSARIAL: a matching VERSION at the wrong commit does not rescue a mismatch", async () => {
  // The repository's second commit writes the same VERSION content as the pinned one. Re-reading the
  // contents of the object whose identity is in question is not verification, so the mismatch stands.
  const { dir, shas } = await makeRepo({ commits: ["1.0.0", "1.0.0"], tags: [{ name: "v1.0.0" }] });
  cleanup.push(dir);
  assert.notEqual(shas[0], shas[1]);

  const resolution = resolveRelease(adapterFor(dir, { expectedCommit: shas[0] }));
  assert.equal(resolution.reasonCode, "COMMIT_MISMATCH");
});

// ---------------------------------------------------------------------------------------------
// No fallback, ever.
// ---------------------------------------------------------------------------------------------

test("ADVERSARIAL: never falls back to main, to another tag, or to the newest tag", async () => {
  const { dir, shas } = await makeRepo({
    commits: ["one", "two"],
    tags: [{ name: "v1.0.0", at: "HEAD~1" }, { name: "v1.1.0" }],
  });
  cleanup.push(dir);

  for (const [ref, expected] of [["v1.2.0", shas[1]], ["v0.9.0", shas[0]], ["main", shas[1]]]) {
    const resolution = resolveRelease(adapterFor(dir, { ref, expectedCommit: expected }));
    assert.equal(resolution.status, "unresolved", `${ref} must not resolve`);
    assert.equal(
      resolution.reasonCode,
      ref === "main" ? "REF_NOT_TAG" : "REF_NOT_FOUND",
      `${ref} must fail for the right reason`,
    );
  }
});

test("ADVERSARIAL: a locally available tag does not rescue a missing remote tag", async () => {
  // The authority being consumed is the declared REMOTE authority. A tag that exists only in someone's
  // clone is not something CI or a reviewer can obtain — which is the ML and Engineering case today.
  // The current working directory is moved into a repository that HAS the tag, to prove no local ref,
  // config, or repository context leaks into the answer.
  const withTag = await makeRepo({ tags: [{ name: "v1.0.0" }] });
  const withoutTag = await makeRepo({});
  cleanup.push(withTag.dir, withoutTag.dir);

  const original = process.cwd();
  try {
    process.chdir(withTag.dir);
    const resolution = resolveRelease(adapterFor(withoutTag.dir, { expectedCommit: withoutTag.shas[0] }));
    assert.equal(resolution.reasonCode, "REF_NOT_FOUND");
  } finally {
    process.chdir(original);
  }
});

// ---------------------------------------------------------------------------------------------
// Failures that establish nothing.
// ---------------------------------------------------------------------------------------------

test("REMOTE_UNAVAILABLE: network, authentication, and git failures establish nothing", async () => {
  // Reporting an unreachable host as REF_NOT_FOUND would send someone to re-tag a release that was
  // already tagged correctly.
  const missing = path.join(os.tmpdir(), "so-nonexistent-repo-fixture");
  const real = resolveRelease(adapterFor(missing));
  assert.equal(real.reasonCode, "REMOTE_UNAVAILABLE");
  assert.notEqual(real.reasonCode, "REF_NOT_FOUND");

  for (const detail of [
    "could not resolve host: github.com",
    "could not read Password for 'https://user@github.com': terminal prompts disabled",
    "remote: Repository not found.",
  ]) {
    // Authentication failure in particular must not read as REF_NOT_FOUND. A private authority we
    // cannot reach today is not a release that was never tagged, and even "Repository not found" from
    // a host that hides private repositories from unauthenticated callers establishes nothing.
    const injected = resolveRelease(adapterFor("https://example.invalid/x.git"), {
      git: () => ({ ok: false, detail }),
    });
    assert.equal(injected.reasonCode, "REMOTE_UNAVAILABLE", detail);
    assert.equal(injected.outcome, "UNRESOLVED");
  }
});

test("MALFORMED_REMOTE_RESPONSE: a listing is never partially interpreted", async () => {
  const cases = [
    ["a truncated sha", "abc\trefs/tags/v1.0.0\n"],
    ["a missing tab", "0000000000000000000000000000000000000000 refs/tags/v1.0.0\n"],
    ["trailing prose", `${"a".repeat(40)}\trefs/tags/v1.0.0\nWarning: redirecting\n`],
  ];
  for (const [label, stdout] of cases) {
    const resolution = resolveRelease(adapterFor("x"), { git: () => ({ ok: true, stdout }) });
    assert.equal(resolution.reasonCode, "MALFORMED_REMOTE_RESPONSE", label);
  }
});

test("MALFORMED_REMOTE_RESPONSE: a ref advertised twice with different SHAs", async () => {
  const stdout = `${"a".repeat(40)}\trefs/tags/v1.0.0\n${"b".repeat(40)}\trefs/tags/v1.0.0\n`;
  const resolution = resolveRelease(adapterFor("x"), { git: () => ({ ok: true, stdout }) });
  assert.equal(resolution.reasonCode, "MALFORMED_REMOTE_RESPONSE");
});

test("an empty listing is REF_NOT_FOUND, not a silent success", async () => {
  const resolution = resolveRelease(adapterFor("x"), { git: () => ({ ok: true, stdout: "" }) });
  assert.equal(resolution.reasonCode, "REF_NOT_FOUND");
});

test("PROPERTY: no remote listing at all yields a resolution without the expected commit", async () => {
  // Sweeps the shapes a remote can advertise. The only accepted one is the declared tag dereferencing
  // to the pinned commit; everything else is unresolved for a stated reason.
  const expected = "c".repeat(40);
  const other = "d".repeat(40);
  const listings = [
    "",
    `${other}\trefs/heads/v1.0.0\n`,
    `${other}\trefs/tags/v1.0.0\n`,
    `${other}\trefs/tags/v1.0.0\n${other}\trefs/tags/v1.0.0^{}\n`,
    `${other}\trefs/tags/v1.0.0\n${expected}\trefs/tags/v1.0.0^{}\n`,
    `${expected}\trefs/tags/v1.0.0\n`,
    `${expected}\trefs/tags/v1.0.0\n${other}\trefs/tags/v1.0.0^{}\n`,
  ];
  const accepted = [];
  for (const stdout of listings) {
    const resolution = resolveRelease(adapterFor("x", { expectedCommit: expected }), {
      git: () => ({ ok: true, stdout }),
    });
    if (resolution.status === "resolved") accepted.push(stdout);
    else assert.ok(resolution.reasonCode in RESOLUTION_REASONS, `${resolution.reasonCode} must be declared`);
  }
  assert.deepEqual(accepted, [`${other}\trefs/tags/v1.0.0\n${expected}\trefs/tags/v1.0.0^{}\n`]);
});

// ---------------------------------------------------------------------------------------------
// Registry lookup feeding resolution: three terminal shapes.
// ---------------------------------------------------------------------------------------------

test("UNSUPPORTED_RELEASE is UNRESOLVED and never reaches the network", async () => {
  const registry = await loadRegistry();
  let called = false;
  const resolution = resolveRequirement(registry, { pack: "prediction", version: "1.0.0" }, {
    git: () => {
      called = true;
      return { ok: true, stdout: "" };
    },
  });

  assert.equal(resolution.status, "unresolved");
  assert.equal(resolution.reasonCode, "UNSUPPORTED_RELEASE");
  assert.deepEqual(resolution.supportedVersions, ["1.1.0"]);
  assert.equal(called, false, "an unsupported release is settled before any remote is queried");
});

test("an unknown pack is a configuration error, not a verdict about anything", async () => {
  const registry = await loadRegistry();
  const resolution = resolveRequirement(registry, { pack: "predicton", version: "1.1.0" });
  assert.equal(resolution.status, "configuration-error");
  assert.equal(resolution.reasonCode, "UNKNOWN_PACK");
  assert.notEqual(resolution.outcome, "UNRESOLVED", "a broken manifest is not a failing standards run");
});

test("the shipped packs with no adapter are UNRESOLVED for the stated reason", async () => {
  const registry = await loadRegistry();
  for (const pack of ["ml", "engineering"]) {
    const resolution = resolveRequirement(registry, { pack, version: "1.4.0" });
    assert.equal(resolution.reasonCode, "UNSUPPORTED_RELEASE");
    assert.deepEqual(resolution.supportedVersions, []);
  }
});

test("every reason code carries a declared explanation", () => {
  for (const [code, text] of Object.entries(RESOLUTION_REASONS)) {
    assert.equal(typeof text, "string");
    assert.notEqual(text, "", code);
  }
});

test("rendering names the remedy rather than only the outcome", async () => {
  const registry = await loadRegistry();
  const line = renderResolution(resolveRequirement(registry, { pack: "prediction", version: "1.0.0" }));
  assert.match(line, /prediction@1\.0\.0: UNRESOLVED — UNSUPPORTED_RELEASE/);
});

// ---------------------------------------------------------------------------------------------
// The live portfolio.
// ---------------------------------------------------------------------------------------------

test("LIVE: the shipped adapters resolve against the real remotes", async () => {
  // Deliberately not skippable. A resolution suite that passes quietly when the network is down is
  // asserting nothing at the moment resolution matters most.
  const registry = await loadRegistry();

  const betting = resolveRequirement(registry, { pack: "betting", version: "1.0.0" });
  assert.equal(betting.status, "resolved", renderResolution(betting));
  assert.equal(betting.commit, "a4e7e680ca9213d6bf9f5042a3ae7fd7383b7545");

  const prediction = resolveRequirement(registry, { pack: "prediction", version: "1.1.0" });
  assert.equal(prediction.status, "resolved", renderResolution(prediction));
  assert.equal(prediction.commit, "ebe232bb52cd4b97b5ff3d53c52d6fd344fa3159");
});
