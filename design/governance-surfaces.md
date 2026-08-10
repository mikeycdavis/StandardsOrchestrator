# Governance surfaces: what GitHub will actually tell you

Everything marked **[FACT]** was probed against live GitHub on 2026-08-10 with a token carrying
`repo`, `read:org`, `workflow`. If GitHub changes these behaviours these rows become wrong and must be
re-derived — they do not carry forward. Everything marked **[POLICY]** is this repository's decision
and is independent of GitHub's evolution.

## The mechanism question, settled before writing the checks

There are two mechanisms, and **they are not equivalent.** Probed on `enforcer-m4-governed`, a public
repository governed entirely by a repository ruleset: **[FACT]**

```text
GET /repos/{r}/branches/main             → {"protected": true}
GET /repos/{r}/branches/main/protection  → 404 {"message": "Branch not protected"}
GET /repos/{r}/rules/branches/main       → [{"type": "required_status_checks", ...}]
```

The classic protection endpoint returns **404 "Branch not protected"** for a branch that is protected,
because there is no classic protection *object* — the governance lives in a ruleset. An audit reading
only the classic endpoint would report that branch as unprotected: a confident false negative,
produced by asking one authority a question the other one answers.

So both are queried, each keeps its own status, and neither is inferred from the other. **[POLICY]**

| Endpoint | Answers | Does not answer |
| --- | --- | --- |
| `/branches/{b}` | is the branch protected by *something* | by what, or which checks are required |
| `/branches/{b}/protection` | classic required contexts | anything about rulesets |
| `/rules/branches/{b}` | effective required contexts, including from org rulesets | classic protection |
| `/rulesets/{id}` | who may bypass | which branches are affected |

`/rules/branches/{b}` is the one that carries required-check contexts under rulesets, and it reports
rules inherited from organisation-level rulesets too, which is why it is preferred over enumerating
`/rulesets`. **[FACT]**

## Presence and absence are not symmetric **[POLICY]**

Finding a required check in **any** readable mechanism establishes that it is required. Failing to
find one establishes nothing unless **every** mechanism was readable.

The audit relies on that asymmetry rather than on a merged view that would have to guess:

```text
found in a readable mechanism           → the check is required          (concludable)
not found, every mechanism readable     → the check is not required      (concludable)
not found, some mechanism unreadable    → not established                (unevaluable)
```

This is the governance-layer form of the central invariant. "The API says no standards check is
required here" and "the API would not tell me what is required here" are different facts with
different remedies, and collapsing them converts absence into compliance.

## Plan limits read as unreadable, never as absent **[FACT]**

On a **private repository on a free plan**, both governance endpoints return 403:

```json
{"message": "Upgrade to GitHub Pro or make this repository public to enable this feature.",
 "status": "403"}
```

That is the API declining to answer. It must never be recorded as "no rules found", and the audit
reports it as `governance-unreadable`.

This is not hypothetical for this portfolio. `mikeycdavis/Moneyball` — the intended first adopter — is
a private repository on a free plan, so **its branch protection and rulesets cannot be read at all**,
and `branches/develop` reports `"protected": false`. **[FACT]**

There is a related discrepancy worth recording rather than fixing: Moneyball's own `CLAUDE.md`
describes `Build Python` as "a REQUIRED check". The platform says the branch is not protected, and the
plan does not offer required checks for private repositories. Whatever the document meant, the
enforcement it describes is not the enforcement the platform is applying. That is precisely the class
of stale claim this audit exists to surface, and it was found in the wild before the audit shipped.

## Check identity **[FACT]**

For a job that calls a reusable workflow, GitHub composes the status check name from the **calling**
job's name and the **called** job's name:

```text
standards / machine-learning      ← observed on a live ruleset
Standards / gate                  ← what this repository's template produces
```

Consequences: **[POLICY]**

- The audit computes the identity a caller *would* produce and compares it to the portfolio's claim,
  so renaming a job is caught before it becomes a required check nothing will ever report.
- The called half is read from this repository's own `validate.yml` rather than hardcoded. Renaming
  the `gate` job here immediately marks every portfolio `checkName` stale — which is correct, because
  that rename would break every governed repository at once.

## Bypass **[FACT]**

`/rulesets/{id}` exposes `bypass_actors` and `current_user_can_bypass`. A bypass actor on the ruleset
carrying the standards check means the check is not required *for that actor*, which is a weakening of
enforcement that the API will tell you about. The audit reports it as a failure. **[POLICY]** Not
because a bypass is always wrong — an emergency route can be deliberate — but because the criterion is
that enforcement cannot weaken without the audit ceasing to report green, and a bypass actor is a
weakening.

## What is deliberately not in `portfolio.yml`

**An expected orchestrator commit.** The caller's pin is checked for *shape*: it must be a
40-character commit SHA. Requiring it to equal a specific SHA would mean updating the portfolio on
every orchestrator release, and every governed repository would fail the audit in the window between
those two commits. The governance question is whether enforcement is pinned, not which reviewed commit
it is pinned to. **[POLICY]**

**Anything about applicability.** Whether a standard applies to a repository is decided by that
repository's manifest and the detectors, with evidence reported either way. A portfolio-level opinion
would be a second judgement made with less information.

## The stopping point

```text
Domain authority          BettingStandards, PredictionStandards — own their subjects
      ↓
StandardsOrchestrator     composes them; invents no conclusions
      ↓
M7 required CI check      when invoked, runs the pinned orchestrator and reports faithfully
      ↓
M8 portfolio audit        is the repository configured so that check is required?
      ↓
GitHub administration     can change any of the above
```

There is no further software layer inside these repositories below the last line. An administrator can
delete the caller, unregister the check, configure a bypass, or remove the repository from the
portfolio. The audit makes each of those visible from outside the repository, which is strictly better
than a repository auditing itself — and it is detection, not prevention.

So the success criterion is not "enforcement cannot be bypassed". It is:

> Within the governance surfaces this audit can inspect, required standards enforcement cannot
> disappear, weaken, or become unevaluable without the portfolio audit ceasing to report green.
