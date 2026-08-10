/**
 * The v1.0.0 baseline.
 *
 * WHY THIS FILE EXISTS. The other suites test behaviour. This one pins the CONTRACT — the set of
 * properties that make the orchestrator's output worth believing, each of which could be removed by a
 * plausible-looking refactor without any other test noticing. An adapter gaining a version range, a
 * detector learning to conclude, an unreadable governance response quietly counted as "no rules
 * found": none of those announces itself, and each makes the gate claim more than it can support.
 *
 * Everything asserted here was true when v1.0.0 shipped. A failure means the shape of the contract
 * changed, and the only wrong response is to relax the assertion so the change passes unnoticed.
 * Change the assertion in the same commit as the change that moved it, with a message saying why.
 *
 * EACH ASSERTION HERE WAS MUTATION-PROVEN. On 2026-08-10 one mutation per property was applied to the
 * implementation and this file was confirmed RED for every one — a domain concept added to the
 * registry, UNRESOLVED collapsed into FAIL on the way out, the empty set returning PASS, INDETERMINATE
 * excused from the lattice, an adapter falling back to a neighbouring version, an interpreter dropped,
 * resolution accepting a branch of the pinned name, a detector exporting a conclusion, silence read as
 * NOT_APPLICABLE, the composition prerequisite repointed, the unsatisfied-dependency branch disabled,
 * INDETERMINATE mapped to exit 2, a path filter added to the caller template, the membership finding
 * renamed, unreadable governance marked complete, and a combined score added to the report. The one
 * that did NOT bite on the first pass was the detector check — it read a Map entry rather than the
 * module — and that is the reason this paragraph exists rather than a claim that the file is careful.
 *
 * WHAT IS DELIBERATELY NOT ASSERTED. The total test count, and the specific commits the live remotes
 * currently advertise. The first makes adding a test a chore for no information. The second is
 * resolution's job — `test/resolve.test.mjs` queries the real remotes; what belongs HERE is that the
 * adapters pin an immutable commit at all, which is checkable without a network.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkBoundary } from "../scripts/boundary.mjs";
import { OUTCOME_CLASSES, aggregate, carryCoverage, exitCodeFor as exitForOutcome } from "../scripts/outcome.mjs";
import { DECLARATIONS, DETECTIONS, deriveApplicability } from "../scripts/applicability.mjs";
import { loadRegistry, resolveAdapter } from "../scripts/registry.mjs";
import { RESOLUTION_REASONS, resolveRelease } from "../scripts/resolve.mjs";
import { loadDetectors } from "../scripts/detect.mjs";
import { buildReport, exitCodeFor } from "../scripts/report.mjs";
import { TERMINAL } from "../scripts/gate.mjs";
import { lintShippedWorkflows } from "../scripts/workflows.mjs";
import { auditMembership } from "../scripts/membership.mjs";
import { readBranchGovernance } from "../scripts/github.mjs";
import { auditPortfolio } from "../scripts/portfolio.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The published shape. Two adapters, four known packs, and the two commits this release was built
 * against and reviewed at.
 */
const BASELINE = {
  version: "1.0.0",
  packs: ["betting", "prediction", "ml", "engineering"],
  adapters: ["betting@1.0.0", "prediction@1.1.0"],
  pins: {
    "betting@1.0.0": "a4e7e680ca9213d6bf9f5042a3ae7fd7383b7545",
    "prediction@1.1.0": "ebe232bb52cd4b97b5ff3d53c52d6fd344fa3159",
  },
  outcomeClasses: ["PASS", "FAIL", "BLOCKED", "INDETERMINATE", "UNRESOLVED", "CONFLICT"],
};

const registry = await loadRegistry(ROOT);

// --- the published shape --------------------------------------------------------------------------

test("VERSION and package.json agree at the baseline version", async () => {
  // The orchestrator reports this exact drift in other repositories (EngineeringStandards ships
  // VERSION 2.0.1 against package.json 2.0.0). It has no standing to report it while carrying it.
  const version = (await readFile(path.join(ROOT, "VERSION"), "utf8")).trim();
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(version, BASELINE.version);
  assert.equal(pkg.version, BASELINE.version);
});

test("package.json declares no dependencies, and CI has no install step", async () => {
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.deepEqual(pkg.devDependencies ?? {}, {});

  // The absence of the install is what enforces the decision — a policy document would not.
  const ci = await readFile(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const executable = ci
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(executable, /npm (ci|install)/);

  // And the local command sequence runs the same three gates CI does, so "it passed locally" and
  // "it passed in CI" cannot come apart.
  for (const script of ["boundary", "workflows", "test"]) {
    assert.match(pkg.scripts.ci, new RegExp(`\\b${script}\\b`), `npm run ci must cover ${script}`);
    assert.match(executable, new RegExp(`npm (run )?${script}\\b`), `CI must run ${script}`);
  }
});

// --- 1. no normative domain standards -------------------------------------------------------------

test("no normative domain standard lives in this repository", async () => {
  const violations = await checkBoundary(ROOT);
  assert.deepEqual(violations, []);

  // The boundary is a composition claim, not a hedge: there is no directory here that could hold a
  // domain requirement in the first place. `standards/` is what a pack has and this must never grow.
  const pkg = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.name, "standards-orchestrator");
  await assert.rejects(readFile(path.join(ROOT, "standards", "01-the-fundamental-invariant.md")));
});

// --- 2. six outcome classes remain distinguishable ------------------------------------------------

test("the six outcome classes are exactly these, and survive into the JSON distinctly", () => {
  assert.deepEqual([...OUTCOME_CLASSES], BASELINE.outcomeClasses);

  // Not merely distinct in the vocabulary — distinct in the artefact a reader acts on. Collapsing
  // UNRESOLVED into FAIL would send someone to fix a project that was never evaluated.
  const report = buildReport({
    project: "baseline",
    generatedAt: "2026-08-10T00:00:00Z",
    authorities: BASELINE.outcomeClasses.map((klass, i) => ({
      pack: `p${i}`,
      authority: `p${i}@1.0.0`,
      class: klass,
      applicability: "CONFIRMED",
    })),
  });
  assert.deepEqual(
    report.authorities.map((a) => a.class),
    BASELINE.outcomeClasses,
  );
  const reported = new Set(report.reasons.map((r) => r.class));
  for (const klass of BASELINE.outcomeClasses.filter((k) => k !== "PASS")) {
    assert.ok(reported.has(klass), `${klass} was folded into another class on the way out`);
  }
});

// --- 3. empty evaluation cannot pass --------------------------------------------------------------

test("nothing evaluated is never a pass, at either layer", async () => {
  assert.equal(aggregate([]).outcome, "INDETERMINATE");
  assert.equal(
    aggregate([{ pack: "betting", class: "PASS", applicability: "NOT_APPLICABLE" }]).outcome,
    "INDETERMINATE",
    "every authority ruled not-applicable means nothing was evaluated",
  );

  // The same rule one layer up. A portfolio governing nothing has audited nothing, and `aggregate`'s
  // own empty-set guard cannot fire there because membership is always a subject.
  const empty = await auditPortfolio({
    client: { hasToken: true, async get() { return { status: 404, ok: false, error: "Not Found" }; } },
    document: { repositories: {}, retired: {} },
    git: () => ({ ok: true, stdout: "" }),
    calledName: "gate",
    generatedAt: "2026-08-10T00:00:00Z",
  });
  assert.notEqual(empty.outcome, "PASS");
});

// --- 4. non-PASS cannot be offset -----------------------------------------------------------------

test("no set containing a non-PASS aggregates to PASS, in any order or quantity", () => {
  const green = { pack: "green", class: "PASS", applicability: "CONFIRMED" };
  for (const klass of BASELINE.outcomeClasses.filter((k) => k !== "PASS")) {
    const red = { pack: "red", class: klass, applicability: "CONFIRMED" };
    for (const set of [[red], [green, red], [red, green], [green, green, red, green]]) {
      assert.notEqual(aggregate(set).outcome, "PASS", `${klass} was offset by a passing authority`);
    }
  }
  // Aggregation is `max` over a lattice, so it is order-independent and idempotent by construction.
  assert.equal(aggregate([green, green, green]).outcome, "PASS");
});

// --- 5 & 6. adapters are exact-version, interpreter-backed, and exactly these two -----------------

test("exactly two releases are understood, each pinned to an immutable commit", () => {
  assert.deepEqual([...registry.packs.keys()].sort(), [...BASELINE.packs].sort());
  assert.deepEqual([...registry.adapters.keys()].sort(), [...BASELINE.adapters].sort());

  for (const [key, entry] of registry.adapters) {
    assert.equal(entry.adapter.expectedCommit, BASELINE.pins[key]);
    assert.match(entry.adapter.expectedCommit, /^[0-9a-f]{40}$/, "a pin must be a commit, not a movable ref");
    // Interpreter-backed: the envelope is read by code derived against that release, never by a
    // generic reader guessing at a shape.
    assert.equal(typeof entry.interpreter.readVerdict, "function");
    assert.equal(typeof entry.interpreter.readCoverage, "function");
  }
});

test("an adapter is never consulted for a version it does not name", () => {
  for (const version of ["1.0.1", "1.1.0", "0.9.0", "2.0.0", "latest", "*"]) {
    const result = resolveAdapter(registry, "betting", version);
    if (version === "1.0.0") continue;
    assert.notEqual(result.status, "ok", `betting@${version} found an adapter it does not name`);
  }
  // A pack that exists at a release nobody established how to compose, and a pack that does not
  // exist, stay separable: one needs an adapter, the other is a typo.
  assert.equal(resolveAdapter(registry, "ml", "1.4.0").status, "unsupported-release");
  assert.equal(resolveAdapter(registry, "betting-standards", "1.0.0").status, "unknown-pack");
});

// --- 7. resolution never falls back ----------------------------------------------------------------

test("resolution fails closed rather than falling back from an immutable remote tag", () => {
  const [{ adapter }] = [...registry.adapters.values()];
  const pinned = adapter.expectedCommit;

  // An annotated tag advertises both the tag object and the commit it peels to.
  const listing = (commit) =>
    `${"f".repeat(40)}\trefs/tags/${adapter.ref}\n${commit}\trefs/tags/${adapter.ref}^{}\n`;

  const cases = {
    REF_NOT_FOUND: () => ({ ok: true, stdout: "" }),
    COMMIT_MISMATCH: () => ({ ok: true, stdout: listing("b".repeat(40)) }),
    REMOTE_UNAVAILABLE: () => ({ ok: false, stderr: "could not read from remote" }),
    // The one that matters most: a mutable ref of the right name never stands in for the tag.
    REF_NOT_TAG: () => ({ ok: true, stdout: `${pinned}\trefs/heads/${adapter.ref}\n` }),
  };
  for (const [reason, git] of Object.entries(cases)) {
    const result = resolveRelease(adapter, { git });
    assert.equal(result.status, "unresolved");
    assert.equal(result.reasonCode, reason);
    assert.ok(RESOLUTION_REASONS[reason], "every reason code carries its own remedy text");
    assert.equal(result.commit, undefined, "an unresolved authority must carry no commit to execute");
  }

  // Newer tags being present is not a licence to use one. Only the pinned tag, at the pinned commit.
  const withNewer = resolveRelease(adapter, {
    git: () => ({ ok: true, stdout: `${"c".repeat(40)}\trefs/tags/v9.9.9\n${listing(pinned)}` }),
  });
  assert.equal(withNewer.status, "resolved");
  assert.equal(withNewer.commit, pinned);
});

// --- 8. detection cannot issue verdicts ------------------------------------------------------------

test("a detector produces evidence, never a conclusion", async () => {
  // A whitelist rather than a blacklist of conclusion-shaped names. A detector declares who it looks
  // for and what it looks for, and nothing else; anything further is a capability it should not have,
  // whatever it happens to be called.
  const detectors = await loadDetectors(ROOT);
  assert.ok(detectors.size > 0, "a suite that loads no detectors proves nothing about them");
  for (const [pack, module] of detectors) {
    assert.deepEqual(Object.keys(module).sort(), ["pack", "signals"], `detector ${pack} exports more than evidence`);
  }
  // And structurally: detection alone cannot make a pack run, and cannot make one not run.
  const forced = deriveApplicability({ pack: "betting", declaration: "UNSPECIFIED", detection: "DETECTED" });
  assert.equal(forced.disposition, "CONFLICT");
  const suppressed = deriveApplicability({ pack: "betting", declaration: "REQUIRED", detection: "NOT_DETECTED" });
  assert.equal(suppressed.applicability, "DECLARED_ONLY", "a silent detector cannot waive a declaration");
});

// --- 9. applicability silence cannot waive a pack --------------------------------------------------

test("saying nothing is never a decision that a pack does not apply", () => {
  for (const detection of DETECTIONS) {
    const result = deriveApplicability({ pack: "betting", declaration: "UNSPECIFIED", detection });
    assert.notEqual(result.disposition, "NOT_APPLICABLE", `silence + ${detection} waived the authority`);
    assert.notEqual(aggregate([{ pack: "betting", class: "PASS", applicability: result.applicability }]).outcome, "PASS");
  }
  // Only an explicit declaration can, and only when detection agrees.
  assert.equal(DECLARATIONS.includes("NOT_APPLICABLE"), true);
  assert.equal(
    deriveApplicability({ pack: "betting", declaration: "NOT_APPLICABLE", detection: "DETECTED" }).disposition,
    "CONFLICT",
  );
});

// --- 10 & 11. the composition prerequisite, and that it cannot be hidden ---------------------------

test("prediction@1.1.0 remains a prerequisite of betting@1.0.0", async () => {
  const document = JSON.parse(await readFile(path.join(ROOT, "registry", "dependencies.json"), "utf8"));
  const edge = document.dependencies["betting@1.0.0"]?.requires?.find((r) => r.authority === "prediction@1.1.0");
  assert.ok(edge, "the composition prerequisite is gone");
  assert.equal(edge.condition, "satisfied");
  assert.ok(edge.rationale.length > 200, "a prerequisite with no recorded reason is a rule nobody can review");
});

test("an unsatisfied upstream cannot be hidden by the dependent authority passing", () => {
  const result = aggregate([
    { pack: "betting", class: "PASS", applicability: "CONFIRMED", dependencyStatus: "unsatisfied" },
  ]);
  assert.equal(result.outcome, "FAIL");
  assert.ok(
    result.reasons.some((r) => r.dependencyStatus === "unsatisfied"),
    "the upstream must be named as the cause rather than the dependent reported green",
  );
});

// --- 12. engine faults cannot become project compliance --------------------------------------------

test("exit 2 is reserved for the engine, and no outcome can produce it", () => {
  assert.deepEqual({ ...TERMINAL }, { PASS: 0, GATE_FAILURE: 1, ENFORCEMENT_FAULT: 2 });
  for (const outcome of ["PASS", "FAIL", "BLOCKED", "INDETERMINATE"]) {
    const code = exitForOutcome(outcome);
    assert.notEqual(code, TERMINAL.ENFORCEMENT_FAULT, `${outcome} produced the engine-fault code`);
    assert.equal(exitCodeFor({ outcome }), code, "the two exit contracts must not drift apart");
  }
  // And the reverse: an engine fault is not silently a pass either.
  assert.equal(exitCodeFor({ outcome: "SOMETHING_NEW" }), TERMINAL.GATE_FAILURE);
});

// --- 13. workflows must always terminate and report ------------------------------------------------

test("the shipped workflows cannot skip, swallow, or leave a check pending", async () => {
  for (const { file, problems } of await lintShippedWorkflows(ROOT)) {
    assert.deepEqual(problems, [], `${path.relative(ROOT, file)}: ${problems.join("; ")}`);
  }

  const reusable = await readFile(path.join(ROOT, ".github/workflows/validate.yml"), "utf8");
  assert.match(reusable, /always\(\)/, "the terminal-result guard is what stops a check sitting pending");
  assert.match(reusable, /github\.workflow_sha/, "the engine must be checked out at the commit that was invoked");

  // Comments stripped: the template explains at length WHY it has no path filter, and a textual
  // search would match the explanation. The linter reads the parsed document; this reads the
  // executable lines.
  const caller = (await readFile(path.join(ROOT, "templates/caller/standards.yml"), "utf8"))
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(caller, /^\s+if:/m, "applicability belongs inside the orchestrator, not in CI");
  assert.doesNotMatch(caller, /paths(-ignore)?:/, "a path filter is a silent skip");
});

// --- 14. portfolio membership cannot disappear silently --------------------------------------------

test("a repository cannot leave governance in the commit that deletes the record of it", () => {
  const history = {
    status: "readable",
    everGoverned: new Map([["Ghost", { firstSeen: "2026-01-01T00:00:00Z" }]]),
  };
  const gone = auditMembership({ repositories: {}, retired: {} }, history);
  assert.equal(gone.findings[0].finding, "left-without-record");

  const unexplained = auditMembership({ repositories: {}, retired: { Ghost: { rationale: "  " } } }, history);
  assert.equal(unexplained.findings[0].finding, "retired-without-rationale");

  const recorded = auditMembership({ repositories: {}, retired: { Ghost: { rationale: "superseded by X" } } }, history);
  assert.deepEqual(recorded.findings, []);

  // An unreadable history is never clean. A shallow clone must not make governance look untouched.
  assert.equal(auditMembership({ repositories: {} }, { status: "unreadable" }).status, "unevaluable");
});

// --- 15. unreadable governance is not evidence of absent governance --------------------------------

test("a governance mechanism that could not be read establishes nothing either way", async () => {
  const client = (routes) => ({ hasToken: true, async get(route) { return routes[route] ?? { status: 404, ok: false, error: "Not Found" }; } });
  const forbidden = { status: 403, ok: false, error: "Upgrade to GitHub Pro" };

  const unreadable = await readBranchGovernance(
    client({
      "/repos/o/r/branches/main/protection": forbidden,
      "/repos/o/r/rules/branches/main": forbidden,
    }),
    "o/r",
    "main",
  );
  assert.equal(unreadable.complete, false);
  assert.equal(unreadable.governed, false, "unreadable must not read as protected");
  assert.deepEqual(unreadable.contexts, [], "and it must not manufacture a required-check list either");
  assert.equal(unreadable.classic.status, "unreadable");
  assert.equal(unreadable.rulesets.status, "unreadable");

  // The asymmetry that licenses concluding absence: a 404 from the CLASSIC endpoint is a genuine
  // absence of a classic protection object, including on branches a ruleset governs. Read as
  // unreadable it would make every ruleset-governed repository permanently unevaluable; read as
  // proof of no protection it would be a confident false negative. It is neither — it is one
  // mechanism's readable answer, and the other mechanism still has to be asked.
  const rulesetGoverned = await readBranchGovernance(
    client({
      "/repos/o/r/branches/main/protection": { status: 404, ok: false, error: "Branch not protected" },
      "/repos/o/r/rules/branches/main": {
        status: 200,
        ok: true,
        body: [
          {
            type: "required_status_checks",
            ruleset_id: 1,
            parameters: { required_status_checks: [{ context: "Standards / gate" }] },
          },
        ],
      },
    }),
    "o/r",
    "main",
  );
  assert.equal(rulesetGoverned.complete, true);
  assert.equal(rulesetGoverned.governed, true);
  assert.deepEqual(rulesetGoverned.contexts, ["Standards / gate"]);
});

// --- 16. no combined coverage or compliance figure --------------------------------------------------

test("each authority's coverage is carried verbatim, and nothing is combined", () => {
  // Deliberately incommensurable shapes — this is what the recon actually found across the packs.
  const betting = { cataloguedRules: 51, evaluatedRules: 41, note: "coverage is not compliance" };
  const prediction = { basis: "perRecord", records: 3 };

  const report = buildReport({
    project: "baseline",
    generatedAt: "2026-08-10T00:00:00Z",
    authorities: [
      { pack: "betting", authority: "betting@1.0.0", class: "PASS", applicability: "CONFIRMED", coverage: betting },
      { pack: "prediction", authority: "prediction@1.1.0", class: "PASS", applicability: "CONFIRMED", coverage: prediction },
    ],
  });

  assert.deepEqual(report.coverage, { betting, prediction });
  assert.equal(report.coverage.betting, betting, "carried by reference: not reshaped, not normalised");

  for (const key of Object.keys(report)) {
    assert.ok(
      !/score|percent|total|combined|average|compliance$/i.test(key),
      `the report grew a '${key}' field, which implies a comparability that does not exist`,
    );
  }
  assert.equal(carryCoverage([{ pack: "x", class: "PASS" }]).x, undefined, "absent coverage is absent, not zero");
});
