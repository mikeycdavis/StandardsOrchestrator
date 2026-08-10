/**
 * Structural checks on the enforcement workflows.
 *
 * These are not style rules. Each one closes a specific way an enforcement path can look present
 * while failing to enforce, and each corresponds to something that has actually happened to somebody:
 *
 *   SKIPPED JOB        a `paths:` filter or a job-level `if:` means the required check does not run
 *                      on some governed events. It reports nothing, sits Pending, and someone
 *                      eventually removes it from branch protection to unblock a pull request.
 *   SWALLOWED FAILURE  `continue-on-error`, `|| true`, or a trailing `exit 0` turns a red result
 *                      green while the workflow still looks like it ran.
 *   FLOATING ENGINE    a caller pinned to `@main` runs whatever the engine happens to be today. The
 *                      enforcement is then no more reproducible than the branch it points at.
 *   MISSING GUARD      without a step that reports unconditionally, a run that dies before the gate
 *                      speaks leaves the check with no terminal result.
 *
 * These checks are also why the workflows stay inside the same strict YAML subset as everything else
 * in this repository: a file this parser can read is a file a person can read without guessing.
 *
 * WHAT THIS CANNOT CHECK. That the caller exists at all in the adopting repository, and that its
 * check is registered as required. A repository with no caller passes every check in this file by
 * having nothing to fail. That gap is real, it is named here rather than papered over, and it is the
 * portfolio audit's job — one layer up, from outside the repository.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./yaml.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A caller may be shipped as a template with this placeholder in place of a reviewed commit. */
export const PIN_PLACEHOLDER = "PINNED_ORCHESTRATOR_COMMIT_SHA";

const COMMIT_PIN = /^[0-9a-f]{40}$/;
const SWALLOWERS = [
  [/\|\|\s*true\b/, "`|| true`"],
  [/\|\|\s*:/, "`|| :`"],
  [/\|\|\s*exit\s+0\b/, "`|| exit 0`"],
  [/(^|;|&&)\s*exit\s+0\s*$/, "a trailing `exit 0`"],
  [/\bset\s+\+e\b/, "`set +e`"],
];

/** Walk every mapping in the document, yielding [key, value, path] for each entry. */
function* entries(node, trail = []) {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) yield* entries(item, [...trail, `[${index}]`]);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node)) {
    yield [key, value, [...trail, key]];
    yield* entries(value, [...trail, key]);
  }
}

function jobsOf(document, problems) {
  const jobs = document.jobs;
  if (jobs === null || typeof jobs !== "object" || Array.isArray(jobs)) {
    problems.push("the workflow declares no jobs, so it can report nothing");
    return {};
  }
  return jobs;
}

/** Checks that apply to any workflow claiming to be part of the enforcement path. */
function checkCommon(document, problems) {
  for (const [key, value, trail] of entries(document)) {
    if (key === "continue-on-error") {
      problems.push(`${trail.join(".")}: \`continue-on-error\` lets a failed gate report as success`);
    }
    if (key === "paths" || key === "paths-ignore") {
      problems.push(
        `${trail.join(".")}: a \`${key}\` filter stops the check reporting on events it claims to ` +
          "govern, and a required check that does not report sits pending",
      );
    }
    if (key === "run" && typeof value === "string") {
      for (const [pattern, label] of SWALLOWERS) {
        if (pattern.test(value)) problems.push(`${trail.join(".")}: ${label} can turn a failure into a pass`);
      }
    }
  }

  const jobs = jobsOf(document, problems);
  const names = Object.keys(jobs);
  if (names.length > 1) {
    // One job, one check identity. Several jobs mean several check names, and branch protection then
    // guards whichever subset somebody remembered to register.
    problems.push(`${names.length} jobs are declared; the enforcement path must present one stable check identity`);
  }
  for (const [name, job] of Object.entries(jobs)) {
    if (job && typeof job === "object" && job.if !== undefined) {
      problems.push(`jobs.${name}: a job-level \`if:\` makes the check conditional, and a conditional check is not a required check`);
    }
  }
  return jobs;
}

/** The reusable workflow: it must be callable, and it must end in an unconditional verdict. */
export function lintReusable(text) {
  const problems = [];
  const document = parseYaml(text);

  if (document.on === null || typeof document.on !== "object" || document.on.workflow_call === undefined) {
    problems.push("the reusable workflow does not declare `on.workflow_call`, so nothing can invoke it");
  }

  const jobs = checkCommon(document, problems);
  for (const [name, job] of Object.entries(jobs)) {
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    if (steps.length === 0) {
      problems.push(`jobs.${name}: declares no steps`);
      continue;
    }

    // The terminality guard. Its condition must be unconditional in the Actions sense: `always()`
    // runs after a failure, a cancellation, and a step that never started.
    const guard = steps.find((step) => typeof step?.if === "string" && /\balways\s*\(\s*\)/.test(step.if));
    if (guard === undefined) {
      problems.push(
        `jobs.${name}: no step runs with \`if: always()\`, so a run that dies before the gate speaks ` +
          "leaves the required check with no terminal result",
      );
    } else if (steps[steps.length - 1] !== guard) {
      problems.push(`jobs.${name}: the \`always()\` guard is not the last step, so it cannot be the terminal word`);
    } else if (typeof guard.run !== "string" || !guard.run.includes("verify")) {
      problems.push(`jobs.${name}: the \`always()\` guard does not run the verify command, so it reports nothing of its own`);
    }

    // The engine must be the pinned one. `github.workflow_sha` is the commit of this workflow file as
    // the caller invoked it; anything else is the engine choosing its own version.
    const engine = steps.find((step) => step?.with?.repository !== undefined);
    if (engine === undefined) {
      problems.push(`jobs.${name}: no step checks out the engine repository`);
    } else if (!String(engine.with.ref ?? "").includes("workflow_sha")) {
      problems.push(
        `jobs.${name}: the engine is checked out at \`${engine.with.ref}\` rather than ` +
          "`github.workflow_sha`, so the engine that runs need not be the engine the caller pinned",
      );
    }
  }

  return problems;
}

/** A caller in an adopting repository. `template` allows the unreplaced pin placeholder. */
export function lintCaller(text, { template = false } = {}) {
  const problems = [];
  const document = parseYaml(text);

  const triggers = document.on;
  if (triggers === null || typeof triggers !== "object") {
    problems.push("the caller declares no triggers, so it governs no events");
  } else if (!Object.prototype.hasOwnProperty.call(triggers, "pull_request")) {
    problems.push("the caller does not trigger on `pull_request`, so it cannot gate a merge");
  }

  const jobs = checkCommon(document, problems);
  for (const [name, job] of Object.entries(jobs)) {
    const uses = job?.uses;
    if (typeof uses !== "string") {
      problems.push(`jobs.${name}: does not invoke the orchestrator's reusable workflow at all`);
      continue;
    }
    if (!uses.includes("/.github/workflows/validate.yml@")) {
      problems.push(`jobs.${name}: \`uses: ${uses}\` does not invoke the orchestrator's validate workflow`);
      continue;
    }
    const pin = uses.slice(uses.lastIndexOf("@") + 1);
    if (template && pin === PIN_PLACEHOLDER) continue;
    if (!COMMIT_PIN.test(pin)) {
      problems.push(
        `jobs.${name}: pinned to \`${pin}\`, which is not a 40-character commit SHA. A branch or tag ` +
          "can move, so the enforcement engine that runs would not be the one that was reviewed",
      );
    }
  }

  return problems;
}

/** Lint the workflows this repository ships. Returns a list of `{file, problems}`. */
export async function lintShippedWorkflows(root = ROOT) {
  const reusable = path.join(root, ".github", "workflows", "validate.yml");
  const caller = path.join(root, "templates", "caller", "standards.yml");
  return [
    { file: reusable, problems: lintReusable(await readFile(reusable, "utf8")) },
    { file: caller, problems: lintCaller(await readFile(caller, "utf8"), { template: true }) },
  ];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const results = await lintShippedWorkflows();
  let failed = false;
  for (const { file, problems } of results) {
    const name = path.relative(ROOT, file);
    if (problems.length === 0) {
      process.stdout.write(`ok  ${name}\n`);
      continue;
    }
    failed = true;
    process.stdout.write(`FAIL ${name}\n`);
    for (const problem of problems) process.stdout.write(`     ${problem}\n`);
  }
  process.exit(failed ? 1 : 0);
}
