#!/usr/bin/env node
/**
 * The CI entry point, and the thing that makes a required check TERMINAL.
 *
 * A required status check that never reports leaves a pull request Pending forever. Pending is not
 * failing and it is not passing — it is the absence of a result, and the predictable human response
 * is to remove the check from branch protection. That turns the enforcement mechanism into its own
 * escape hatch. So the invariant this file exists to hold is:
 *
 *     The enforcement check must produce a terminal result for every event it claims to govern.
 *
 * TWO COMMANDS, DELIBERATELY SEPARATE.
 *
 *   `run`     orchestrates, writes the report and a terminal record, and exits with the honest code.
 *   `verify`  reads back what `run` recorded, re-derives the verdict from the report itself, and
 *             exits with that. It runs unconditionally in CI, including when `run` did not.
 *
 * `run` never swallows a failure — it exits non-zero when the gate fails, so the job is already red
 * before `verify` speaks. `verify` exists for the cases `run` cannot cover: `run` never started, was
 * cancelled, died at the runner level, or exited 0 while writing no report at all. In each of those
 * the check would otherwise be Pending or green-by-absence, and `verify` makes it terminal and red.
 *
 * THREE TERMINAL CODES, AND THE THIRD IS NOT A FINDING.
 *
 *   0  the gate passed
 *   1  the gate failed — some authority did not pass, or its prerequisites were not met
 *   2  the enforcement engine itself could not reach a conclusion
 *
 * GitHub sees only zero versus non-zero, so 1 and 2 are the same red check. They are kept distinct
 * anyway, because the summary a human reads must never present an orchestrator fault as evidence
 * that the project is non-compliant. Nobody should fix their code in response to a 2.
 */

import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { orchestrate } from "./orchestrate.mjs";
import { renderReport, exitCodeFor } from "./report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The terminal codes. `verify` may only ever return one of these. */
export const TERMINAL = Object.freeze({ PASS: 0, GATE_FAILURE: 1, ENFORCEMENT_FAULT: 2 });

const STATUS_FILE = "status.json";
const REPORT_FILE = "report.json";

/**
 * Run the gate and record its result.
 *
 * The terminal record is written in a `finally`, so a fault on the way to a conclusion is still
 * recorded as a fault rather than leaving nothing behind for `verify` to find.
 */
export async function runGate({ projectRoot, outDir, root = ROOT, generatedAt, orchestrateFn = orchestrate }) {
  await mkdir(outDir, { recursive: true });

  let status;
  let text;
  try {
    const report = await orchestrateFn({ projectRoot, root, generatedAt });
    const exitCode = exitCodeFor(report);
    await writeFile(path.join(outDir, REPORT_FILE), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    status = { kind: "report", outcome: report.outcome, exitCode, reasons: report.reasons.length };
    text = renderReport(report);
  } catch (error) {
    // The engine could not run. This is never a conclusion about the project, and the record says so
    // in the same words the summary will.
    status = {
      kind: "fault",
      outcome: null,
      exitCode: TERMINAL.ENFORCEMENT_FAULT,
      detail: error.message,
    };
    text =
      `The standards gate could not run: ${error.message}\n\n` +
      `This is a fault in the enforcement engine, not a conclusion about this project. ` +
      `Nothing here says the project is non-compliant; it says the check could not be performed.\n`;
  } finally {
    await writeFile(path.join(outDir, STATUS_FILE), `${JSON.stringify(status, null, 2)}\n`, "utf8");
  }

  return { status, text, exitCode: status.exitCode };
}

/**
 * Re-derive the verdict from what was recorded, and fail closed on anything that is not a complete,
 * self-consistent terminal record.
 *
 * The cross-check that matters is the last one: an exit code of 0 is only honoured when the report
 * itself independently says PASS. A green code beside a report that says otherwise — or beside no
 * report at all — is an enforcement fault, not a pass.
 */
export async function verifyGate({ outDir }) {
  let status;
  try {
    status = JSON.parse(await readFile(path.join(outDir, STATUS_FILE), "utf8"));
  } catch {
    return {
      kind: "no-terminal-record",
      exitCode: TERMINAL.GATE_FAILURE,
      message:
        "The standards gate produced no terminal record. The check is reported as failing rather " +
        "than left pending: an evaluation that did not happen is not a pass.",
    };
  }

  if (status.kind === "fault") {
    return {
      kind: "fault",
      exitCode: TERMINAL.ENFORCEMENT_FAULT,
      message:
        `The enforcement engine could not reach a conclusion: ${status.detail}\n` +
        "This is an engine fault, not a finding about this project. Do not change project code in " +
        "response to it.",
    };
  }

  if (status.kind !== "report") {
    return {
      kind: "unrecognised-record",
      exitCode: TERMINAL.GATE_FAILURE,
      message: `The terminal record is of an unrecognised kind (${JSON.stringify(status.kind)}), so no verdict can be read from it.`,
    };
  }

  let report;
  try {
    report = JSON.parse(await readFile(path.join(outDir, REPORT_FILE), "utf8"));
  } catch {
    return {
      kind: "missing-report",
      exitCode: TERMINAL.GATE_FAILURE,
      message:
        "The gate recorded a verdict but produced no readable report to support it. A verdict with " +
        "no evidence behind it is not a pass.",
    };
  }

  const recomputed = exitCodeFor(report);
  if (report.outcome !== status.outcome || recomputed !== status.exitCode) {
    return {
      kind: "inconsistent-record",
      exitCode: TERMINAL.GATE_FAILURE,
      message:
        `The recorded verdict (${status.outcome}, exit ${status.exitCode}) does not match the report ` +
        `it claims to summarise (${report.outcome}, exit ${recomputed}). Fail closed.`,
    };
  }

  return {
    kind: "verified",
    exitCode: recomputed,
    outcome: report.outcome,
    message:
      recomputed === TERMINAL.PASS
        ? `Standards gate: PASS. Every applicable authority passed and every prerequisite was satisfied.`
        : `Standards gate: ${report.outcome}. ${report.reasons.length} reason(s); see the job summary.`,
  };
}

/** Append to the GitHub step summary when running in Actions; a no-op anywhere else. */
async function writeSummary(body) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  await appendFile(target, `${body}\n`, "utf8");
}

function argOf(args, name, fallback) {
  const prefix = `--${name}=`;
  const inline = args.find((a) => a.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const command = args[0];
  const outDir = path.resolve(argOf(args, "out", "standards-gate"));

  if (command === "run") {
    const projectRoot = path.resolve(argOf(args, "project", process.cwd()));
    const { text, exitCode } = await runGate({
      projectRoot,
      outDir,
      generatedAt: new Date().toISOString(),
    });
    process.stdout.write(`${text}\n`);
    await writeSummary(["## Standards gate", "", "```", text.trimEnd(), "```"].join("\n"));
    process.exit(exitCode);
  } else if (command === "verify") {
    const result = await verifyGate({ outDir });
    const stream = result.exitCode === TERMINAL.PASS ? process.stdout : process.stderr;
    stream.write(`${result.message}\n`);
    if (result.kind !== "verified") {
      await writeSummary(["## Standards gate — not evaluated", "", result.message].join("\n"));
    }
    process.exit(result.exitCode);
  } else {
    process.stderr.write("usage: gate.mjs run|verify [--project <dir>] [--out <dir>]\n");
    process.exit(TERMINAL.ENFORCEMENT_FAULT);
  }
}
