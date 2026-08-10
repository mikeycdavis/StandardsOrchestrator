# StandardsOrchestrator

Composes independently versioned standards authorities into one merge gate.

It owns no domain requirements. BettingStandards is the authority on betting; PredictionStandards on
predictions. This repository knows both exist, knows how to reach an exact release of each, knows
which apply to a given project, and knows how to combine what they say. It never decides what they
should have said.

## The central invariant

> The orchestrator may compose standards authorities, but it may neither invent their conclusions nor
> convert absence, ambiguity, incompatibility, or failure into compliance.

Everything here follows from that. Aggregation is a conjunction over a lattice, so adding a non-pass
result can never improve the outcome. An empty set of evaluated authorities is `INDETERMINATE`, not
`PASS` — nothing evaluated is not compliance. An authority that could not be fetched has established
nothing, and "could not reach it" is never evidence that it would have passed.

## Outcome classes

Preserved distinctly all the way to the JSON, because they fail the gate for operationally different
reasons and send someone to fix different things.

| Class | The authority… | Remedy |
| --- | --- | --- |
| `PASS` | ran and reached a positive conclusion, with evidence it evaluated something | — |
| `FAIL` | ran and reached a negative conclusion | fix the project |
| `BLOCKED` | fired a prohibition | stop; do not proceed |
| `INDETERMINATE` | ran but could establish no honest conclusion | fix what it was given to evaluate |
| `UNRESOLVED` | could not be obtained or verified; nothing ran | fix the pin, push the tag, add an adapter |
| `CONFLICT` | declaration and detection disagree | a human adjudicates |

## Layers

```text
your repository
  → StandardsOrchestrator @ <commit>
       → BettingStandards @ v1.0.0 → a4e7e68
       → PredictionStandards @ v1.1.0 → ebe232b
```

Every arrow is pinned to an immutable commit. This is a supply-chain control, not only drift
detection: the orchestrator fetches and *executes* code from other repositories, and pinning to a
verified SHA means CI runs exactly the commit that was reviewed. A force-pushed or re-pointed tag is
a hard resolution failure rather than the silent execution of different code.

## Adoption

See [INSTRUCTIONS.md](INSTRUCTIONS.md).

## The honest limit

**The gate can be bypassed. The guarantee is visibility, not prevention.**

A repository administrator can delete the caller workflow, unregister the required check, or bypass
branch protection outright. Nothing in this repository can stop that, and no arrangement of CI can:
the permission to change enforcement is the permission to remove it.

What CI *can* claim is narrower, and is claimed exactly:

> When invoked, this CI path runs the pinned orchestrator and faithfully reports its result.

It does not claim that the check is registered as required, or that it cannot be removed. Merging
those two claims would make the presence of a workflow file read as evidence of branch protection,
which it is not — a caller can sit unregistered in a repository indefinitely. Answering the second
question needs evidence from outside the repository, since a repository cannot be its own witness.

That is what the portfolio audit does (`npm run portfolio`, and a scheduled workflow here). It reads
each governed repository's caller workflow and GitHub's own protection and ruleset configuration, and
reports drift. Its criterion is stated as narrowly as it can honestly be:

> Within the governance surfaces this audit can inspect, required standards enforcement cannot
> disappear, weaken, or become unevaluable without the portfolio audit ceasing to report green.

Note what that does *not* say. It does not say enforcement cannot be removed. An administrator can
delete the caller, unregister the check, configure a bypass, or remove the repository from the
portfolio — and each of those makes the audit go red rather than being prevented. Governance
configuration the audit cannot read (a plan limit, a permissions boundary) is reported unevaluable,
never as protected.

Three claims stack, and none implies the others:

| Layer | Claim |
| --- | --- |
| M7 required CI check | when invoked, this path runs the pinned orchestrator and reports faithfully |
| M8 portfolio audit | this repository is configured so that check is required |
| an individual CI run | it executed and passed for this commit |

Branch protection does not prove any standard ran for any commit. That is run evidence, and the audit
does not claim it.

This is the same governance boundary BettingStandards Standard 21 R5 states, one level up.

## Zero dependencies

No npm packages, and CI has no install step — the absence of the install is what enforces it. The
YAML and JSON Schema readers are hand-written and deliberately strict, because an under-validating
parser is a false green.

"Zero dependencies" means no npm packages. The orchestrator does shell out to `git` and `node`, which
is unavoidable for a tool whose job is running other repositories' CLIs, and is said plainly rather
than implied away.

## Design notes

- [design/authority-boundary.md](design/authority-boundary.md) — what may and may not live here
- [design/fact-vs-policy.md](design/fact-vs-policy.md) — discovered fact versus orchestrator policy
- [design/enforcement.md](design/enforcement.md) — the CI claim, and the claim next to it
- [design/governance-surfaces.md](design/governance-surfaces.md) — what GitHub will actually tell you
