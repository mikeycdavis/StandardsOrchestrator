/**
 * Tests for applicability.
 *
 * The property being defended: neither evidence source may unilaterally decide. Detection cannot waive
 * a declaration, a declaration cannot suppress a detection, and where neither establishes anything the
 * answer is that nothing was established — not that the authority does not apply.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  deriveApplicability,
  readDeclarations,
  renderApplicability,
  DECLARATIONS,
  DETECTIONS,
  ApplicabilityError,
} from "../scripts/applicability.mjs";
import { detect, loadDetectors } from "../scripts/detect.mjs";
import { aggregate } from "../scripts/outcome.mjs";

const detectors = await loadDetectors();

async function makeProject(files) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "so-project-"));
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

const cleanup = [];
test.after(async () => {
  for (const dir of cleanup) await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// The nine cells.
// ---------------------------------------------------------------------------------------------

test("EXHAUSTIVE: the full declaration x detection table", () => {
  const expected = {
    "REQUIRED/DETECTED": ["APPLICABLE", "CONFIRMED"],
    "REQUIRED/NOT_DETECTED": ["APPLICABLE", "DECLARED_ONLY"],
    "REQUIRED/INDETERMINATE": ["APPLICABLE", "DECLARED_ONLY"],
    "NOT_APPLICABLE/DETECTED": ["CONFLICT", "CONFLICT"],
    "NOT_APPLICABLE/NOT_DETECTED": ["NOT_APPLICABLE", "NOT_APPLICABLE"],
    "NOT_APPLICABLE/INDETERMINATE": ["CONFLICT", "CONFLICT"],
    "UNSPECIFIED/DETECTED": ["CONFLICT", "CONFLICT"],
    "UNSPECIFIED/NOT_DETECTED": ["UNRESOLVED", "UNRESOLVED"],
    "UNSPECIFIED/INDETERMINATE": ["UNRESOLVED", "UNRESOLVED"],
  };

  let checked = 0;
  for (const declaration of DECLARATIONS) {
    for (const detection of DETECTIONS) {
      const result = deriveApplicability({ pack: "betting", declaration, detection });
      const [disposition, applicability] = expected[`${declaration}/${detection}`];
      assert.equal(result.disposition, disposition, `${declaration}/${detection} disposition`);
      assert.equal(result.applicability, applicability, `${declaration}/${detection} applicability`);
      checked += 1;
    }
  }
  assert.equal(checked, 9);
});

test("both evidence sources are preserved verbatim beside the derivation", () => {
  // The disposition is derived beside the inputs, never in place of them, so a reader can disagree
  // with the derivation without re-running anything.
  const evidence = [{ signal: "order-placement-call", location: "a.py:12" }];
  const result = deriveApplicability({
    pack: "betting",
    declaration: "NOT_APPLICABLE",
    detection: "DETECTED",
    evidence,
  });
  assert.equal(result.declaration, "NOT_APPLICABLE");
  assert.equal(result.detection, "DETECTED");
  assert.equal(result.evidence, evidence);
});

test("a declared requirement is never downgraded by detection", () => {
  // A project may hold itself to a stronger authority than any detector can see. Detector recall is
  // not a waiver mechanism, so the disagreement is recorded and the pack still runs.
  for (const detection of ["NOT_DETECTED", "INDETERMINATE"]) {
    const result = deriveApplicability({ pack: "betting", declaration: "REQUIRED", detection });
    assert.equal(result.disposition, "APPLICABLE", detection);
  }
  assert.equal(
    deriveApplicability({ pack: "betting", declaration: "REQUIRED", detection: "NOT_DETECTED" })
      .detectionDisagreement,
    true,
    "the disagreement is recorded rather than discarded",
  );
});

test("ADVERSARIAL: a declaration cannot suppress a detection", () => {
  const result = deriveApplicability({ pack: "betting", declaration: "NOT_APPLICABLE", detection: "DETECTED" });
  assert.equal(result.disposition, "CONFLICT");
  assert.match(result.rationale, /Neither side wins/);
});

test("ADVERSARIAL: silence is not a determination that an authority does not apply", () => {
  // Otherwise omitting a pack from the manifest would be the cheapest possible way past a gate.
  const result = deriveApplicability({ pack: "betting", declaration: "UNSPECIFIED", detection: "NOT_DETECTED" });
  assert.equal(result.disposition, "UNRESOLVED");
  assert.notEqual(result.disposition, "NOT_APPLICABLE");
  assert.notEqual(result.applicability, "NOT_APPLICABLE");
});

test("ADVERSARIAL: a broken detector is not a route out of a gate", () => {
  // Declared not-applicable while detection could not run: nothing corroborates the declaration.
  const result = deriveApplicability({
    pack: "betting",
    declaration: "NOT_APPLICABLE",
    detection: "INDETERMINATE",
  });
  assert.equal(result.disposition, "CONFLICT");
});

test("an unknown declaration or detection is rejected rather than defaulted", () => {
  assert.throws(() => deriveApplicability({ pack: "x", declaration: "MAYBE", detection: "DETECTED" }), ApplicabilityError);
  assert.throws(() => deriveApplicability({ pack: "x", declaration: "REQUIRED", detection: "PROBABLY" }), ApplicabilityError);
  assert.throws(() => deriveApplicability({ pack: "", declaration: "REQUIRED", detection: "DETECTED" }), ApplicabilityError);
});

// ---------------------------------------------------------------------------------------------
// The manifest.
// ---------------------------------------------------------------------------------------------

test("a pack absent from the manifest is UNSPECIFIED, never NOT_APPLICABLE", () => {
  const declarations = readDeclarations({ standards: { betting: { required: true, version: "1.0.0" } } }, [
    "betting",
    "prediction",
  ]);
  assert.equal(declarations.get("betting").declaration, "REQUIRED");
  assert.equal(declarations.get("prediction").declaration, "UNSPECIFIED");
});

test("an entry that exists but does not say is UNSPECIFIED", () => {
  const declarations = readDeclarations({ standards: { betting: { version: "1.0.0" } } }, ["betting"]);
  assert.equal(declarations.get("betting").declaration, "UNSPECIFIED");
  assert.equal(declarations.get("betting").version, "1.0.0");
});

test("required: false is a decision someone made, and reads as one", () => {
  const declarations = readDeclarations({ standards: { betting: { required: false } } }, ["betting"]);
  assert.equal(declarations.get("betting").declaration, "NOT_APPLICABLE");
});

// ---------------------------------------------------------------------------------------------
// Detection is structural, not lexical.
// ---------------------------------------------------------------------------------------------

test("ADVERSARIAL: self-referential vocabulary does not constitute a signal", async () => {
  // A repository is allowed to discuss betting at length precisely because its documentation explains
  // that it does NOT place bets. A detector that fired on this would teach people to ignore it.
  const dir = await makeProject({
    "README.md": "This project models odds and expected value. It never places a wager of any kind.",
    "docs/policy.md": "No Kelly sizing is performed here. BettingStandards does not apply to this repository.",
    "src/notes.py": [
      "# We deliberately do not place orders. No bankroll, no Kelly fraction, no sportsbook client.",
      "# See docs/policy.md. The words 'bet', 'odds', and 'stake' appear here only in explanation.",
      "def summarise_odds(rows):",
      "    return {'note': 'display only; nothing is wagered'}",
    ].join("\n"),
  });
  cleanup.push(dir);

  const results = await detect(dir, detectors);
  assert.equal(results.get("betting").detection, "NOT_DETECTED");
  assert.deepEqual(results.get("betting").evidence, []);
});

test("a structural signal is detected, with inspectable evidence", async () => {
  const dir = await makeProject({
    "src/client.py": [
      "import requests",
      "",
      "def place(order):",
      "    return session.post('https://api.example.com/portfolio/orders', json=order)",
    ].join("\n"),
  });
  cleanup.push(dir);

  const results = await detect(dir, detectors);
  const betting = results.get("betting");
  assert.equal(betting.detection, "DETECTED");
  assert.equal(betting.evidence.length, 1);

  const [entry] = betting.evidence;
  assert.equal(entry.signal, "order-placement-call");
  assert.equal(entry.location, "src/client.py:4");
  assert.equal(entry.detector, "detectors/betting.mjs");
  assert.match(entry.basis, /submits an order/);
  assert.equal(entry.confidence, "high");
  assert.match(entry.matched, /portfolio\/orders/);
});

test("REGRESSION: a private transport wrapper is still an order-placement call", async () => {
  // Found by running the detectors over a real portfolio: the first version of this signal matched
  // four call sites in a test file and missed the production one, because the client wraps its
  // transport as `self._post(path, payload)`. A private-method convention is the normal shape for
  // exactly the code most worth detecting, and the near-miss is the useful part — the fixture would
  // have looked green while the true positive went unseen.
  const dir = await makeProject({
    "src/client.py": [
      "class Client:",
      "    async def place_order(self, payload):",
      '        return await self._post("/portfolio/orders", payload)',
    ].join("\n"),
    "tests/test_client.py": 'r = await client._post("/portfolio/orders", {})',
  });
  cleanup.push(dir);

  const results = await detect(dir, detectors);
  const locations = results.get("betting").evidence.map((e) => e.location);
  assert.equal(results.get("betting").detection, "DETECTED");
  assert.equal(locations.includes("src/client.py:3"), true, "the production call site must be found");
});

test("repeated matches in one file collapse to one entry that reports the count", async () => {
  // A reviewer needs to know where to look, not to read the same line forty times. The count is
  // carried rather than dropped, so a collapsed set never reads as a smaller finding than it is.
  const dir = await makeProject({
    "src/client.py": Array.from({ length: 4 }, () => 'session.post("/orders", o)').join("\n"),
  });
  cleanup.push(dir);

  const evidence = (await detect(dir, detectors)).get("betting").evidence;
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].occurrences, 4);
  assert.equal(evidence[0].location, "src/client.py:1");
});

test("evidence carries a qualitative confidence that is never a threshold", async () => {
  // Confidence exists to inform a reader. Making it numeric would put human judgement behind a
  // decimal, where 0.91 and 0.89 would mean opposite things for no defensible reason.
  for (const detector of detectors.values()) {
    for (const signal of detector.signals) {
      assert.equal(typeof signal.confidence, "string", `${signal.id} confidence must not be numeric`);
      assert.equal(Number.isFinite(Number(signal.confidence)), false, `${signal.id} must not parse as a number`);
    }
  }
});

test("a detector reports evidence and never a disposition", async () => {
  // The structural form of "detection is evidence, not a verdict": there is no field a detector could
  // set that would decide anything.
  const dir = await makeProject({
    "src/client.py": "session.post('https://api.example.com/orders', json=o)",
  });
  cleanup.push(dir);
  const results = await detect(dir, detectors);
  for (const entry of results.get("betting").evidence) {
    for (const forbidden of ["disposition", "applicable", "applicability", "outcome", "verdict"]) {
      assert.equal(forbidden in entry, false, `evidence must not carry '${forbidden}'`);
    }
  }
});

test("prediction signals are independent of betting signals", async () => {
  const dir = await makeProject({
    "src/model.py": "probs = model.predict_proba(features)",
  });
  cleanup.push(dir);

  const results = await detect(dir, detectors);
  assert.equal(results.get("prediction").detection, "DETECTED");
  assert.equal(results.get("betting").detection, "NOT_DETECTED");
});

test("a tree with nothing a detector can read is INDETERMINATE, not NOT_DETECTED", async () => {
  // Reporting a failure to look as a finding of absence is the same error as reporting an unreachable
  // remote as a missing release.
  const dir = await makeProject({ "README.md": "prose only", "data/values.csv": "a,b\n1,2\n" });
  cleanup.push(dir);

  const results = await detect(dir, detectors);
  for (const pack of ["betting", "prediction"]) {
    assert.equal(results.get(pack).detection, "INDETERMINATE", pack);
    assert.match(results.get(pack).note, /no file of a kind any detector understands/);
  }
});

test("an unreadable project tree is INDETERMINATE", async () => {
  const results = await detect(path.join(os.tmpdir(), "so-project-does-not-exist"), detectors);
  for (const pack of ["betting", "prediction"]) {
    assert.equal(results.get(pack).detection, "INDETERMINATE", pack);
  }
});

// ---------------------------------------------------------------------------------------------
// Feeding the outcome algebra.
// ---------------------------------------------------------------------------------------------

test("a CONFLICT disposition fails the gate", () => {
  const applicability = deriveApplicability({
    pack: "betting",
    declaration: "NOT_APPLICABLE",
    detection: "DETECTED",
  });
  const result = aggregate([
    { pack: "prediction", class: "PASS" },
    { pack: "betting", class: "INDETERMINATE", applicability: applicability.applicability },
  ]);
  assert.equal(result.outcome, "FAIL");
  assert.equal(result.reasons.some((r) => r.applicability === "CONFLICT"), true);
});

test("an UNRESOLVED applicability fails the gate, distinctly from a CONFLICT", () => {
  // Both fail; the remedies differ. One needs adjudication, the other needs someone to declare.
  const result = aggregate([
    { pack: "betting", class: "INDETERMINATE", applicability: "UNRESOLVED" },
  ]);
  assert.equal(result.outcome, "FAIL");
  const applicabilities = result.reasons.map((r) => r.applicability).filter(Boolean);
  assert.deepEqual(applicabilities, ["UNRESOLVED"]);
  assert.equal(applicabilities.includes("CONFLICT"), false);
});

test("ADVERSARIAL: every pack NOT_APPLICABLE with no signals still does not produce PASS", () => {
  // M1's empty-set protection, reached through M4. A manifest that declares its way out of every
  // authority while detectors find nothing has evaluated nothing, and nothing evaluated is not
  // compliance.
  const results = ["betting", "prediction"].map((pack) => {
    const applicability = deriveApplicability({ pack, declaration: "NOT_APPLICABLE", detection: "NOT_DETECTED" });
    assert.equal(applicability.disposition, "NOT_APPLICABLE");
    return { pack, class: "PASS", applicability: applicability.applicability };
  });

  const result = aggregate(results);
  assert.equal(result.outcome, "INDETERMINATE");
  assert.notEqual(result.outcome, "PASS");
});

test("a declared-only pack that runs and passes can still reach PASS", () => {
  // The asymmetry must not accidentally block: a requirement a detector cannot see is still a
  // legitimate way to be applicable.
  const applicability = deriveApplicability({ pack: "betting", declaration: "REQUIRED", detection: "NOT_DETECTED" });
  const result = aggregate([{ pack: "betting", class: "PASS", applicability: applicability.applicability }]);
  assert.equal(result.outcome, "PASS");
});

test("rendering shows both sources, not only the conclusion", () => {
  const line = renderApplicability(
    deriveApplicability({
      pack: "betting",
      declaration: "UNSPECIFIED",
      detection: "DETECTED",
      evidence: [{ signal: "order-placement-call" }],
    }),
  );
  assert.match(line, /betting: CONFLICT \(declaration=UNSPECIFIED detection=DETECTED, 1 signal\(s\)\)/);
});
