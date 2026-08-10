/**
 * Tests for the authority-boundary check.
 *
 * The important test is the planted one. A boundary check that has never been shown to fire is a
 * check nobody should trust — and this particular check guards the property that distinguishes this
 * repository from the eight it composes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkBoundary } from "../scripts/boundary.mjs";

test("this repository does not contain a domain requirement", async () => {
  const violations = await checkBoundary();
  assert.deepEqual(violations, [], `the orchestrator has started reasoning about a domain:\n${JSON.stringify(violations, null, 2)}`);
});

test("PLANTED: a domain rule in rules/ is caught", async () => {
  // The mutation. If this ever stops failing, the boundary is unguarded and the next domain rule
  // someone adds "just for convenience" will land silently.
  const dir = await mkdtemp(path.join(os.tmpdir(), "so-boundary-"));
  try {
    await mkdir(path.join(dir, "rules"), { recursive: true });
    await writeFile(
      path.join(dir, "rules", "betting.json"),
      JSON.stringify({
        rules: [
          {
            id: "betting.no-martingale",
            description: "No staking scheme increases the stake after a loss to recover it.",
          },
        ],
      }),
      "utf8",
    );

    const violations = await checkBoundary(dir);
    assert.ok(violations.length > 0, "a domain rule planted in rules/ must be caught");
    assert.ok(violations.some((v) => v.concept === "martingale"));
    assert.ok(violations.every((v) => v.file.startsWith("rules/")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an adapter naming its pack is NOT a violation", async () => {
  // The carve-out that makes the check usable. An adapter must name the pack it points at; that is
  // identity, not the orchestrator reasoning about the subject. Without this, every adapter would
  // trip the boundary and the check would be disabled within a week.
  const dir = await mkdtemp(path.join(os.tmpdir(), "so-boundary-"));
  try {
    await mkdir(path.join(dir, "registry"), { recursive: true });
    await writeFile(
      path.join(dir, "registry", "betting-1.0.0.adapter.json"),
      JSON.stringify({
        pack: "betting",
        version: "1.0.0",
        repository: "https://github.com/mikeycdavis/BettingStandards.git",
        ref: "v1.0.0",
        binary: "standards",
        verdictCommand: "validate",
      }),
      "utf8",
    );

    assert.deepEqual(await checkBoundary(dir), [], "naming the pack in identity fields must be allowed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a domain concept smuggled into an adapter's non-identity field IS caught", async () => {
  // The other half of the carve-out: identity fields are masked, everything else is still scanned.
  const dir = await mkdtemp(path.join(os.tmpdir(), "so-boundary-"));
  try {
    await mkdir(path.join(dir, "registry"), { recursive: true });
    await writeFile(
      path.join(dir, "registry", "bad.adapter.json"),
      JSON.stringify({
        pack: "betting",
        version: "1.0.0",
        rationale: "Fails the run when the kelly fraction exceeds the declared bankroll cap.",
      }),
      "utf8",
    );

    const violations = await checkBoundary(dir);
    assert.ok(violations.length > 0, "a domain judgement in an adapter must be caught");
    assert.ok(violations.some((v) => v.concept === "kelly" || v.concept === "bankroll"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PLANTED: a detector that reaches a conclusion is caught", async () => {
  // Detectors are the one place domain vocabulary is unavoidable, so they live outside the normative
  // directories and are guarded by the opposite rule instead: a detector produces evidence, never a
  // conclusion. Without this, "detectors" would be the obvious place to relocate domain judgement to.
  const dir = await mkdtemp(path.join(os.tmpdir(), "so-boundary-"));
  try {
    await mkdir(path.join(dir, "detectors"), { recursive: true });
    await writeFile(
      path.join(dir, "detectors", "betting.mjs"),
      [
        "export const pack = 'betting';",
        "export const signals = [];",
        "export function decide(hits) { return hits.length > 0 ? 'FAIL' : 'PASS'; }",
      ].join("\n"),
      "utf8",
    );

    const violations = await checkBoundary(dir);
    assert.ok(violations.length > 0, "a detector that concludes must be caught");
    assert.ok(violations.every((v) => v.kind === "detector-concludes"));
    assert.ok(violations.some((v) => v.concept === "PASS"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a detector naming domain vocabulary is NOT a violation", async () => {
  // The carve-out that makes detection possible at all. Describing what a signal looks like requires
  // naming the subject; it carries no normative weight and decides nothing.
  const dir = await mkdtemp(path.join(os.tmpdir(), "so-boundary-"));
  try {
    await mkdir(path.join(dir, "detectors"), { recursive: true });
    await writeFile(
      path.join(dir, "detectors", "betting.mjs"),
      [
        "export const pack = 'betting';",
        "export const signals = [",
        "  { id: 'stake-sizing-computation', basis: 'a kelly fraction computed against a bankroll' },",
        "];",
      ].join("\n"),
      "utf8",
    );

    assert.deepEqual(await checkBoundary(dir), [], "a detector must be able to describe its subject");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("documentation may discuss domains freely", async () => {
  // design/ and docs/ are not scanned. The file explaining why betting rules do not belong here has
  // to be able to say the word "betting".
  const dir = await mkdtemp(path.join(os.tmpdir(), "so-boundary-"));
  try {
    await mkdir(path.join(dir, "design"), { recursive: true });
    await writeFile(
      path.join(dir, "design", "authority-boundary.md"),
      "No rule about a wager, a bankroll, or a kelly fraction belongs in this repository.",
      "utf8",
    );

    assert.deepEqual(await checkBoundary(dir), [], "documentation must be able to name what it excludes");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
