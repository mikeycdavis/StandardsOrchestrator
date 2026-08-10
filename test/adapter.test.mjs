/**
 * Tests for the adapter contract and the registry.
 *
 * The organising principle under test: an adapter must be impossible to construct unless it contains
 * everything needed to establish both the pack's conclusion and that the conclusion was meaningfully
 * evaluated. Every malformed fixture below is therefore asserted to fail at LOAD, not at execution.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, cp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, resolveAdapter, adapterKey, RegistryError } from "../scripts/registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const VALID_ADAPTER = {
  pack: "betting",
  version: "9.9.9",
  repository: "https://github.com/mikeycdavis/BettingStandards.git",
  ref: "v9.9.9",
  expectedCommit: "0123456789abcdef0123456789abcdef01234567",
  tagKind: "annotated",
  binary: "standards",
  entryPoint: "scripts/standards.mjs",
  verdictCommand: "validate",
  invocation: {
    argvTemplate: ["validate", "--json", "--dir={{target}}"],
    subcommandPosition: "first",
    requiresAbsolutePolicyPath: false,
    requiresAbsoluteTarget: true,
  },
  output: { format: "json", flag: "--json", stream: "stdout", envelopeSchemaVersion: "1.0" },
  exitCodes: {
    0: { meaning: "readVerdict", note: "a conclusion was reached" },
    2: { meaning: "infrastructureFault", note: "nothing was evaluated" },
  },
  verdictSource: "topLevelStatus",
  verdictField: "status",
  packVocabulary: ["COMPLIANT", "NON_COMPLIANT"],
  verdictMap: { COMPLIANT: "PASS", NON_COMPLIANT: "FAIL" },
  interpreter: { module: "interpreters/fixture.mjs", positiveEvidence: "something was scored" },
  capabilities: { machineReadableVerdict: true, coverage: "runLevel", separateEvidenceCommand: null },
  factSource: { derivedFrom: "a fixture", derivedOn: "2026-08-10" },
};

const FIXTURE_INTERPRETER = `
export const pack = "betting";
export const version = "9.9.9";
export function readVerdict(envelope) { return envelope?.status ?? null; }
export function describeEvidence() { return "something was scored"; }
export function positiveEvidence(envelope) {
  return { satisfied: (envelope?.denominator?.scored ?? 0) > 0, detail: "fixture" };
}
export function readCoverage(envelope) { return envelope?.frameworkCoverage; }
`;

/** Build a throwaway registry root: the real schema, a declared pack, and one adapter to mutate. */
async function makeRoot({ adapter = VALID_ADAPTER, interpreter = FIXTURE_INTERPRETER, packs, filename } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "so-registry-"));
  await mkdir(path.join(dir, "schemas"), { recursive: true });
  await mkdir(path.join(dir, "registry", "interpreters"), { recursive: true });
  await cp(path.join(ROOT, "schemas", "adapter.schema.json"), path.join(dir, "schemas", "adapter.schema.json"));
  await writeFile(
    path.join(dir, "registry", "packs.json"),
    JSON.stringify(packs ?? { packs: [{ id: "betting", repository: VALID_ADAPTER.repository }] }),
    "utf8",
  );
  if (adapter !== null) {
    await writeFile(
      path.join(dir, "registry", filename ?? `${adapter.pack}-${adapter.version}.adapter.json`),
      JSON.stringify(adapter, null, 2),
      "utf8",
    );
  }
  if (interpreter !== null) {
    await writeFile(path.join(dir, "registry", "interpreters", "fixture.mjs"), interpreter, "utf8");
  }
  return dir;
}

/** Assert that a mutated adapter is rejected at load, and that the message says why. */
async function rejects(mutate, expected, options = {}) {
  const adapter = structuredClone(VALID_ADAPTER);
  mutate(adapter);
  const dir = await makeRoot({ adapter, ...options });
  try {
    await assert.rejects(() => loadRegistry(dir), RegistryError);
    const error = await loadRegistry(dir).catch((e) => e);
    assert.match(error.message, expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// The shipped registry.
// ---------------------------------------------------------------------------------------------

test("the real registry loads and validates", async () => {
  const registry = await loadRegistry();
  assert.deepEqual([...registry.adapters.keys()].sort(), ["betting@1.0.0", "prediction@1.1.0"]);
});

test("adapters exist only for releases with an established composition contract", async () => {
  // ML and Engineering are known packs with no adapter, deliberately and not as disabled placeholders.
  // Their absence is what makes "we have not established how to compose this release" expressible.
  const registry = await loadRegistry();
  assert.equal(registry.packs.has("ml"), true);
  assert.equal(registry.packs.has("engineering"), true);
  for (const key of registry.adapters.keys()) {
    assert.equal(key.startsWith("ml@"), false);
    assert.equal(key.startsWith("engineering@"), false);
  }
});

test("shipped adapters pin the dereferenced commit, not the tag object", async () => {
  // The tag object for BettingStandards v1.0.0 is f47bdf7; the commit it dereferences to is a4e7e68.
  // Recording the tag object would break on a re-annotation that changed no code.
  const registry = await loadRegistry();
  assert.equal(
    registry.adapters.get("betting@1.0.0").adapter.expectedCommit,
    "a4e7e680ca9213d6bf9f5042a3ae7fd7383b7545",
  );
  assert.equal(
    registry.adapters.get("prediction@1.1.0").adapter.expectedCommit,
    "ebe232bb52cd4b97b5ff3d53c52d6fd344fa3159",
  );
});

test("shipped adapters agree with nothing inferred from each other", async () => {
  // The divergence is the whole reason adapters are per (pack, version). If these ever match, someone
  // has homogenised one pack's contract into the other's shape.
  const registry = await loadRegistry();
  const betting = registry.adapters.get("betting@1.0.0").adapter;
  const prediction = registry.adapters.get("prediction@1.1.0").adapter;

  assert.notEqual(betting.binary, prediction.binary);
  assert.notEqual(betting.verdictCommand, prediction.verdictCommand);
  assert.notEqual(betting.verdictSource, prediction.verdictSource);
  assert.deepEqual(
    betting.packVocabulary.filter((v) => prediction.packVocabulary.includes(v)).sort(),
    ["BLOCKED_BY_INVARIANT", "NOT_EVALUATED"],
    "the two vocabularies overlap only on the two terms both packs genuinely share",
  );
});

test("every shipped adapter declares a pack-specific evidence gate backed by loadable code", async () => {
  const registry = await loadRegistry();
  for (const [key, { adapter, interpreter }] of registry.adapters) {
    assert.equal(typeof adapter.interpreter.positiveEvidence, "string", `${key} states its gate`);
    assert.equal(typeof interpreter.positiveEvidence, "function", `${key} implements its gate`);
    assert.notEqual(interpreter.describeEvidence(), "", `${key} describes its gate`);
  }

  // The gates are genuinely different, which is the point: "meaningfully evaluated" is not one concept.
  const betting = registry.adapters.get("betting@1.0.0").interpreter.describeEvidence();
  const prediction = registry.adapters.get("prediction@1.1.0").interpreter.describeEvidence();
  assert.notEqual(betting, prediction);
});

// ---------------------------------------------------------------------------------------------
// Representability: an incomplete adapter must not load.
// ---------------------------------------------------------------------------------------------

test("a fully specified adapter loads", async () => {
  const dir = await makeRoot();
  try {
    const registry = await loadRegistry(dir);
    assert.equal(registry.adapters.size, 1);
    assert.equal(registry.adapters.has(adapterKey("betting", "9.9.9")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("REJECTED AT LOAD: each required field, one at a time", async () => {
  const required = [
    "pack",
    "version",
    "repository",
    "ref",
    "expectedCommit",
    "tagKind",
    "binary",
    "entryPoint",
    "verdictCommand",
    "invocation",
    "output",
    "exitCodes",
    "verdictSource",
    "packVocabulary",
    "verdictMap",
    "interpreter",
    "capabilities",
    "factSource",
  ];

  for (const field of required) {
    const adapter = structuredClone(VALID_ADAPTER);
    delete adapter[field];
    // The filename is fixed rather than derived, so deleting `pack` or `version` is genuinely tested
    // instead of being quietly restored by the file-naming convention.
    const dir = await makeRoot({ adapter, filename: "betting-9.9.9.adapter.json" });
    try {
      await assert.rejects(
        () => loadRegistry(dir),
        RegistryError,
        `an adapter missing '${field}' must not load`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("REJECTED AT LOAD: a malformed exact version", async () => {
  await rejects((a) => {
    a.version = "1.x";
  }, /schema/);
});

test("REJECTED AT LOAD: an expectedCommit that is not a full SHA", async () => {
  // An abbreviated SHA is ambiguous, and ambiguity in a supply-chain control is not a shortcut.
  await rejects((a) => {
    a.expectedCommit = "a4e7e68";
  }, /schema/);
});

test("REJECTED AT LOAD: a verdictMap that does not cover the documented vocabulary", async () => {
  await rejects((a) => {
    a.packVocabulary.push("COMPLIANT_WITH_EXCEPTIONS");
  }, /does not cover the documented term 'COMPLIANT_WITH_EXCEPTIONS'/);
});

test("REJECTED AT LOAD: a verdictMap term that is not in the documented vocabulary", async () => {
  // The other direction. A mapping for a term the release does not emit is a guess about a contract
  // nobody read, and it would silently become live if that term ever appeared.
  await rejects((a) => {
    a.verdictMap.SUPPORTED = "PASS";
  }, /maps 'SUPPORTED', which is not in packVocabulary/);
});

test("REJECTED AT LOAD: a verdictMap that maps nothing to PASS", async () => {
  await rejects((a) => {
    a.verdictMap.COMPLIANT = "INDETERMINATE";
  }, /could never report success/);
});

test("REJECTED AT LOAD: a verdictMap value outside the outcome classes", async () => {
  // UNRESOLVED and CONFLICT are orchestrator states. No pack can conclude either about itself, and
  // letting an adapter claim otherwise would let a pack's output masquerade as a resolution result.
  await rejects((a) => {
    a.verdictMap.COMPLIANT = "UNRESOLVED";
  }, /schema/);
});

test("REJECTED AT LOAD: no exit code yields a verdict", async () => {
  await rejects((a) => {
    a.exitCodes = { 2: { meaning: "infrastructureFault", note: "nothing" } };
  }, /no exit code from which a verdict may be read/);
});

test("REJECTED AT LOAD: topLevelStatus without a verdictField", async () => {
  await rejects((a) => {
    delete a.verdictField;
  }, /no verdictField is declared/);
});

test("REJECTED AT LOAD: moduleDerived with a stray verdictField", async () => {
  await rejects((a) => {
    a.verdictSource = "moduleDerived";
  }, /verdictField would be ignored/);
});

test("REJECTED AT LOAD: an invocation that never passes its required absolute target", async () => {
  await rejects((a) => {
    a.invocation.argvTemplate = ["validate", "--json"];
  }, /never passes \{\{target\}\}/);
});

test("REJECTED AT LOAD: an invocation that never passes its required absolute policy path", async () => {
  await rejects((a) => {
    a.invocation.requiresAbsolutePolicyPath = true;
  }, /never passes \{\{policy\}\}/);
});

test("REJECTED AT LOAD: an unknown placeholder", async () => {
  await rejects((a) => {
    a.invocation.argvTemplate.push("--as-of={{now}}");
  }, /unknown placeholder \{\{now\}\}/);
});

test("REJECTED AT LOAD: subcommandPosition disagrees with argvTemplate", async () => {
  await rejects((a) => {
    a.invocation.argvTemplate = ["--json", "validate", "--dir={{target}}"];
  }, /argvTemplate begins with '--json'/);
});

test("REJECTED AT LOAD: a release with no machine-readable verdict", async () => {
  await rejects((a) => {
    a.capabilities.machineReadableVerdict = false;
  }, /cannot be adapted/);
});

test("REJECTED AT LOAD: a missing interpreter module", async () => {
  const dir = await makeRoot({ interpreter: null });
  try {
    await assert.rejects(() => loadRegistry(dir), /could not be loaded/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("REJECTED AT LOAD: an interpreter missing any one of its four exports", async () => {
  for (const missing of ["readVerdict", "positiveEvidence", "describeEvidence", "readCoverage"]) {
    const source = FIXTURE_INTERPRETER.replace(new RegExp(`export function ${missing}\\b`), "function unused_x");
    assert.notEqual(source, FIXTURE_INTERPRETER, `the mutation for ${missing} must apply`);
    const dir = await makeRoot({ interpreter: source });
    try {
      await assert.rejects(() => loadRegistry(dir), new RegExp(`does not export ${missing}\\(\\)`));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

test("REJECTED AT LOAD: an interpreter written for a different release", async () => {
  // The failure this prevents is the quiet one: reusing last version's interpreter for a new version
  // is exactly how an unread contract becomes live.
  const dir = await makeRoot({ interpreter: FIXTURE_INTERPRETER.replace('"9.9.9"', '"9.9.8"') });
  try {
    await assert.rejects(() => loadRegistry(dir), /interpreter declares betting@9\.9\.8/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("REJECTED AT LOAD: a filename that disagrees with the adapter's own identity", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "so-registry-"));
  try {
    await mkdir(path.join(dir, "schemas"), { recursive: true });
    await mkdir(path.join(dir, "registry", "interpreters"), { recursive: true });
    await cp(path.join(ROOT, "schemas", "adapter.schema.json"), path.join(dir, "schemas", "adapter.schema.json"));
    await writeFile(
      path.join(dir, "registry", "packs.json"),
      JSON.stringify({ packs: [{ id: "betting", repository: VALID_ADAPTER.repository }] }),
      "utf8",
    );
    await writeFile(path.join(dir, "registry", "interpreters", "fixture.mjs"), FIXTURE_INTERPRETER, "utf8");
    await writeFile(
      path.join(dir, "registry", "betting-1.0.0.adapter.json"),
      JSON.stringify(VALID_ADAPTER),
      "utf8",
    );
    await assert.rejects(() => loadRegistry(dir), /declares betting@9\.9\.9 but is named/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("REJECTED AT LOAD: an adapter for a pack that is not declared", async () => {
  await rejects(
    (a) => {
      a.repository = "https://github.com/mikeycdavis/MathematicalStandards.git";
    },
    /repository disagrees/,
  );

  const dir = await makeRoot({ packs: { packs: [{ id: "prediction", repository: "x" }] } });
  try {
    await assert.rejects(() => loadRegistry(dir), /not in registry\/packs\.json/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("REJECTED AT LOAD: an interpreter path escaping the registry", async () => {
  await rejects((a) => {
    a.interpreter.module = "../scripts/interpret.mjs";
  }, /escapes the registry directory/);
});

// ---------------------------------------------------------------------------------------------
// The three-way lookup.
// ---------------------------------------------------------------------------------------------

test("LOOKUP: known pack at a supported release yields the adapter", async () => {
  const registry = await loadRegistry();
  const found = resolveAdapter(registry, "betting", "1.0.0");
  assert.equal(found.status, "ok");
  assert.equal(found.adapter.ref, "v1.0.0");
});

test("LOOKUP: known pack at an unsupported release is distinguishable from an unknown pack", async () => {
  const registry = await loadRegistry();

  // "We have not established how to compose that release." Remedy: derive an adapter.
  const unsupported = resolveAdapter(registry, "prediction", "1.0.0");
  assert.equal(unsupported.status, "unsupported-release");
  assert.deepEqual(unsupported.supportedVersions, ["1.1.0"]);

  // "No such standards authority is known here." Remedy: fix the manifest, or declare the pack.
  const unknown = resolveAdapter(registry, "predicton", "1.1.0");
  assert.equal(unknown.status, "unknown-pack");
  assert.equal(unknown.knownPacks.includes("prediction"), true);

  assert.notEqual(unsupported.status, unknown.status, "the two must never collapse into one state");
});

test("LOOKUP: a known pack with no adapter at all says so specifically", async () => {
  const registry = await loadRegistry();
  const engineering = resolveAdapter(registry, "engineering", "2.0.0");
  assert.equal(engineering.status, "unsupported-release");
  assert.deepEqual(engineering.supportedVersions, []);
  assert.match(engineering.detail, /no release of 'engineering' has an established composition contract/);
});

test("LOOKUP: never falls back to a neighbouring or newer version", async () => {
  const registry = await loadRegistry();
  for (const version of ["1.0.1", "1.2.0", "0.9.0", "1.1.0-rc.1"]) {
    const found = resolveAdapter(registry, "betting", version);
    assert.notEqual(found.status, "ok", `betting@${version} must not resolve to the 1.0.0 adapter`);
  }
});
