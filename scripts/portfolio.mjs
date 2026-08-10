#!/usr/bin/env node
/**
 * The portfolio governance audit.
 *
 * WHAT THIS ANSWERS, AND WHAT IT DOES NOT. Three claims sit on top of each other, and none of them
 * implies the others:
 *
 *     M7             can this workflow faithfully execute the orchestrator and report its result?
 *     M8 (here)      is this repository configured so that the workflow is REQUIRED?
 *     an actual run  did it execute and pass for this commit?
 *
 * This file answers the middle one only. Branch protection does not prove standards were executed for
 * any particular commit — that is run evidence, and claiming it here would turn a configuration check
 * into a compliance claim it cannot support.
 *
 * THE BOOTSTRAP PROBLEM, STATED RATHER THAN SOLVED. StandardsOrchestrator can verify evidence of
 * enforcement configuration. It cannot make repository administrators incapable of changing that
 * configuration. Beyond GitHub administration there is no further software layer inside these
 * repositories that could, and pretending otherwise would be the largest false assurance in the whole
 * design. So the success criterion is deliberately not "enforcement cannot be bypassed". It is:
 *
 *     Within the governance surfaces this audit can inspect, required standards enforcement cannot
 *     disappear, weaken, or become unevaluable without this audit ceasing to report green.
 *
 * TWO EVIDENCE SOURCES, KEPT SEPARATELY VISIBLE. Repository evidence is what the governed
 * repository's own files say. Platform evidence is what GitHub says about protection and required
 * checks. They fail independently and they are remedied in different places — one by editing a
 * workflow, the other by editing a ruleset — so they are never merged into a single verdict line.
 *
 * THE ALGEBRA IS THE SAME ONE. This deliberately reuses `aggregate` from the outcome algebra rather
 * than growing a second definition of green. That gives monotonicity and the empty-set protection for
 * free: adding an unevaluable repository can never improve the result, and a portfolio governing
 * nothing is INDETERMINATE rather than a clean bill of health.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./yaml.mjs";
import { validate as validateSchema, assertSchemaSupported } from "./jsonschema.mjs";
import { aggregate } from "./outcome.mjs";
import { lintCaller } from "./workflows.mjs";
import { createClient, tokenFromEnv, readRepository, readFileFromRepository, readBranchGovernance, readBypass } from "./github.mjs";
import { historicalMembership, auditMembership, runGit } from "./membership.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class PortfolioError extends Error {
  constructor(message) {
    super(message);
    this.name = "PortfolioError";
  }
}

/** Load and validate the registry. Every check is a load-time check. */
export async function loadPortfolio(root = ROOT) {
  const schema = JSON.parse(await readFile(path.join(root, "schemas", "portfolio.schema.json"), "utf8"));
  assertSchemaSupported(schema);

  let document;
  try {
    document = parseYaml(await readFile(path.join(root, "portfolio.yml"), "utf8"));
  } catch (error) {
    throw new PortfolioError(`portfolio.yml could not be read: ${error.message}`);
  }

  const errors = validateSchema(document, schema);
  if (errors.length > 0) {
    throw new PortfolioError(
      `portfolio.yml does not satisfy its schema:\n${errors.map((e) => `  ${e.path || "(root)"}: ${e.message}`).join("\n")}`,
    );
  }
  return { ...document, retired: document.retired ?? {} };
}

/**
 * The check identity this repository's reusable workflow contributes.
 *
 * GitHub composes a reusable workflow's check name from the calling job's name and the called job's
 * name. Reading the called half from our own workflow rather than hardcoding it means that renaming
 * the job here immediately marks every portfolio `checkName` as stale — which is right, because that
 * rename would leave every governed repository requiring an identity nothing will ever produce.
 */
export async function calledJobName(root = ROOT) {
  const document = parseYaml(await readFile(path.join(root, ".github", "workflows", "validate.yml"), "utf8"));
  const jobs = Object.entries(document.jobs ?? {});
  if (jobs.length !== 1) {
    throw new PortfolioError(`validate.yml declares ${jobs.length} jobs; the check identity is only well-defined for one`);
  }
  const [id, job] = jobs[0];
  return job?.name ?? id;
}

/** The identity a caller workflow would actually produce, or null if it declares no single job. */
export function producedCheckName(callerText, calledName) {
  const document = parseYaml(callerText);
  const jobs = Object.entries(document.jobs ?? {});
  if (jobs.length !== 1) return null;
  const [id, job] = jobs[0];
  return `${job?.name ?? id} / ${calledName}`;
}

/** Gather repository evidence: what the governed repository's own files say. */
async function repositoryEvidence(client, entry, calledName) {
  const findings = [];
  const caller = await readFileFromRepository(client, entry.repository, entry.enforcement.workflow);

  if (caller.status === "unreadable") {
    findings.push({
      evidence: "repository",
      finding: "caller-unreadable",
      unevaluable: true,
      detail: `${entry.enforcement.workflow} could not be read: ${caller.detail}. This is not evidence that it is absent.`,
    });
    return { findings, caller };
  }
  if (!caller.present) {
    findings.push({
      evidence: "repository",
      finding: "caller-absent",
      detail: `${entry.enforcement.workflow} does not exist. Nothing invokes the orchestrator, so no check can report.`,
    });
    return { findings, caller };
  }

  // The same structural checks the reusable workflow ships with, applied to the deployed copy: it must
  // be pinned, it must invoke the orchestrator, and nothing may suppress it on a governed event.
  let problems;
  try {
    problems = lintCaller(caller.text);
  } catch (error) {
    findings.push({
      evidence: "repository",
      finding: "caller-unparseable",
      detail: `${entry.enforcement.workflow} could not be parsed: ${error.message}`,
    });
    return { findings, caller };
  }
  for (const problem of problems) {
    findings.push({ evidence: "repository", finding: "caller-structure", detail: problem });
  }

  const reusable = entry.enforcement.reusableWorkflow ?? ".github/workflows/validate.yml";
  if (!caller.text.includes(reusable)) {
    findings.push({
      evidence: "repository",
      finding: "wrong-reusable-workflow",
      detail: `the caller does not invoke ${reusable}`,
    });
  }

  // The identity the caller produces versus the identity the portfolio claims. A rename here leaves
  // branch protection requiring a name nothing will ever report, which blocks every pull request —
  // failing closed, but still broken, and a broken enforcement system is an audit failure.
  const produced = producedCheckName(caller.text, calledName);
  if (produced === null) {
    findings.push({
      evidence: "repository",
      finding: "no-stable-identity",
      detail: "the caller declares no single job, so it produces no stable check identity",
    });
  } else if (produced !== entry.enforcement.checkName) {
    findings.push({
      evidence: "repository",
      finding: "identity-drift",
      detail: `the caller produces the check "${produced}" but the portfolio claims "${entry.enforcement.checkName}"`,
    });
  }

  return { findings, caller, produced };
}

/** Gather platform evidence: what GitHub says about protection, required checks, and bypass. */
async function platformEvidence(client, entry) {
  const findings = [];
  const branches = [];

  for (const branch of entry.enforcement.protectedBranches) {
    const governance = await readBranchGovernance(client, entry.repository, branch);
    branches.push(governance);

    if (!governance.complete && !governance.governed) {
      const which = [
        governance.classic.status === "unreadable" ? `classic protection (${governance.classic.detail})` : null,
        governance.rulesets.status === "unreadable" ? `rulesets (${governance.rulesets.detail})` : null,
      ].filter(Boolean);
      findings.push({
        evidence: "platform",
        finding: "governance-unreadable",
        unevaluable: true,
        detail: `${branch}: could not read ${which.join(" or ")}. Unreadable governance is not evidence of protection, and it is not evidence of its absence either.`,
      });
      continue;
    }

    if (governance.complete && !governance.governed) {
      findings.push({
        evidence: "platform",
        finding: "branch-unprotected",
        detail: `${branch} is governed by neither classic branch protection nor any ruleset, so no check can be required on it`,
      });
    }

    for (const required of entry.enforcement.requiredChecks) {
      if (governance.contexts.includes(required)) continue;
      if (!governance.complete) {
        findings.push({
          evidence: "platform",
          finding: "required-check-unevaluable",
          unevaluable: true,
          detail: `${branch}: "${required}" was not found among the readable required checks, but at least one governance mechanism could not be read, so its absence is not established`,
        });
        continue;
      }
      findings.push({
        evidence: "platform",
        finding: "required-check-missing",
        detail: `${branch}: the portfolio claims "${required}" is required, but the branch requires ${governance.contexts.length === 0 ? "no checks at all" : JSON.stringify(governance.contexts)}. The claim is stale.`,
      });
    }

    const bypass = await readBypass(client, entry.repository, governance.rulesets.rulesetIds ?? []);
    governance.bypass = bypass;
    if (bypass.status === "unreadable") {
      findings.push({
        evidence: "platform",
        finding: "bypass-unevaluable",
        unevaluable: true,
        detail: `${branch}: who may bypass these rules could not be read (${bypass.detail})`,
      });
    } else if (bypass.actors.length > 0) {
      findings.push({
        evidence: "platform",
        finding: "bypass-configured",
        detail: `${branch}: ${bypass.actors.length} actor(s) may bypass the rules carrying this check — ${bypass.actors
          .map((a) => `${a.actorType}#${a.actorId} on "${a.ruleset}" (${a.mode})`)
          .join(", ")}. For them the check is not required.`,
      });
    }
  }

  return { findings, branches };
}

/** One repository's class, from its findings. Order matters: a missing subject is not a bad config. */
function classify({ subject, findings }) {
  if (subject.class !== undefined) return subject.class;
  if (findings.some((f) => !f.unevaluable)) return "FAIL";
  if (findings.some((f) => f.unevaluable)) return "INDETERMINATE";
  return "PASS";
}

/** Audit every governed repository, plus membership. */
export async function auditPortfolio({ root = ROOT, client, git = runGit, generatedAt, document: given, calledName: givenName } = {}) {
  const document = given ?? (await loadPortfolio(root));
  const calledName = givenName ?? (await calledJobName(root));

  const audited = [];
  for (const [name, entry] of Object.entries(document.repositories ?? {})) {
    const findings = [];
    const subject = {};

    const repo = await readRepository(client, entry.repository);
    if (repo.status === "unreadable") {
      subject.class = "INDETERMINATE";
      findings.push({
        evidence: "platform",
        finding: "repository-unreadable",
        unevaluable: true,
        detail: `${entry.repository} could not be read: ${repo.detail}`,
      });
    } else if (!repo.present) {
      subject.class = "UNRESOLVED";
      findings.push({
        evidence: "platform",
        finding: "repository-absent",
        detail: `${entry.repository} does not exist. A governed repository that is gone is a governance change, not a clean audit.`,
      });
    } else {
      if (repo.renamed) {
        subject.class = "UNRESOLVED";
        findings.push({
          evidence: "platform",
          finding: "repository-renamed",
          detail: `the portfolio governs ${entry.repository}, which now canonically resolves to ${repo.canonical}`,
        });
      }
      if (repo.archived) {
        findings.push({
          evidence: "platform",
          finding: "repository-archived",
          detail: `${entry.repository} is archived, so its enforcement configuration can no longer change or be corrected`,
        });
      }
    }

    if (subject.class === undefined || subject.class === "INDETERMINATE") {
      const repository = await repositoryEvidence(client, entry, calledName);
      const platform = await platformEvidence(client, entry);
      findings.push(...repository.findings, ...platform.findings);
      audited.push({ name, entry, findings, branches: platform.branches, produced: repository.produced });
    } else {
      audited.push({ name, entry, findings, branches: [], produced: undefined });
    }

    audited[audited.length - 1].class = classify({ subject, findings });
  }

  // Membership is its own subject in the aggregate, so a portfolio that quietly shrank cannot be
  // green merely because everything still listed is in order.
  const history = historicalMembership({ root, git });
  const membership = auditMembership(document, history);
  const membershipClass =
    membership.status === "unevaluable" ? "INDETERMINATE" : membership.findings.length > 0 ? "FAIL" : "PASS";

  const results = [
    ...audited.map((a) => ({
      pack: a.name,
      class: a.class,
      applicability: "CONFIRMED",
      detail: a.findings.length > 0 ? a.findings[0].detail : undefined,
    })),
    {
      pack: "portfolio-membership",
      class: membershipClass,
      applicability: "CONFIRMED",
      detail:
        membership.status === "unevaluable"
          ? membership.detail
          : membership.findings.length > 0
            ? membership.findings[0].detail
            : undefined,
    },
  ];

  const gate = aggregate(results);

  // The empty-portfolio guard. `aggregate` protects the empty set, but membership is always a subject,
  // so the set is never empty and that protection would never fire here. A portfolio governing no
  // repository has audited nothing, and audited nothing is not a clean bill of health — it is the same
  // hazard as a project declaring its way out of every authority, one layer up.
  if (audited.length === 0 && gate.outcome === "PASS") {
    gate.outcome = "INDETERMINATE";
    gate.reasons = [
      ...gate.reasons,
      {
        pack: "portfolio",
        class: "INDETERMINATE",
        reason: "no repository is governed, so this audit examined nothing. Nothing examined is not a pass.",
      },
    ];
  }

  return {
    schemaVersion: "1.0.0",
    generatedAt,
    outcome: gate.outcome,
    reasons: gate.reasons,
    checkIdentity: calledName,
    membership: { status: membership.status, class: membershipClass, detail: membership.detail, findings: membership.findings },
    repositories: audited.map((a) => ({
      name: a.name,
      repository: a.entry.repository,
      class: a.class,
      producedCheckName: a.produced,
      claimedCheckName: a.entry.enforcement.checkName,
      // The two evidence sources stay apart, because they are remedied in different places.
      repositoryEvidence: a.findings.filter((f) => f.evidence === "repository"),
      platformEvidence: a.findings.filter((f) => f.evidence === "platform"),
      branches: a.branches,
    })),
  };
}

export function renderAudit(report) {
  const out = [];
  out.push(`Portfolio governance audit: ${report.outcome}`);
  out.push("");

  for (const repository of report.repositories) {
    out.push(`  ${repository.name}  (${repository.repository})  ${repository.class}`);
    const section = (label, findings) => {
      if (findings.length === 0) {
        out.push(`      ${label.padEnd(11)} no findings`);
        return;
      }
      for (const [index, finding] of findings.entries()) {
        out.push(`      ${(index === 0 ? label : "").padEnd(11)} ${finding.unevaluable ? "UNEVALUABLE" : "FAILED"} ${finding.finding}`);
        out.push(`                  ${finding.detail}`);
      }
    };
    section("repository", repository.repositoryEvidence);
    section("platform", repository.platformEvidence);
    out.push("");
  }

  out.push(`  portfolio membership  ${report.membership.class}`);
  if (report.membership.findings.length === 0 && report.membership.status !== "unevaluable") {
    out.push("      every repository ever governed is either still governed or explicitly retired");
  }
  for (const finding of report.membership.findings) out.push(`      ${finding.finding}: ${finding.detail}`);
  if (report.membership.status === "unevaluable") out.push(`      UNEVALUABLE ${report.membership.detail}`);
  out.push("");

  if (report.outcome !== "PASS") {
    out.push(`The audit is ${report.outcome} for ${report.reasons.length} reason(s):`);
    for (const reason of report.reasons) out.push(`  ${reason.pack}: ${reason.class} — ${reason.reason}`);
    out.push("");
  }

  out.push("This audit reports whether enforcement is CONFIGURED. It does not prove any standard ran for");
  out.push("any commit, and it cannot prevent an administrator from changing the configuration it reads.");
  out.push("");
  return out.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const token = tokenFromEnv();
  if (!token) {
    // Fail closed and loudly. Running tokenless would report every platform claim as unevaluable,
    // which is honest per repository but reads as a broken audit rather than a deliberate one.
    process.stderr.write("portfolio: no GITHUB_TOKEN or GH_TOKEN is set, so no platform evidence can be read.\n");
    process.stderr.write("This is an audit fault, not a finding about any repository.\n");
    process.exit(2);
  }

  let report;
  try {
    report = await auditPortfolio({ client: createClient({ token }), generatedAt: new Date().toISOString() });
  } catch (error) {
    process.stderr.write(`portfolio: ${error.message}\n`);
    process.stderr.write("This is an audit fault, not a finding about any repository.\n");
    process.exit(2);
  }

  process.stdout.write(args.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : renderAudit(report));
  process.exit(report.outcome === "PASS" ? 0 : 1);
}
