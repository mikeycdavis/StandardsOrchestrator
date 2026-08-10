# The authority boundary

> **The orchestrator may compose standards authorities, but it may neither invent their conclusions
> nor convert absence, ambiguity, incompatibility, or failure into compliance.**

That is this repository's permanent thesis. Everything below serves it.

## What this repository must never contain

**No normative domain requirements. None.** Not one rule about what constitutes a good bet, a valid
model, a supported prediction, a sound proof, or a defensible financial recommendation.

Specifically forbidden here:

```text
rules/betting/no-martingale.json         ← belongs to BettingStandards
rules/ml/no-target-leakage.json          ← belongs to MachineLearningStandards
rules/math/no-numerical-proof.json       ← belongs to MathematicalStandards
```

The reason is not tidiness. A domain rule living here would be a **second definition** of something a
domain pack already defines authoritatively — and the two would drift. Worse, the orchestrator's copy
would be the one CI actually gates on, which would quietly relocate authority away from the repository
that reasoned about the subject.

## What this repository may contain

Rules about **standards adoption itself**, and nothing else. The complete permitted subject list:

| Subject | Example rule the orchestrator may own |
| --- | --- |
| Pinning | Required standards must be pinned to an exact version. |
| Resolution | A required standards pack must resolve to a verified, immutable ref. |
| Applicability | An applicable pack cannot be silently omitted. |
| Dependency ordering | A dependent pack's result cannot stand on an unsatisfied upstream. |
| Execution integrity | Output that cannot be parsed by the declared contract is not a verdict. |
| Aggregation | `NOT_EVALUATED` can never become an orchestration success. |
| | A failed pack cannot be hidden by successful packs. |

Note what these have in common: every one is a statement about *the machinery of composition*. None
requires knowing anything about betting, modelling, or prediction.

## The three-layer authority hierarchy

```text
Domain pack            Is this domain work valid?
      ↓
StandardsOrchestrator  Did every applicable authority run and pass?
      ↓
Portfolio audit        Is this repository still participating in orchestration at all?
      ↓
Human / GitHub admin   (the layer nothing here can enforce)
```

Each layer answers a question the layer below it cannot answer about itself. A repository cannot
detect that it never adopted the orchestrator; that is the portfolio audit's job. The orchestrator
cannot prevent an administrator from removing a required check; that is where mechanism ends and
governance begins, and this repository says so plainly rather than implying otherwise.

## Why the orchestrator owns the dependency rule

A specific case worth recording, because it looks like a boundary violation and is not.

BettingStandards ADR 0001 fixes that it consumes a probability estimate as an **opaque input** and
evaluates nothing upstream of it. So if a prediction is insufficiently supported, BettingStandards has
no mechanism to know — it will compute an edge from the recorded probability and reach an internally
valid conclusion.

That means `prediction → betting` **cannot** be enforced by either pack. It is a property of composing
them, so it belongs here. Encoding it in BettingStandards would have required reopening a frozen
release and would have violated *its* boundary.

The correct outcome preserves both packs' honesty:

```text
PredictionStandards: INSUFFICIENTLY_SUPPORTED
        │ dependency unsatisfied
        ▼
BettingStandards:    COMPLIANT      (its edge maths and policy really were valid)
        │
        ▼            dependency-unsatisfied
OVERALL:             FAIL
```

The orchestrator does not overwrite BettingStandards' verdict or pretend it was false. It reports
that the betting mechanics were sound *conditional on a probability that was not sufficiently
supported* — which is more informative than refusing to run Betting at all, and which is why
dependents are still executed.

## The one exception: detectors, and why it is not a hole

Applicability detection is on the permitted subject list, but a detector cannot do its job without
naming a domain — describing what an order-placement call looks like requires saying "order". So
`detectors/` sits deliberately outside `rules/`, `schemas/`, and `registry/`, and is governed by the
opposite rule instead.

| | Normative directories | `detectors/` |
| --- | --- | --- |
| May name a domain concept | **No** | **Yes** — it is the whole function |
| May name an outcome class | Yes | **No** |
| Carries normative weight | Yes | **None** |

What makes this safe is not the file location. It is that **detection produces evidence, never a
conclusion**:

- A signal found raises a question. It cannot make a pack applicable on its own — declared-not-
  applicable plus detected is a `CONFLICT` for a person to adjudicate, not an override.
- A signal not found answers nothing. `NOT_DETECTED` means "the configured detectors found no
  affirmative signal". It can never waive a pack, because if it could, every gap in detector recall
  would be a way out of a standards gate.
- No detector output is ever compared to a threshold. Confidence stays qualitative, since `0.91`
  versus `0.89` would only move human judgement behind a decimal.

`scripts/boundary.mjs` enforces the second row of that table: a detector naming `PASS`, `FAIL`, or any
other outcome class is a violation. A detector that can conclude has stopped being a detector and
become a domain rule in a directory nobody checks for them.

## The test that enforces this

`test/boundary.test.mjs` scans this repository for domain vocabulary in any rule, schema, or registry
file and fails if it finds it, and scans `detectors/` for outcome-class vocabulary. Planted fixtures
prove both checks bite, and two further fixtures prove the carve-outs work: an adapter may name its
pack, and a detector may describe its subject. This is the boundary made mechanical rather than merely
asserted — the same discipline the domain packs apply to themselves.
