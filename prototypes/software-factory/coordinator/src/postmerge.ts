// Post-merge check: after a factory branch is merged, the default branch's checks for the merge commit must pass.
import { execFile } from "node:child_process"
import { checksState } from "./run.ts"

const gh = (repo: string, args: string[]): Promise<string | null> =>
  new Promise((resolve) => execFile("gh", args, { cwd: repo, timeout: 30_000 }, (err, out) => resolve(err ? null : out)))

/** The merged PR's merge commit, then the check state of that commit on GitHub. */
export const postMergeCheck = async (repo: string, branch: string, waitMs = 45 * 60_000, pollMs = 60_000): Promise<{ ok: boolean; state: string; detail: string }> => {
  const pr = await gh(repo, ["pr", "list", "--head", branch, "--state", "merged", "--limit", "1", "--json", "number,mergeCommit"])
  const merged = pr ? (JSON.parse(pr) as { number: number; mergeCommit: { oid: string } | null }[])[0] : undefined
  if (!merged?.mergeCommit) return { ok: false, state: "UNKNOWN", detail: `no merged PR found for ${branch}` }
  const sha = merged.mergeCommit.oid
  // Checks start after the merge: wait while they are pending, up to `waitMs`.
  let state = "PENDING"
  for (const until = Date.now() + waitMs; state === "PENDING" && Date.now() < until; ) {
    const runs = await gh(repo, ["api", `repos/{owner}/{repo}/commits/${sha}/check-runs`, "--jq", "[.check_runs[] | {status: (.status|ascii_upcase), conclusion: ((.conclusion // \"\")|ascii_upcase)}]"])
    state = runs ? checksState(JSON.parse(runs)) : "NONE"
    if (state === "PENDING") await new Promise((r) => setTimeout(r, pollMs))
  }
  return { ok: state === "SUCCESS" || state === "NONE", state, detail: `PR #${merged.number} merge ${sha.slice(0, 10)} on the default branch: checks ${state}` }
}
