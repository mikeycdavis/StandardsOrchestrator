/**
 * Reading governance evidence from GitHub. Evidence only — this file forms no judgements.
 *
 * THE DISTINCTION EVERYTHING HERE EXISTS TO PRESERVE. "The API says this branch requires no standards
 * check" and "the API would not tell me what this branch requires" are different facts with different
 * remedies, and collapsing them is the governance-layer form of converting absence into compliance.
 * Every reader below returns a `status` alongside its data, and `unreadable` is never data.
 *
 * TWO MECHANISMS, NOT ONE, AND THEY ARE NOT EQUIVALENT. [FACT, probed 2026-08-10]
 * GitHub enforces required status checks through classic branch protection AND through repository
 * rulesets, and a branch may be governed by either, both, or neither. Measured on a real
 * ruleset-governed repository:
 *
 *     GET /repos/{r}/branches/main            -> {"protected": true}
 *     GET /repos/{r}/branches/main/protection -> 404 {"message": "Branch not protected"}
 *     GET /repos/{r}/rules/branches/main      -> [{"type": "required_status_checks", ...}]
 *
 * An audit reading only the classic endpoint would report that branch as unprotected — a confident
 * false negative produced by asking one authority about a question the other one answers. So both are
 * queried, both keep their own status, and neither is inferred from the other.
 *
 * PRESENCE AND ABSENCE ARE NOT SYMMETRIC. Finding a required check in any readable mechanism
 * establishes that it is required. Failing to find one establishes nothing unless EVERY mechanism was
 * readable. The audit relies on that asymmetry rather than on a combined view that would have to
 * guess.
 *
 * PLAN LIMITS READ AS UNREADABLE, NOT AS ABSENT. [FACT, probed 2026-08-10] On a private repository on
 * a free plan both `/rulesets` and `/rules/branches/{b}` return 403 "Upgrade to GitHub Pro". That is
 * the API declining to answer, and it must never be recorded as "no rules found".
 */

/** Evidence status vocabulary. `unreadable` is the only one that is not a fact about the repository. */
export const EVIDENCE = Object.freeze(["readable", "unreadable"]);

/**
 * A minimal GitHub client over `fetch`. No npm packages, no `gh` binary.
 *
 * The token comes from the environment. Absent, every authenticated read fails, and the audit reports
 * the platform evidence as unevaluable rather than assuming the best about what it could not see.
 */
export function createClient({ token, fetchFn = fetch, base = "https://api.github.com", timeout = 20_000 } = {}) {
  return {
    hasToken: Boolean(token),
    async get(route) {
      if (!token) {
        return { status: 0, ok: false, body: null, error: "no GitHub token is available to this audit" };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const response = await fetchFn(`${base}${route}`, {
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
            "user-agent": "standards-orchestrator-portfolio-audit",
          },
          signal: controller.signal,
        });
        const text = await response.text();
        let body = null;
        try {
          body = text === "" ? null : JSON.parse(text);
        } catch {
          // A response that is not JSON is not evidence of anything. Fail closed.
          return { status: response.status, ok: false, body: null, error: "the response was not JSON" };
        }
        return { status: response.status, ok: response.ok, body, error: response.ok ? undefined : body?.message };
      } catch (error) {
        return { status: 0, ok: false, body: null, error: error.message };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Read the token the way GitHub Actions and a local shell each provide it. */
export function tokenFromEnv(env = process.env) {
  return env.GITHUB_TOKEN || env.GH_TOKEN || undefined;
}

/**
 * Does the repository still exist at the identity the portfolio claims?
 *
 * A rename leaves a redirect that the API follows silently, so the canonical `full_name` is compared
 * rather than assumed. A repository governed under a name it no longer has is a governance change
 * that happened without anyone recording it.
 */
export async function readRepository(client, repository) {
  const response = await client.get(`/repos/${repository}`);
  if (response.status === 404) {
    return { status: "readable", present: false, detail: `no repository at ${repository}` };
  }
  if (!response.ok) {
    return { status: "unreadable", detail: response.error ?? `HTTP ${response.status}` };
  }
  return {
    status: "readable",
    present: true,
    canonical: response.body.full_name,
    renamed: response.body.full_name.toLowerCase() !== repository.toLowerCase(),
    archived: Boolean(response.body.archived),
    defaultBranch: response.body.default_branch,
    private: Boolean(response.body.private),
  };
}

/** Fetch one file's text from the default branch. */
export async function readFileFromRepository(client, repository, filePath) {
  const response = await client.get(`/repos/${repository}/contents/${filePath}`);
  if (response.status === 404) {
    return { status: "readable", present: false, detail: `${filePath} does not exist in ${repository}` };
  }
  if (!response.ok) {
    return { status: "unreadable", detail: response.error ?? `HTTP ${response.status}` };
  }
  if (typeof response.body?.content !== "string") {
    return { status: "unreadable", detail: `${filePath} did not come back as file content` };
  }
  return {
    status: "readable",
    present: true,
    text: Buffer.from(response.body.content, "base64").toString("utf8"),
    sha: response.body.sha,
  };
}

/** Required-check contexts named by a classic branch-protection object, in either of its two shapes. */
function classicContexts(protection) {
  const required = protection?.required_status_checks;
  if (!required) return [];
  if (Array.isArray(required.checks)) return required.checks.map((c) => c.context).filter(Boolean);
  if (Array.isArray(required.contexts)) return required.contexts.filter(Boolean);
  return [];
}

/**
 * What one branch actually requires, read from both mechanisms independently.
 *
 * Returns each mechanism's own status and contexts, plus `complete` — true only when BOTH were
 * readable. `complete` is what licenses the audit to conclude that a check is *not* required.
 */
export async function readBranchGovernance(client, repository, branch) {
  const classic = await client.get(`/repos/${repository}/branches/${branch}/protection`);
  const rules = await client.get(`/repos/${repository}/rules/branches/${branch}`);

  // 404 here is the documented "Branch not protected", which is a genuine absence of a CLASSIC
  // protection object — including on branches that rulesets govern. It is not an unreadable answer.
  const classicEvidence =
    classic.status === 404
      ? { status: "readable", governed: false, contexts: [] }
      : classic.ok
        ? { status: "readable", governed: true, contexts: classicContexts(classic.body) }
        : { status: "unreadable", detail: classic.error ?? `HTTP ${classic.status}` };

  const ruleEvidence = rules.ok
    ? {
        status: "readable",
        governed: Array.isArray(rules.body) && rules.body.length > 0,
        contexts: (Array.isArray(rules.body) ? rules.body : [])
          .filter((rule) => rule.type === "required_status_checks")
          .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
          .map((check) => check.context)
          .filter(Boolean),
        rulesetIds: [...new Set((Array.isArray(rules.body) ? rules.body : []).map((r) => r.ruleset_id).filter(Boolean))],
      }
    : { status: "unreadable", detail: rules.error ?? `HTTP ${rules.status}` };

  return {
    branch,
    classic: classicEvidence,
    rulesets: ruleEvidence,
    complete: classicEvidence.status === "readable" && ruleEvidence.status === "readable",
    contexts: [...new Set([...(classicEvidence.contexts ?? []), ...(ruleEvidence.contexts ?? [])])],
    governed:
      (classicEvidence.status === "readable" && classicEvidence.governed) ||
      (ruleEvidence.status === "readable" && ruleEvidence.governed),
  };
}

/**
 * Who can bypass the rulesets that govern this branch.
 *
 * A bypass actor on the ruleset carrying the standards check means the check is not required for that
 * actor. That is a weakening of enforcement, it is exposed by the API, and reporting it is the whole
 * point — this audit's claim is visibility, not prevention.
 */
export async function readBypass(client, repository, rulesetIds) {
  if (rulesetIds.length === 0) return { status: "readable", actors: [] };
  const actors = [];
  for (const id of rulesetIds) {
    const response = await client.get(`/repos/${repository}/rulesets/${id}`);
    if (!response.ok) {
      return { status: "unreadable", detail: response.error ?? `HTTP ${response.status}` };
    }
    for (const actor of response.body?.bypass_actors ?? []) {
      actors.push({
        ruleset: response.body.name,
        actorType: actor.actor_type,
        actorId: actor.actor_id,
        mode: actor.bypass_mode,
      });
    }
  }
  return { status: "readable", actors };
}
