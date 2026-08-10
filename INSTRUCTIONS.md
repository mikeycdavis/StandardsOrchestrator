# Adopting the standards gate

This turns compliance with pinned standards releases into a condition of merging. Four steps, in
this order. The order matters: step 4 is what makes the check binding, and doing it before step 3 is
how a repository ends up permanently blocked by a check that has never reported.

## 1. Declare which authorities apply

Create `standards.yml` at the root of the repository being gated.

```yaml
standards:
  betting:
    required: true
    version: 1.0.0
  prediction:
    required: true
    version: 1.1.0
  ml:
    required: false
  engineering:
    required: false
```

`required` must be `true` or `false`. Anything else is rejected rather than treated as unspecified —
a typo must not become a silent exemption.

A pack declared `required: true` must name an exact `version`. A requirement with no pin names
nothing, and is reported `UNRESOLVED`.

Omitting a pack entirely is not the same as declaring it not applicable. An omitted pack is
`UNSPECIFIED`, and the detectors then decide whether that silence is a question worth raising. If
they find affirmative evidence that the pack applies, the run reports an unresolved applicability
state and the gate fails — not because the pack failed, but because nobody has said whether it
applies and the evidence suggests it does.

Declaring `required: false` for a pack the detectors do find is a `CONFLICT`. That is deliberate: a
declaration cannot silently suppress evidence, and evidence cannot silently override a declaration. A
human adjudicates, and records the outcome in whichever of the two was wrong.

## 2. Add the caller workflow

Copy [`templates/caller/standards.yml`](templates/caller/standards.yml) to
`.github/workflows/standards.yml` in the adopting repository, and replace the two placeholders:

- `ORCHESTRATOR_OWNER` — the account or organisation hosting StandardsOrchestrator.
- `PINNED_ORCHESTRATOR_COMMIT_SHA` — the 40-character commit SHA of the orchestrator you reviewed.

Adjust the `push` branch list to the branches you actually protect. Change nothing else. In
particular, do not add:

- a `paths:` filter — the check would then not run on pull requests that touch nothing it matches,
  and a required check that does not run sits Pending forever;
- a job-level `if:` — same reason;
- any test for whether this repository "looks like" it needs standards. Applicability is decided by
  the orchestrator, from the manifest and the detectors, with the evidence reported either way. A
  heuristic in CI would be a second opinion formed with less information, and it would fail silently
  in the direction of not running.

Pin to a commit, not a branch or tag. Both can move, and an enforcement engine that floats is not
reproducible enforcement. The whole chain is pinned or none of it is:

```text
your repository
  → StandardsOrchestrator @ <commit>
       → BettingStandards @ v1.0.0 → a4e7e68
```

## 3. Let it report at least once

Open a pull request and let the workflow run to completion. Read the job summary.

Do not register the check as required yet. The check name GitHub records for a reusable workflow is
composed from the calling job's name and the called job's name — with the template as shipped, it
appears as `Standards / gate`. Registering a name that has never appeared creates a required check
that nothing will ever report, which blocks every pull request in the repository until someone
removes it.

Register the name exactly as it appears in the checks list, after it has appeared.

Expect the first run to fail. A repository that has just adopted the manifest usually has authorities
it has not yet satisfied, and that is the gate working. Read the reasons before changing anything:
they distinguish *the authority found a problem* from *the authority could not be obtained* from *the
engine could not run at all*, and those send you to three different places.

### If the standards repositories are private

The gate fetches and executes the pinned standards packs, and it checks out the orchestrator itself.
On GitHub-hosted runners the default `GITHUB_TOKEN` cannot read other repositories. Supply a token
that can:

```yaml
    secrets:
      engine-token: ${{ secrets.STANDARDS_READ_TOKEN }}
```

Without it, the orchestrator repository checkout fails and the check goes red, and an authority whose
remote cannot be reached is reported `UNRESOLVED`. Both are correct: an authority that could not be
reached has established nothing, and "could not reach it" is never evidence that it would have
passed.

## 4. Make it required

In the repository ruleset that protects your branches, add the check name from step 3 to the required
status checks.

## What this gives you, exactly

**When invoked, this CI path runs the pinned orchestrator and faithfully reports its result.** That
is the whole claim, and it is held up by:

- the job always runs and always reports — no path filters, no conditional jobs;
- a final step that runs on `always()`, re-derives the verdict from the report, and fails closed if
  the record is missing, incomplete, or inconsistent with the report it claims to summarise;
- no `continue-on-error`, no `|| true`, nothing that turns a non-zero result into a zero one;
- an engine pinned to the commit the caller named.

**It does not claim that the check is registered as required, or that an administrator cannot remove
it.** An admin can delete the caller, unregister the check, or bypass protection outright. The
portfolio audit makes that visible from outside the repository, which is strictly better than a
repository auditing itself — but it is detection, not prevention. See the README.

## Reading the result

| Reported | Means | Where to look |
| --- | --- | --- |
| `PASS` | every applicable authority passed and every prerequisite held | nowhere |
| `FAIL` | an authority ran and reached a negative conclusion | the project |
| `BLOCKED` | a prohibition fired | stop; do not proceed |
| `INDETERMINATE` | an authority ran but could establish no honest conclusion | what it was given to evaluate |
| `UNRESOLVED` | the authority could not be obtained or verified | the pin, the tag, the adapter |
| `CONFLICT` | declaration and detection disagree | adjudicate, then fix whichever was wrong |

Exit `2` and a summary headed **not evaluated** mean the engine itself could not reach a conclusion.
That is never a finding about your project. Do not change project code in response to it.
