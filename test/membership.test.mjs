/**
 * Historical portfolio membership.
 *
 * The case that matters: a repository leaves governance and the file that would have recorded it is
 * the same file that was edited to remove it. Without history, that audit goes green in the commit
 * that broke it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { historicalMembership, auditMembership } from "../scripts/membership.mjs";

/** A fake git over a map of commit SHA to that revision's portfolio.yml text. */
function fakeGit(revisions, { logFails = false, showFails = [] } = {}) {
  return (root, args) => {
    if (args[0] === "log") {
      if (logFails) return { ok: false, detail: "not a git repository" };
      return { ok: true, stdout: `${Object.keys(revisions).join("\n")}\n` };
    }
    const commit = args[1].split(":")[0];
    if (showFails.includes(commit)) return { ok: false, detail: "object not found" };
    return { ok: true, stdout: revisions[commit] ?? "" };
  };
}

const sha = (n) => String(n).repeat(40).slice(0, 40);
const listing = (...names) =>
  ["repositories:", ...names.flatMap((n) => [`  ${n}:`, `    repository: an-org/${n}`])].join("\n") + "\n";

test("membership is the union of every revision, not just the newest", async () => {
  const history = historicalMembership({
    git: fakeGit({ [sha(1)]: listing("Alpha"), [sha(2)]: listing("Alpha", "Beta") }),
  });

  assert.equal(history.status, "readable");
  assert.deepEqual([...history.everGoverned.keys()].sort(), ["Alpha", "Beta"]);
});

test("a repository that left with no retirement record is reported", async () => {
  const history = historicalMembership({ git: fakeGit({ [sha(1)]: listing("Alpha", "Beta") }) });
  const result = auditMembership({ repositories: { Alpha: {} }, retired: {} }, history);

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].repository, "Beta");
  assert.equal(result.findings[0].finding, "left-without-record");
});

test("a repository that left WITH a retirement record is clean", async () => {
  const history = historicalMembership({ git: fakeGit({ [sha(1)]: listing("Alpha", "Beta") }) });
  const result = auditMembership(
    {
      repositories: { Alpha: {} },
      retired: { Beta: { removedAt: "2026-08-10", rationale: "the repository was archived and no longer accepts merges" } },
    },
    history,
  );

  assert.deepEqual(result.findings, []);
});

test("a retirement with no rationale is a deletion with a label on it", async () => {
  const history = historicalMembership({ git: fakeGit({ [sha(1)]: listing("Alpha", "Beta") }) });
  const result = auditMembership(
    { repositories: { Alpha: {} }, retired: { Beta: { removedAt: "2026-08-10", rationale: "   " } } },
    history,
  );

  assert.equal(result.findings[0].finding, "retired-without-rationale");
});

test("a retirement record for something never governed is reported", async () => {
  const history = historicalMembership({ git: fakeGit({ [sha(1)]: listing("Alpha") }) });
  const result = auditMembership(
    { repositories: { Alpha: {} }, retired: { Ghost: { removedAt: "2026-08-10", rationale: "never existed" } } },
    history,
  );

  assert.equal(result.findings[0].finding, "retired-but-never-governed");
});

test("ADVERSARIAL: emptying the portfolio does not empty its history", async () => {
  // The whole point. Deleting every entry cannot make the audit forget what was governed, because the
  // evidence is in the commits, not in the file the commit rewrote.
  const history = historicalMembership({ git: fakeGit({ [sha(1)]: listing("Alpha", "Beta", "Gamma") }) });
  const result = auditMembership({ repositories: {}, retired: {} }, history);

  assert.deepEqual(result.findings.map((f) => f.repository).sort(), ["Alpha", "Beta", "Gamma"]);
});

test("an unreadable history is unevaluable, never clean", async () => {
  const history = historicalMembership({ git: fakeGit({}, { logFails: true }) });
  const result = auditMembership({ repositories: {}, retired: {} }, history);

  assert.equal(history.status, "unreadable");
  assert.equal(result.status, "unevaluable");
  assert.deepEqual(result.findings, [], "no findings, and no clean bill of health either");
});

test("an unparseable old revision is skipped rather than fatal, and is reported", async () => {
  // A revision predating the current schema is not evidence about membership today. Refusing to run
  // because of it would make the audit fragile in the direction of not running at all — but it is
  // still recorded, because a silently skipped revision is a silently forgotten member.
  const history = historicalMembership({
    git: fakeGit({ [sha(1)]: "repositories:\n\tAlpha: broken\n", [sha(2)]: listing("Beta") }),
  });

  assert.equal(history.status, "readable");
  assert.deepEqual([...history.everGoverned.keys()], ["Beta"]);
  assert.equal(history.unparseable.length, 1);
});

test("a revision git cannot show is skipped without failing the audit", async () => {
  const history = historicalMembership({
    git: fakeGit({ [sha(1)]: listing("Alpha"), [sha(2)]: listing("Beta") }, { showFails: [sha(1)] }),
  });

  assert.deepEqual([...history.everGoverned.keys()], ["Beta"]);
});

test("the real history of this repository is readable", async () => {
  // Against the actual repository, so the git plumbing is exercised rather than only the fake.
  const history = historicalMembership({});
  assert.equal(history.status, "readable");
});
