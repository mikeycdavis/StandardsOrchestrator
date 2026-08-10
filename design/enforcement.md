# Enforcement: the claim, and the claim next to it

## The invariant

> The enforcement check must produce a terminal result for every protected-branch event it claims to
> govern.

Terminal means passed or failed. Not Pending, not skipped, not absent. This is the CI-layer form of
the repository's central invariant — the orchestrator may compose standards authorities, but it may
neither invent their conclusions nor convert absence, ambiguity, incompatibility, or failure into
compliance — and Pending is exactly an absence being allowed to stand in for a conclusion.

Pending is worse than it looks. It is not a neutral third state that a reviewer weighs; it is a
pull request that cannot merge and a reviewer with no information about why. The predictable response
is not investigation. It is removing the check from branch protection to unblock the merge, at which
point the enforcement mechanism has become its own escape hatch, and it happened without anyone
deciding to weaken enforcement.

## What M7 claims

> **When invoked, this CI path runs the pinned orchestrator and faithfully reports its result.**

## What M7 does not claim

> That repository administrators have made this check required, and cannot remove it.

Keeping these separate is the point. If they were merged, the existence of
`.github/workflows/standards.yml` in a repository would read as evidence of branch protection, and it
is not — a caller can sit in a repository for a year without ever being registered as a required
check, passing every structural test in this repository the whole time. The second claim needs
evidence from outside the repository, and that is the portfolio audit's job.

## The three false-enforcement modes

Everything in `validate.yml`, `templates/caller/standards.yml`, `scripts/gate.mjs` and
`scripts/workflows.mjs` exists to close one of these. Each is checked structurally, and each has a
mutation test proving the check bites.

### 1. Skipped job

A `paths:` filter or a job-level `if:` means the check does not run on some governed events. It does
not fail — it reports nothing at all, and the required check stays Pending.

Closed by: no `paths`/`paths-ignore` and no job-level `if:` in either workflow, rejected by the
linter. Cost management, if it is ever needed, is gated at the *step* level inside a job that still
runs and still reports.

### 2. Conditional success

`continue-on-error`, `|| true`, a trailing `exit 0`, or a later successful step overwriting an
earlier failure. The workflow still looks like it ran.

Closed by: those constructs rejected by the linter, plus the guard step re-deriving the verdict from
the report rather than trusting the recorded exit code. An exit code of `0` is honoured only when the
report independently says `PASS`. A green code beside a missing report, or beside a report that says
`FAIL`, is an enforcement fault — not a pass.

### 3. Missing invocation

The repository claims adoption but the caller no longer invokes the pinned orchestrator workflow —
deleted, renamed, repointed at a different workflow, or repointed at a branch.

Partly closed by: the linter rejects a caller whose `uses:` does not name the orchestrator's
`validate.yml`, and rejects any ref that is not a 40-character commit SHA.

**Only partly.** A repository with no caller at all passes every check in this repository by having
nothing to fail. That is stated as a test rather than left implicit, and it is the bootstrap question
M8 exists to answer: who verifies that the enforcement path still exists and remains required?

## Why the guard step is not itself a swallowed failure

The gate is two steps, and the shape — a step that runs, then a step that decides — is superficially
the shape of a swallowed failure. It is not, for two reasons.

First, the run step exits with the honest code. A gate failure makes the job red before the guard
speaks at all. Nothing anywhere turns a non-zero result into a zero one.

Second, the guard exists for the cases the run step *cannot* report on: it never started, it was
cancelled, it died at the runner level, or it exited `0` having written no report. In each of those
the check would otherwise be Pending or green-by-absence. The guard runs on `always()`, must be the
last step, and fails closed on any record that is missing, incomplete, or inconsistent.

## Why `2` is preserved even though CI cannot see it

GitHub sees zero versus non-zero, so a gate failure and an engine fault are the same red check. The
codes stay distinct anyway, because the summary a human reads must never present an orchestrator
fault as evidence that the project is non-compliant. A `1` says fix your project. A `2` says the
engine could not answer, and nobody should change a line of project code in response to it. Both
block the merge; only one of them is a finding.

## Why the engine is pinned to `github.workflow_sha`

The same principle the orchestrator enforces on standards packs, applied one layer up. A caller pins
the reusable workflow to a commit; `github.workflow_sha` is the commit of that workflow file as
invoked, so the engine that runs is the engine that was pinned. A project cannot honestly claim
reproducible standards enforcement while its enforcement engine floats on a branch.

The engine repository is derived from `GITHUB_WORKFLOW_REF` rather than hardcoded, so a fork enforces
with its own fork. If either value is absent the step exits non-zero and the check goes red: an
engine whose identity cannot be established must not be run.

## Why the project and the engine are checked out separately

The engine is materialised in `engine/` and the gated repository in `project/`. Checking the engine
out inside the gated tree would put this repository's own detectors, fixtures and registry underneath
the detectors — and the project would then be found to exhibit signals that came from the thing
inspecting it. A measurement that contaminates its subject is not a measurement.
