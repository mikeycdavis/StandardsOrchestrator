#!/usr/bin/env node
/**
 * The orchestrator, end to end.
 *
 * The pipeline, and the reason it is in this order:
 *
 *     manifest + detection  ->  applicability     which authorities are obligations here
 *     registry + ls-remote  ->  resolution        which exact release each obligation names
 *     fetch + run           ->  execution         what each authority concluded
 *     prerequisites         ->  satisfaction      whose conclusions may be relied upon
 *     the algebra           ->  the gate          whether this may merge
 *
 * Each stage may only fail closed. Nothing downstream can rescue an earlier stage: an authority that
 * could not be resolved is never executed, and an authority that could not be executed never reaches
 * the algebra as anything but a non-pass.
 *
 * Exit contract: 0 gate PASS, 1 gate failure of any kind, 2 the orchestrator itself could not run. A 2
 * is never reported as non-compliance.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./yaml.mjs";
import { loadRegistry } from "./registry.mjs";
import { loadDependencies, executionOrder, evaluateSatisfaction } from "./dependencies.mjs";
import { readDeclarations, deriveApplicability } from "./applicability.mjs";
import { detect, loadDetectors } from "./detect.mjs";
import { resolveRequirement } from "./resolve.mjs";
import { acquire, execute } from "./execute.mjs";
import { buildReport, renderReport, exitCodeFor } from "./report.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class OrchestratorError extends Error {
  constructor(message) {
    super(message);
    this.name = "OrchestratorError";
  }
}

async function readManifest(projectRoot) {
  const file = path.join(projectRoot, "standards.yml");
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    // An absent manifest is not an absent obligation. Every pack becomes UNSPECIFIED, and detection
    // then decides whether that silence is a question worth raising.
    return { manifest: { standards: {} }, manifestPath: null };
  }
  try {
    return { manifest: parseYaml(text) ?? { standards: {} }, manifestPath: file };
  } catch (error) {
    throw new OrchestratorError(`standards.yml could not be parsed: ${error.message}`);
  }
}

/**
 * Run the gate against one project.
 *
 * `workspace` is where authorities are materialised. Injectable so a test can supply already-acquired
 * packs rather than reaching the network.
 */
export async function orchestrate({ projectRoot, root = ROOT, workspace, generatedAt, acquireFn = acquire, executeFn = execute }) {
  const registry = await loadRegistry(root);
  const dependencies = await loadDependencies(registry, root);
  const detectors = await loadDetectors(root);

  const { manifest } = await readManifest(projectRoot);
  const packs = [...registry.packs.keys()];
  const declarations = readDeclarations(manifest, packs);
  const detections = await detect(projectRoot, detectors);

  const applicabilities = new Map();
  for (const pack of packs) {
    // A pack with no detector module is NO_DETECTOR, not INDETERMINATE. The first is a gap in this
    // repository's coverage; the second is a failure to look at a project. Only one of them is
    // evidence about the project.
    const detected = detections.get(pack) ?? { detection: "NO_DETECTOR", evidence: [] };
    applicabilities.set(
      pack,
      deriveApplicability({
        pack,
        declaration: declarations.get(pack).declaration,
        detection: detected.detection,
        evidence: detected.evidence,
      }),
    );
  }

  // Only authorities that are actually obligations are resolved and run. A pack whose applicability is
  // NOT_APPLICABLE is recorded and not executed; one whose applicability is unresolved or conflicting
  // is recorded, not executed, and gates.
  const records = [];
  const resolvedForExecution = new Map();

  for (const pack of packs) {
    const applicability = applicabilities.get(pack);
    const declared = declarations.get(pack);
    const base = {
      authority: declared.version ? `${pack}@${declared.version}` : pack,
      pack,
      version: declared.version,
      applicability: applicability.applicability,
      disposition: applicability.disposition,
      declaration: applicability.declaration,
      detection: applicability.detection,
      evidence: applicability.evidence,
      applicabilityRationale: applicability.rationale,
      applicabilityReason: applicability.rationale,
    };

    if (applicability.disposition !== "APPLICABLE") {
      records.push({
        ...base,
        class: applicability.disposition === "NOT_APPLICABLE" ? "PASS" : "INDETERMINATE",
        detail:
          applicability.disposition === "NOT_APPLICABLE"
            ? "not applicable; not evaluated"
            : "this authority was not run because its applicability was not established",
      });
      continue;
    }

    if (declared.version === undefined) {
      records.push({
        ...base,
        class: "UNRESOLVED",
        detail: "declared required but pinned to no version; a requirement without a pin names nothing",
      });
      continue;
    }

    const resolution = resolveRequirement(registry, { pack, version: declared.version });
    if (resolution.status !== "resolved") {
      // configuration-error and unresolved both stop here. Neither is a verdict about the project.
      records.push({
        ...base,
        class: resolution.status === "configuration-error" ? "INDETERMINATE" : "UNRESOLVED",
        resolution,
        detail: `${resolution.reasonCode}: ${resolution.detail}`,
      });
      continue;
    }
    resolvedForExecution.set(`${pack}@${declared.version}`, { ...resolution, base });
  }

  // Prerequisites first. Ordering is not evidence, but running out of order would mean an authority's
  // prerequisite had not yet produced the result its satisfaction is read from.
  const order = executionOrder(dependencies, [...resolvedForExecution.keys()]);
  const temporary = workspace === undefined;
  const dir = workspace ?? (await mkdtemp(path.join(os.tmpdir(), "so-workspace-")));

  try {
    for (const authority of order) {
      const resolution = resolvedForExecution.get(authority);
      const acquired = await acquireFn(resolution, { workspace: dir });
      if (!acquired.ok) {
        records.push({ ...resolution.base, ...acquired.failure, resolution });
        continue;
      }

      const policyPath = manifest?.policy?.[resolution.pack]
        ? path.resolve(projectRoot, manifest.policy[resolution.pack])
        : undefined;

      const executed = await executeFn(resolution, {
        projectRoot,
        policyPath,
        packRoot: acquired.packRoot,
      });
      records.push({ ...resolution.base, ...executed, resolution });
    }
  } finally {
    if (temporary) await rm(dir, { recursive: true, force: true });
  }

  const byAuthority = new Map(
    records
      .filter((r) => r.version !== undefined)
      .map((r) => [`${r.pack}@${r.version}`, { class: r.class, applicability: r.applicability }]),
  );
  // Pack-level context for messaging only. It never affects satisfaction — a prerequisite is satisfied
  // by an exact authority or not at all — but it lets an unsatisfied one say which mistake was made.
  const byPack = new Map(records.map((r) => [r.pack, { applicability: r.applicability, version: r.version }]));
  const satisfaction = evaluateSatisfaction(dependencies, byAuthority, { byPack });

  const authorities = records.map((record) => {
    const status = satisfaction.get(`${record.pack}@${record.version}`);
    return {
      ...record,
      dependencyStatus: status?.dependencyStatus,
      dependencyReason:
        status?.dependencyStatus === "unsatisfied"
          ? status.unsatisfiedBy.map((u) => `${u.authority}: ${u.because}`).join("; ")
          : undefined,
    };
  });

  return buildReport({ project: path.basename(path.resolve(projectRoot)), authorities, generatedAt });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const target = args.find((a) => !a.startsWith("--")) ?? process.cwd();

  let report;
  try {
    report = await orchestrate({ projectRoot: target, generatedAt: new Date().toISOString() });
  } catch (error) {
    // The orchestrator itself could not run. Exit 2, and say so in a way nobody can mistake for a
    // finding about the project.
    process.stderr.write(`orchestrate: ${error.message}\n`);
    process.stderr.write("This is an orchestrator fault, not a conclusion about the project.\n");
    process.exit(2);
  }

  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : renderReport(report));
  process.exit(exitCodeFor(report));
}
