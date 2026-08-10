# Discovered fact vs orchestrator policy

Two kinds of statement live in this repository, and mixing them is the most expensive mistake
available here.

| | **[FACT]** | **[POLICY]** |
| --- | --- | --- |
| Source | Reading a specific pack at a specific version | A decision the orchestrator makes and owns |
| Lifetime | Until that pack releases a new version | Until we deliberately change it |
| On a downstream change | **Re-derive it** | Leave it alone |
| Example | *PredictionStandards@v1.1.0 exposes the binary `predictions`; there is no `validate` subcommand.* | *`NOT_EVALUATED` can never aggregate to overall compliance.* |

## Why the separation is load-bearing

When a pack changes its CLI, the work should be re-deriving that pack's **[FACT]** rows and nothing
else. A plan or a codebase that blends the categories forces a re-litigation of orchestrator policy
every time a downstream tool renames a flag.

The worse failure runs the other way: a pack's *behaviour* gets mistaken for a rule the orchestrator
chose. If `MachineLearningStandards@v1.4.0` returns `COMPLIANT` with zero applicable rules, that is a
**[FACT]** about that version — not a licence for the orchestrator to treat empty evaluations as
passing. Recording it as fact keeps the orchestrator's own answer ("that is `INDETERMINATE`") clearly
a **[POLICY]** decision that survives the pack changing its mind.

## Where each lives

**[FACT]** lives in `registry/*.adapter.json` — declarative data, one file per exact
`(pack, version)`, every field describing something observed in that release. Adapters are data
rather than code paths precisely so that a fact can be corrected without touching logic.

**[POLICY]** lives in `scripts/outcome.mjs` (the outcome algebra), `registry/dependencies.json` (the
composition DAG), and the rules this repository owns about adoption. None of it mentions any pack's
interface.

## The rule that follows from this

**No adapter field may be inferred from another pack.** Not the binary, not the verdict subcommand,
not the exit-code meanings, not the verdict vocabulary, not the envelope shape, not the coverage
field names.

This is not defensive caution. It is what the recon actually found across four sibling packs built
from the same forked machinery:

- three different binaries (`standards`, `predictions`)
- three different verdict subcommands (`validate`, `check`, `evaluate`)
- two different verdict vocabularies (`COMPLIANT…` vs `SUPPORTED…`)
- two different exit-code ranges (0–2, and 0–3 where 3 means blocked)
- one pack with no top-level `status` field at all
- three different coverage object shapes
- four different behaviours when the project policy is absent, including one that walks up twelve
  directories and grades against the pack's own policy

Any one of those, assumed rather than read, becomes a silent mis-parse — the orchestrator confidently
reporting a verdict it did not understand.

## Version scoping follows too

An adapter is keyed on `(pack, version)`. Supporting `prediction@1.1.0` implies nothing about
`prediction@1.2.0`: a release can keep its name and its tag discipline while changing its output
contract, and optimistic compatibility fails *silently*.

v1 supports no version ranges at all. A new version gets a new adapter file and its own contract
probe, even when the contract is unchanged. If that duplication ever becomes burdensome, that is the
evidence for adding ranges — not the anticipation of it.
