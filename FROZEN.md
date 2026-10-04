# Frozen

**This repository is not the portfolio's standards authority, and must not be adopted as one.**

StandardsOrchestrator independently explored the same orchestration problem that
[StandardsEnforcer](https://github.com/mikeycdavis/StandardsEnforcer) is built to solve. Its implementation is not the portfolio
authority. Its design is being treated as independent comparative evidence; concepts may be adopted
individually only where they preserve StandardsEnforcer's authority invariants.

Development here is frozen as of **2026-08-10**, at `v1.0.0`. Nothing is deleted, because the M0–M8
reasoning is worth more as a second opinion than the disk it occupies.

## Why two repositories existed

Neither was built in ignorance of the problem; they were built in ignorance of each other. They
converged on the same responsibilities:

```text
                       Enforcer   Orchestrator
adapter protocol           ✓            ✓
identity resolution        ✓            ✓
applicability / scope      ✓            ✓
native execution           ✓            ✓
outcome handling           ✓            ✓
merge gating               ✓            ✓
```

That is not layering. It is duplicate orchestration, and two control planes gating the same merges is
worse than either one alone.

## Why StandardsEnforcer won, in one sentence

The two repositories disagree about **who owns the adapter**, and only one answer survives the
requirement that a single immutable identity establish the whole claim.

Here, adapters live centrally:

```text
registry/betting-1.0.0.adapter.json     ← this repository decides how Betting is invoked
registry/interpreters/betting-1.0.0.mjs ← and how Betting's answer is read
```

So the effective standards system is the *pair* `(BettingStandards v1.0.0, Orchestrator revision X)`,
and the second repository decides what the first one's answer means. StandardsEnforcer's ADR 0005
requires instead that evaluator code, invocation declaration, native-status vocabulary and passing-set
interpretation all share **one** verified release identity — which is only achievable when the pack
owns its own declaration.

## The empirical result that settled it

Both repositories independently derived a declaration of how to invoke BettingStandards. They
disagree, and the centrally-owned one is the wrong one.

```text
pack-owned    (BettingStandards v1.0.1)  ["validate", "{target}",  "--json"]
central       (this repository, v1.0.0)  ["validate", "--json", "--dir={{target}}"]
```

Verified against `a4e7e68` — the exact commit this repository's adapter names as `expectedCommit`:

```text
$ node scripts/standards.mjs validate --json --dir=<target>
standards: unknown flag '--dir=<target>'
exit 2
```

BettingStandards takes its target positionally. It has no `--dir` flag and never had one. This
repository's `knownHazards` entry says the absolute `--dir` is the *mitigation* for the pack grading
its own tree — so the mitigation never worked, and the hazard it named is real:

```text
$ node scripts/standards.mjs validate --json      # no target
{"project": "BettingStandards", "status": "COMPLIANT", "score": 94}   exit 0
```

To this repository's credit, the wrong invocation **fails closed**: exit 2 is declared
`infrastructureFault`, so a mis-invocation becomes `INDETERMINATE` rather than a false green. The
outcome algebra did its job. The declaration underneath it was still wrong for the whole of this
repository's life, and no test here could have caught it, because a central registry has no way to be
wrong-and-noticed — the pack it describes never reads it.

That is the authority argument made empirical rather than asserted, and it is the reason the freeze is
a decision rather than a preference.

## What is being carried across

Recorded in StandardsEnforcer at
`artifacts/evidence/2026-08-10-orchestrator-reconciliation.md`, which classifies every materially
different proposition in this repository as AGREE, ADOPT, REJECT or NOT YET EARNED. Several ideas here
are better than the Enforcer's equivalents and are being adopted on their merits.

## What this freeze does not mean

It does not mean the work was wasted, and it does not mean the code is wrong. `v1.0.0` passes its own
suite, and its sixteen baseline properties were mutation-proven. It means the portfolio may have only
one gate, and this is not it.

Do not adopt this repository into a governed project. Do not extend it. If something here is needed,
it moves to StandardsEnforcer through the reconciliation record.
