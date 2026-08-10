/**
 * Acquisition and execution.
 *
 * Resolution established WHICH authority should run. This module obtains it and runs it, and the split
 * is deliberate: "we know exactly what should run" is a claim worth being able to make before "we
 * downloaded and executed it", because only the second one involves running someone else's code.
 *
 * WHAT EACH FAILURE MEANS, AND WHY IT IS NOT NON-COMPLIANCE:
 *
 *   acquisition failed          -> UNRESOLVED. The authority could not be obtained. Nothing ran.
 *   the fetched commit is wrong -> UNRESOLVED. Re-verified after checkout, not merely before fetch.
 *   the policy file is missing  -> INDETERMINATE. A configuration fault is not failing work.
 *   the process could not start  -> INDETERMINATE.
 *   the process timed out        -> INDETERMINATE.
 *
 * None of these is FAIL. FAIL means an authority ran and reached a negative conclusion about the
 * project, and only the authority itself may say that.
 *
 * THE COMMIT IS VERIFIED TWICE. `git ls-remote` before fetching proves the tag points where the
 * adapter says. Checking `rev-parse HEAD` after checkout proves what is on disk is that same commit —
 * which is a different claim, and the one that matters, because it is the code about to execute.
 */

import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { classify } from "./interpret.mjs";

const DEFAULT_TIMEOUT_MS = 300_000;

function git(cwd, args) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo" },
  });
}

const unresolved = (resolution, detail, reasonCode) => ({
  authority: `${resolution.pack}@${resolution.version}`,
  pack: resolution.pack,
  version: resolution.version,
  class: "UNRESOLVED",
  reasonCode,
  detail,
  verdict: null,
  coverage: undefined,
});

const indeterminate = (resolution, detail) => ({
  authority: `${resolution.pack}@${resolution.version}`,
  pack: resolution.pack,
  version: resolution.version,
  class: "INDETERMINATE",
  detail,
  verdict: null,
  coverage: undefined,
});

/**
 * Fetch exactly the pinned commit into a workspace.
 *
 * Fetching the SHA rather than the tag is the point: a tag can move between the resolution check and
 * the fetch, and asking for the commit by name removes that window entirely.
 */
export async function acquire(resolution, { workspace, run = git } = {}) {
  const dir = path.join(workspace, `${resolution.pack}-${resolution.version}`);
  await mkdir(dir, { recursive: true });

  const steps = [
    ["init", "-q"],
    ["remote", "add", "origin", resolution.repository],
    ["fetch", "-q", "--depth", "1", "origin", resolution.commit],
    ["checkout", "-q", "FETCH_HEAD"],
  ];
  for (const args of steps) {
    const result = run(dir, args);
    if (result.error || result.status !== 0) {
      const detail = (result.stderr ?? result.error?.message ?? "").trim().split("\n").slice(0, 3).join("; ");
      return {
        ok: false,
        failure: unresolved(
          resolution,
          `the authority could not be obtained (git ${args[0]}): ${detail || `exited ${result.status}`}`,
          "ACQUISITION_FAILED",
        ),
      };
    }
  }

  // The second verification. ls-remote proved the tag points at this commit; this proves the working
  // tree IS that commit, which is the claim that covers the code about to execute.
  const head = run(dir, ["rev-parse", "HEAD"]);
  const onDisk = (head.stdout ?? "").trim();
  if (onDisk !== resolution.commit) {
    return {
      ok: false,
      failure: unresolved(
        resolution,
        `the workspace is at ${onDisk || "an unknown commit"}, not the pinned ${resolution.commit}`,
        "COMMIT_MISMATCH",
      ),
    };
  }

  return { ok: true, packRoot: dir, commit: onDisk };
}

/** Substitute placeholders positionally. Never string-concatenated into a shell. */
function buildArgv(adapter, { target, policy }) {
  return adapter.invocation.argvTemplate.map((argument) =>
    argument.replace(/\{\{(target|policy)\}\}/g, (_, name) => (name === "target" ? target : policy)),
  );
}

function defaultSpawn(command, args, options) {
  return spawnSync(command, args, { ...options, encoding: "utf8" });
}

/**
 * Run one acquired authority against one project, and classify what comes back.
 *
 * The pre-flight checks exist because the adapters recorded hazards that make them necessary. Passing
 * an absolute target stops a release defaulting to its own fixtures; stat-ing the policy first stops a
 * release whose policy discovery walks up twelve directories from grading this project against
 * somebody else's rules.
 */
export async function execute(resolved, { projectRoot, policyPath, packRoot, spawn = defaultSpawn, timeout = DEFAULT_TIMEOUT_MS }) {
  const { adapter, interpreter } = resolved;
  const identity = {
    authority: `${adapter.pack}@${adapter.version}`,
    pack: adapter.pack,
    version: adapter.version,
    commit: resolved.commit,
  };

  const target = path.resolve(projectRoot);
  if (adapter.invocation.requiresAbsoluteTarget && !path.isAbsolute(target)) {
    return { ...identity, ...indeterminate(resolved, "the target could not be made absolute") };
  }

  let policy = policyPath === undefined ? "" : path.resolve(policyPath);
  if (adapter.invocation.requiresAbsolutePolicyPath) {
    if (policy === "") {
      return {
        ...identity,
        ...indeterminate(resolved, "this release requires an explicit policy path and none was supplied"),
      };
    }
    try {
      const info = await stat(policy);
      if (!info.isFile()) throw new Error("not a file");
    } catch {
      // Verified here rather than left to the release, whose own handling of a missing policy exits 1
      // and would otherwise read as a negative conclusion about the project.
      return {
        ...identity,
        ...indeterminate(resolved, `the policy file ${policy} does not exist, so nothing could be evaluated`),
      };
    }
  }

  const argv = buildArgv(adapter, { target, policy });
  const entry = path.join(packRoot, adapter.entryPoint);

  const run = spawn(process.execPath, [entry, ...argv], { cwd: packRoot, timeout, maxBuffer: 64 * 1024 * 1024 });

  if (run.error) {
    return { ...identity, ...indeterminate(resolved, `the authority could not be started: ${run.error.message}`) };
  }
  if (run.signal !== null && run.signal !== undefined) {
    return {
      ...identity,
      ...indeterminate(resolved, `the authority was terminated by ${run.signal} after ${timeout}ms without concluding`),
    };
  }

  const classified = classify({ adapter, interpreter }, { exitCode: run.status, stdout: run.stdout ?? "" });

  return {
    ...identity,
    ...classified,
    invocation: { entryPoint: adapter.entryPoint, argv, cwd: packRoot },
    exitCode: run.status,
    stderr: (run.stderr ?? "").trim().slice(0, 2000) || undefined,
    hazardsMitigated: (adapter.knownHazards ?? []).map((h) => h.mitigation),
  };
}
