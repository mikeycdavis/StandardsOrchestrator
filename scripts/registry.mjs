/**
 * The adapter registry: loading, validation, and lookup.
 *
 * THE REPRESENTABILITY PRINCIPLE. An adapter must be impossible to construct unless it contains
 * everything needed to establish both the pack's conclusion AND that the conclusion was meaningfully
 * evaluated. Every check below therefore runs at LOAD time, not at execution time. An adapter missing
 * its evidence gate, or mapping a vocabulary it does not fully cover, is not a run that fails later —
 * it is a registry that will not load at all. Deferring these to execution would mean discovering the
 * contract was incomplete only after a project was already being graded against it.
 *
 * THE THREE-WAY LOOKUP. Resolution must distinguish:
 *
 *     known pack + supported exact release   → an adapter exists
 *     known pack + unsupported release       → UNRESOLVED
 *     unknown pack                           → a registry or manifest error
 *
 * The middle case says "we have not established how to compose that release". The last says "no such
 * standards authority is known here". Collapsing them would let a typo in a project's manifest read as
 * an unsupported version, and let a genuinely unsupported release read as a nonexistent authority —
 * two different people fixing two different things.
 *
 * There are deliberately no adapters for packs whose releases are not fetchable, not even disabled
 * placeholders. The absence of a file is the evidence, and a placeholder would convert "no composition
 * contract has been established" into something that looks like a contract switched off.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { validate as validateSchema, assertSchemaSupported } from "./jsonschema.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Placeholders the orchestrator knows how to substitute. An unknown one is an unrunnable adapter. */
const PLACEHOLDERS = new Set(["target", "policy"]);

/** The interpreter contract. All four are required; a partial interpreter is not an adapter. */
const INTERPRETER_EXPORTS = ["readVerdict", "positiveEvidence", "describeEvidence", "readCoverage"];

export class RegistryError extends Error {
  constructor(message) {
    super(message);
    this.name = "RegistryError";
  }
}

export const adapterKey = (pack, version) => `${pack}@${version}`;

async function readJson(file, what) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw new RegistryError(`${what} could not be read: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new RegistryError(`${what} is not valid JSON: ${error.message}`);
  }
}

/**
 * Checks that the schema cannot express, because they are relationships between fields rather than
 * shapes of fields. Each one exists because getting it wrong would produce a confident wrong reading
 * rather than an obvious error.
 */
async function validateAdapter(adapter, file, packs, registryDir) {
  const where = path.basename(file);
  const fail = (message) => {
    throw new RegistryError(`${where}: ${message}`);
  };

  const expectedName = `${adapter.pack}-${adapter.version}.adapter.json`;
  if (where !== expectedName) fail(`declares ${adapterKey(adapter.pack, adapter.version)} but is named ${where}`);

  const known = packs.get(adapter.pack);
  if (known === undefined) {
    fail(`names pack '${adapter.pack}', which is not in registry/packs.json`);
  }
  if (known.repository !== adapter.repository) {
    fail(`repository disagrees with registry/packs.json for pack '${adapter.pack}'`);
  }

  // The exhaustiveness check. A term the upstream release documents but the map omits would otherwise
  // arrive at execution time as an unrecognised string — caught, but caught late and in production.
  const vocabulary = new Set(adapter.packVocabulary);
  if (vocabulary.size !== adapter.packVocabulary.length) fail("packVocabulary contains a duplicate");
  const mapped = new Set(Object.keys(adapter.verdictMap));
  for (const term of vocabulary) {
    if (!mapped.has(term)) fail(`verdictMap does not cover the documented term '${term}'`);
  }
  for (const term of mapped) {
    if (!vocabulary.has(term)) fail(`verdictMap maps '${term}', which is not in packVocabulary`);
  }
  if (!Object.values(adapter.verdictMap).includes("PASS")) {
    fail("no vocabulary term maps to PASS, so this adapter could never report success");
  }

  if (adapter.verdictSource === "topLevelStatus" && adapter.verdictField === undefined) {
    fail("verdictSource is topLevelStatus but no verdictField is declared");
  }
  if (adapter.verdictSource === "moduleDerived" && adapter.verdictField !== undefined) {
    fail("verdictSource is moduleDerived, so verdictField would be ignored; remove it");
  }

  const meanings = Object.values(adapter.exitCodes).map((e) => e.meaning);
  if (meanings.length === 0) fail("declares no exit codes");
  if (!meanings.includes("readVerdict")) {
    fail("declares no exit code from which a verdict may be read");
  }

  const { argvTemplate, subcommandPosition, requiresAbsolutePolicyPath, requiresAbsoluteTarget } =
    adapter.invocation;
  if (subcommandPosition === "first" && argvTemplate[0] !== adapter.verdictCommand) {
    fail(`subcommandPosition is 'first' but argvTemplate begins with '${argvTemplate[0]}'`);
  }
  const used = new Set();
  for (const argument of argvTemplate) {
    for (const match of argument.matchAll(/\{\{([a-zA-Z]+)\}\}/g)) {
      if (!PLACEHOLDERS.has(match[1])) fail(`argvTemplate uses unknown placeholder {{${match[1]}}}`);
      used.add(match[1]);
    }
  }
  if (requiresAbsoluteTarget && !used.has("target")) {
    fail("requiresAbsoluteTarget is true but argvTemplate never passes {{target}}");
  }
  if (requiresAbsolutePolicyPath && !used.has("policy")) {
    fail("requiresAbsolutePolicyPath is true but argvTemplate never passes {{policy}}");
  }

  if (!adapter.capabilities.machineReadableVerdict) {
    fail("declares no machine-readable verdict; such a release cannot be adapted, only read by a human");
  }

  // The evidence gate must be loadable code, not a promise that code exists somewhere.
  const modulePath = path.resolve(registryDir, adapter.interpreter.module);
  if (!modulePath.startsWith(registryDir + path.sep)) {
    fail("interpreter.module escapes the registry directory");
  }
  let interpreter;
  try {
    interpreter = await import(pathToFileURL(modulePath).href);
  } catch (error) {
    fail(`interpreter ${adapter.interpreter.module} could not be loaded: ${error.message}`);
  }
  for (const name of INTERPRETER_EXPORTS) {
    if (typeof interpreter[name] !== "function") {
      fail(`interpreter ${adapter.interpreter.module} does not export ${name}()`);
    }
  }
  if (interpreter.pack !== adapter.pack || interpreter.version !== adapter.version) {
    fail(
      `interpreter declares ${adapterKey(interpreter.pack, interpreter.version)} but the adapter is ` +
        `${adapterKey(adapter.pack, adapter.version)}`,
    );
  }

  return interpreter;
}

/**
 * Load and fully validate the registry. Throws RegistryError on the first problem — a registry that is
 * partly valid is not usable, and continuing would mean composing authorities from an incomplete
 * contract.
 */
export async function loadRegistry(root = ROOT) {
  const registryDir = path.resolve(root, "registry");
  const schema = await readJson(path.join(root, "schemas", "adapter.schema.json"), "the adapter schema");
  assertSchemaSupported(schema);

  const packsDocument = await readJson(path.join(registryDir, "packs.json"), "registry/packs.json");
  const packs = new Map();
  for (const entry of packsDocument.packs ?? []) {
    if (packs.has(entry.id)) throw new RegistryError(`registry/packs.json lists '${entry.id}' twice`);
    packs.set(entry.id, entry);
  }
  if (packs.size === 0) throw new RegistryError("registry/packs.json lists no packs");

  let files;
  try {
    files = (await readdir(registryDir)).filter((f) => f.endsWith(".adapter.json")).sort();
  } catch (error) {
    throw new RegistryError(`the registry directory could not be read: ${error.message}`);
  }

  const adapters = new Map();
  for (const name of files) {
    const file = path.join(registryDir, name);
    const adapter = await readJson(file, `registry/${name}`);

    const errors = validateSchema(adapter, schema);
    if (errors.length > 0) {
      const detail = errors.map((e) => `  ${e.path || "(root)"}: ${e.message}`).join("\n");
      throw new RegistryError(`registry/${name} does not satisfy the adapter schema:\n${detail}`);
    }

    const interpreter = await validateAdapter(adapter, file, packs, registryDir);

    const key = adapterKey(adapter.pack, adapter.version);
    if (adapters.has(key)) throw new RegistryError(`two adapters declare ${key}`);
    adapters.set(key, { adapter, interpreter });
  }

  return { packs, adapters };
}

/**
 * Look up the adapter for an exact (pack, version).
 *
 * Never falls back to a neighbouring version, a newest version, or a range. `status` distinguishes the
 * three cases above so the caller can produce the right outcome class and, more importantly, tell
 * someone the right thing to fix.
 */
export function resolveAdapter(registry, pack, version) {
  if (!registry.packs.has(pack)) {
    return {
      status: "unknown-pack",
      pack,
      version,
      knownPacks: [...registry.packs.keys()],
      detail: `'${pack}' is not a known standards authority`,
    };
  }

  const entry = registry.adapters.get(adapterKey(pack, version));
  if (entry !== undefined) {
    return { status: "ok", pack, version, adapter: entry.adapter, interpreter: entry.interpreter };
  }

  const supported = [...registry.adapters.values()]
    .filter((e) => e.adapter.pack === pack)
    .map((e) => e.adapter.version);

  return {
    status: "unsupported-release",
    pack,
    version,
    supportedVersions: supported,
    detail:
      supported.length === 0
        ? `no release of '${pack}' has an established composition contract`
        : `${adapterKey(pack, version)} has no adapter (established: ${supported.join(", ")})`,
  };
}
