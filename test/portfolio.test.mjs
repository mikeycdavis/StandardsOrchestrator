/**
 * The portfolio governance audit.
 *
 * The fixture is a fully governed repository, and every test mutates one thing about it. The API
 * response shapes are not invented — they were captured from live GitHub on 2026-08-10 and are kept
 * verbatim in test/fixtures/github/, including the two that matter most: a ruleset-governed branch
 * whose classic protection endpoint returns 404, and a plan-limited repository whose governance
 * endpoints return 403.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditPortfolio, loadPortfolio, producedCheckName, calledJobName } from "../scripts/portfolio.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = path.join(ROOT, "test", "fixtures", "github");

const captured = async (name) => JSON.parse(await readFile(path.join(FIXTURES, name), "utf8"));

// Captured verbatim from live GitHub. See design/governance-surfaces.md.
const RULES_GOVERNED = await captured("rules-ruleset-governed.json");
const RULES_UNGOVERNED = await captured("rules-ungoverned.json");
const RULES_FORBIDDEN = await captured("rules-plan-forbidden.json");
const CLASSIC_404 = await captured("classic-404-under-ruleset.json");

const CHECK = "Standards / gate";
const REPO = "an-org/Governed";

const CALLER = [
  "on:",
  "  pull_request:",
  "  push:",
  "    branches:",
  "      - main",
  "jobs:",
  "  standards:",
  "    name: Standards",
  "    uses: an-org/StandardsOrchestrator/.github/workflows/validate.yml@0123456789abcdef0123456789abcdef01234567",
  "",
].join("\n");

const DOCUMENT = {
  repositories: {
    Governed: {
      repository: REPO,
      enforcement: {
        workflow: ".github/workflows/standards.yml",
        reusableWorkflow: ".github/workflows/validate.yml",
        checkName: CHECK,
        protectedBranches: ["main"],
        requiredChecks: [CHECK],
      },
    },
  },
  retired: {},
};

/** Required checks in the captured ruleset shape, with our own context substituted. */
function rulesRequiring(...contexts) {
  const [rule] = RULES_GOVERNED;
  return [
    {
      ...rule,
      parameters: { ...rule.parameters, required_status_checks: contexts.map((context) => ({ context, integration_id: 15368 })) },
    },
  ];
}

/** A fake client over an exact route table. An unlisted route is a 404, never a silent success. */
function client(routes) {
  return {
    hasToken: true,
    async get(route) {
      const entry = routes[route];
      if (entry === undefined) return { status: 404, ok: false, body: { message: "Not Found" }, error: "Not Found" };
      if (typeof entry === "function") return entry();
      return entry;
    },
  };
}

const ok = (body) => ({ status: 200, ok: true, body });
const forbidden = () => ({ status: 403, ok: false, body: RULES_FORBIDDEN, error: RULES_FORBIDDEN.message });
const notProtected = () => ({ status: 404, ok: false, body: CLASSIC_404, error: CLASSIC_404.message });
const contents = (text) => ok({ content: Buffer.from(text, "utf8").toString("base64"), sha: "a".repeat(40) });

/** The fully governed baseline. Overrides replace individual routes. */
function governed(overrides = {}) {
  return client({
    [`/repos/${REPO}`]: ok({ full_name: REPO, archived: false, default_branch: "main", private: false }),
    [`/repos/${REPO}/contents/.github/workflows/standards.yml`]: contents(CALLER),
    [`/repos/${REPO}/branches/main/protection`]: notProtected(),
    [`/repos/${REPO}/rules/branches/main`]: ok(rulesRequiring(CHECK)),
    [`/repos/${REPO}/rulesets/20644315`]: ok({ name: "governance", bypass_actors: [] }),
    ...overrides,
  });
}

/** No history: membership is trivially satisfied, so these tests isolate the enforcement claims. */
const noHistory = () => ({ ok: true, stdout: "" });

const audit = (routes, document = DOCUMENT, git = noHistory) =>
  auditPortfolio({ client: governed(routes), document, git, calledName: "gate", generatedAt: "2026-08-10T00:00:00Z" });

// --- the baseline ---------------------------------------------------------------------------------

test("a fully governed repository passes", async () => {
  const report = await audit();
  assert.equal(report.outcome, "PASS");
  assert.deepEqual(report.repositories[0].repositoryEvidence, []);
  assert.deepEqual(report.repositories[0].platformEvidence, []);
});

test("the shipped portfolio.yml satisfies its schema, and the check identity resolves", async () => {
  const document = await loadPortfolio(ROOT);
  assert.ok(Object.keys(document.repositories).length > 0);
  assert.equal(await calledJobName(ROOT), "gate");
});

// --- the seven acceptance mutations ----------------------------------------------------------------

test("MUTATION 1: the caller is deleted", async () => {
  const report = await audit({ [`/repos/${REPO}/contents/.github/workflows/standards.yml`]: undefined });
  assert.equal(report.outcome, "FAIL");
  assert.equal(report.repositories[0].repositoryEvidence[0].finding, "caller-absent");
});

test("MUTATION 2: the orchestrator is unpinned", async () => {
  const unpinned = CALLER.replace("@0123456789abcdef0123456789abcdef01234567", "@main");
  const report = await audit({ [`/repos/${REPO}/contents/.github/workflows/standards.yml`]: contents(unpinned) });
  assert.equal(report.outcome, "FAIL");
  assert.match(report.repositories[0].repositoryEvidence[0].detail, /not a 40-character commit SHA/);
});

test("MUTATION 3: a suppressing condition is added", async () => {
  const filtered = CALLER.replace("  pull_request:\n", "  pull_request:\n    paths:\n      - src/**\n");
  const report = await audit({ [`/repos/${REPO}/contents/.github/workflows/standards.yml`]: contents(filtered) });
  assert.equal(report.outcome, "FAIL");
  assert.match(report.repositories[0].repositoryEvidence[0].detail, /sits pending/);
});

test("MUTATION 4: the required check is removed from the branch", async () => {
  // The workflow file is untouched and perfect. The platform simply no longer requires it.
  const report = await audit({ [`/repos/${REPO}/rules/branches/main`]: ok(rulesRequiring("Build", "Test")) });
  assert.equal(report.outcome, "FAIL");
  assert.deepEqual(report.repositories[0].repositoryEvidence, [], "repository evidence is still clean");
  const finding = report.repositories[0].platformEvidence.find((f) => f.finding === "required-check-missing");
  assert.match(finding.detail, /The claim is stale/);
});

test("MUTATION 5: the caller renames its job, so the required identity is never produced", async () => {
  // Fails closed on GitHub — nothing ever reports that name — but a permanently pending required check
  // is a broken enforcement system, not a working one.
  const renamed = CALLER.replace("    name: Standards\n", "    name: Compliance\n");
  const report = await audit({ [`/repos/${REPO}/contents/.github/workflows/standards.yml`]: contents(renamed) });
  assert.equal(report.outcome, "FAIL");
  const finding = report.repositories[0].repositoryEvidence.find((f) => f.finding === "identity-drift");
  assert.match(finding.detail, /Compliance \/ gate/);
  assert.equal(report.repositories[0].producedCheckName, "Compliance / gate");
});

test("MUTATION 6: a governed repository is removed with no retirement record", async () => {
  // History says Governed was in the portfolio. The current document does not list it, and does not
  // retire it either. The enforcement and the audit's knowledge of it disappeared in one commit.
  const history = (root, args) =>
    args[0] === "log"
      ? { ok: true, stdout: `${"c".repeat(40)}\n` }
      : { ok: true, stdout: "repositories:\n  Governed:\n    repository: an-org/Governed\n" };
  const report = await auditPortfolio({
    client: governed(),
    document: { repositories: {}, retired: {} },
    git: history,
    calledName: "gate",
  });

  assert.notEqual(report.outcome, "PASS");
  assert.equal(report.membership.findings[0].finding, "left-without-record");
});

test("MUTATION 7: governance becomes unreadable — indeterminate, never green", async () => {
  const report = await audit({
    [`/repos/${REPO}/branches/main/protection`]: forbidden(),
    [`/repos/${REPO}/rules/branches/main`]: forbidden(),
  });

  // The overall gate stays FAIL: the algebra returns INDETERMINATE only for an empty set, and a
  // per-subject INDETERMINATE is a non-pass like any other. The distinction is preserved where it is
  // actionable — on the repository itself — exactly as it is in the compliance report.
  assert.notEqual(report.outcome, "PASS");
  assert.equal(report.repositories[0].class, "INDETERMINATE");
  const finding = report.repositories[0].platformEvidence[0];
  assert.equal(finding.finding, "governance-unreadable");
  assert.equal(finding.unevaluable, true);
  assert.match(finding.detail, /not evidence of protection/);
});

// --- the mechanism distinction ---------------------------------------------------------------------

test("a ruleset-governed branch is not reported unprotected because classic protection 404s", async () => {
  // The confident false negative this audit exists to avoid. The baseline fixture IS this case: the
  // classic endpoint returns the captured 404 and the branch is governed entirely by a ruleset.
  const report = await audit();
  assert.equal(report.outcome, "PASS");
  assert.equal(report.repositories[0].branches[0].classic.governed, false);
  assert.equal(report.repositories[0].branches[0].rulesets.governed, true);
  assert.equal(report.repositories[0].branches[0].governed, true);
});

test("a branch governed by neither mechanism is a definite failure, not an unevaluable one", async () => {
  const report = await audit({ [`/repos/${REPO}/rules/branches/main`]: ok(RULES_UNGOVERNED) });
  assert.equal(report.outcome, "FAIL");
  const findings = report.repositories[0].platformEvidence.map((f) => f.finding);
  assert.ok(findings.includes("branch-unprotected"));
  assert.ok(report.repositories[0].platformEvidence.every((f) => f.unevaluable !== true));
});

test("an unreadable mechanism cannot establish that a check is absent", async () => {
  // Classic protection is readable and governs the branch, requiring only "Build". Rulesets are
  // unreadable. The standards check is not among the checks we can see — but a ruleset we cannot read
  // may well require it, so its absence is not established and must not be asserted.
  const report = await audit({
    [`/repos/${REPO}/branches/main/protection`]: ok({ required_status_checks: { checks: [{ context: "Build" }] } }),
    [`/repos/${REPO}/rules/branches/main`]: forbidden(),
  });
  assert.equal(report.repositories[0].class, "INDETERMINATE");
  assert.notEqual(report.outcome, "PASS");
  const findings = report.repositories[0].platformEvidence.map((f) => f.finding);
  assert.ok(findings.includes("required-check-unevaluable"));
  assert.equal(findings.includes("required-check-missing"), false);
});

test("presence is still concludable when the readable mechanism has the check", async () => {
  // Classic unreadable, rulesets readable and requiring the check. Absence would be unprovable here,
  // but presence is not: one authority affirmatively says it is required.
  const report = await audit({ [`/repos/${REPO}/branches/main/protection`]: forbidden() });
  assert.equal(report.outcome, "PASS");
});

// --- bypass, identity, and the missing subject -------------------------------------------------------

test("a configured bypass actor is a weakening and fails the audit", async () => {
  const report = await audit({
    [`/repos/${REPO}/rulesets/20644315`]: ok({
      name: "governance",
      bypass_actors: [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" }],
    }),
  });
  assert.equal(report.outcome, "FAIL");
  assert.match(report.repositories[0].platformEvidence[0].detail, /the check is not required/);
});

test("unreadable bypass configuration is unevaluable, not absent", async () => {
  const report = await audit({ [`/repos/${REPO}/rulesets/20644315`]: forbidden() });
  assert.equal(report.repositories[0].class, "INDETERMINATE");
  assert.notEqual(report.outcome, "PASS");
  assert.equal(report.repositories[0].platformEvidence[0].finding, "bypass-unevaluable");
});

test("a governed repository that no longer exists is UNRESOLVED, not a clean audit", async () => {
  const report = await audit({ [`/repos/${REPO}`]: undefined });
  assert.equal(report.repositories[0].class, "UNRESOLVED");
  assert.notEqual(report.outcome, "PASS");
});

test("a renamed repository is UNRESOLVED — governance under a name it no longer has", async () => {
  const report = await audit({
    [`/repos/${REPO}`]: ok({ full_name: "an-org/Renamed", archived: false, default_branch: "main", private: false }),
  });
  assert.equal(report.repositories[0].class, "UNRESOLVED");
});

test("an archived repository is reported: its configuration can no longer be corrected", async () => {
  const report = await audit({
    [`/repos/${REPO}`]: ok({ full_name: REPO, archived: true, default_branch: "main", private: false }),
  });
  assert.equal(report.outcome, "FAIL");
  assert.ok(report.repositories[0].platformEvidence.some((f) => f.finding === "repository-archived"));
});

test("a caller invoking a different reusable workflow is reported", async () => {
  const other = CALLER.replace("/.github/workflows/validate.yml@", "/.github/workflows/other.yml@");
  const report = await audit({ [`/repos/${REPO}/contents/.github/workflows/standards.yml`]: contents(other) });
  assert.equal(report.outcome, "FAIL");
  assert.ok(report.repositories[0].repositoryEvidence.some((f) => f.finding === "wrong-reusable-workflow"));
});

// --- the empty portfolio ----------------------------------------------------------------------------

test("ADVERSARIAL: a portfolio governing nothing is INDETERMINATE, not a clean bill of health", async () => {
  // M1's empty-set protection reaching the governance layer, for free, because the audit reuses the
  // same algebra rather than growing a second definition of green.
  const report = await auditPortfolio({
    client: governed(),
    document: { repositories: {}, retired: {} },
    git: noHistory,
    calledName: "gate",
  });
  assert.equal(report.outcome, "INDETERMINATE");
  assert.match(report.reasons.at(-1).reason, /Nothing examined is not a pass/);
});

// --- check identity ---------------------------------------------------------------------------------

test("the produced check identity is the caller's job name and the called job name", () => {
  assert.equal(producedCheckName(CALLER, "gate"), "Standards / gate");
  assert.equal(producedCheckName(CALLER.replace("    name: Standards\n", ""), "gate"), "standards / gate");
});

test("renaming the called job invalidates every portfolio claim at once", async () => {
  // Not a hypothetical: it is why the called half is read from validate.yml rather than hardcoded.
  const report = await auditPortfolio({
    client: governed(),
    document: DOCUMENT,
    git: noHistory,
    calledName: "renamed-job",
  });
  assert.equal(report.outcome, "FAIL");
  assert.equal(report.repositories[0].producedCheckName, "Standards / renamed-job");
});
