// Repo folders: each conversation belongs to one folder. "general" is a plain folder for the
// global coordinator. A repo folder gives each conversation its own git worktree and branch.
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import path from "node:path"

export type Folder = { id: string; name: string; path: string }
export const GENERAL: Folder = { id: "general", name: "General", path: "" }

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", ["-C", cwd, ...a], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()

/** Main checkout of the repo that contains `p`, so a repo and its worktrees map to one folder. */
export const repoRoot = (p: string): string => {
  try {
    return path.dirname(git(p, "rev-parse", "--path-format=absolute", "--git-common-dir"))
  } catch {
    throw new Error(`'${p}' is not inside a git repository`)
  }
}

/** New folder for a repo, or the existing one when the repo is already a folder. */
export const addFolder = (folders: Folder[], p: string): Folder => {
  const root = repoRoot(p)
  const found = folders.find((f) => f.path === root)
  if (found) return found
  const base = path
    .basename(root)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
  let id = base
  for (let n = 2; id === GENERAL.id || folders.some((f) => f.id === id); n++) id = `${base}-${n}`
  return { id, name: path.basename(root), path: root }
}

/** Default home of conversation worktrees: ~/.trellage/worktrees/<folder>/<id8>. */
export const worktreeRoot = (env = process.env): string =>
  env.SF_WORKTREES ?? path.join(homedir(), ".trellage", "worktrees")

export type Worktree = {
  worktree: string
  branch: string
  base: string
  /** Branch the PR targets: the `baseRef` when it names a branch. */ prBase?: string
}

const branchExists = (repo: string, ref: string): boolean => {
  try {
    git(repo, "rev-parse", "--verify", "-q", ref.startsWith("origin/") ? `refs/remotes/${ref}` : `refs/heads/${ref}`)
    return true
  } catch {
    return false
  }
}

/** Create a worktree on a new branch from `baseRef`, else the remote default branch (or HEAD when there is none). */
export const createWorktree = (repo: string, dir: string, branch: string, baseRef?: string): Worktree => {
  let base: string
  if (baseRef) {
    try {
      base = git(repo, "rev-parse", "--verify", "-q", `${baseRef}^{commit}`)
    } catch {
      throw new Error(`base '${baseRef}' is not a branch or commit in ${repo}`)
    }
  } else
    try {
      base = git(repo, "rev-parse", "--verify", "-q", "refs/remotes/origin/HEAD")
    } catch {
      base = git(repo, "rev-parse", "HEAD")
    }
  git(repo, "worktree", "add", "-q", "-b", branch, dir, base)
  const prBase = baseRef && branchExists(repo, baseRef) ? baseRef.replace(/^origin\//, "") : undefined
  return { worktree: dir, branch, base, ...(prBase ? { prBase } : {}) }
}

const tryGit = (cwd: string, ...a: string[]): string | null => {
  try {
    return git(cwd, ...a)
  } catch {
    return null
  }
}

/** The upstream branch tip the PR targets: origin/<prBase> (or local <prBase>), else origin's default branch. */
const upstreamTip = (workdir: string, prBase?: string): string | null =>
  prBase
    ? (tryGit(workdir, "rev-parse", "--verify", "-q", `refs/remotes/origin/${prBase}^{commit}`) ??
      tryGit(workdir, "rev-parse", "--verify", "-q", `refs/heads/${prBase}^{commit}`))
    : tryGit(workdir, "rev-parse", "--verify", "-q", "refs/remotes/origin/HEAD^{commit}")

/**
 * The branch's base now. After a rebase it is the merge-base of HEAD and the upstream branch; the base recorded at
 * worktree creation is kept when the branch was not rebased onto a newer upstream commit.
 */
export const currentBase = (workdir: string, recorded: string, prBase?: string): string => {
  const up = upstreamTip(workdir, prBase)
  const mb = up && tryGit(workdir, "merge-base", "HEAD", up)
  if (!mb || mb === recorded || mb === tryGit(workdir, "rev-parse", "HEAD")) return recorded
  return tryGit(workdir, "merge-base", "--is-ancestor", recorded, mb) !== null ? mb : recorded
}

/** Fetch origin quietly; false when it fails (offline, no remote). */
export const fetchOrigin = (workdir: string): boolean => tryGit(workdir, "fetch", "-q", "origin") !== null

/** How far the upstream branch moved past the base, and whether rebasing onto it would conflict. Null when unknown. */
export const upstreamState = (
  workdir: string,
  base: string,
  prBase?: string,
): { upstream: string; behind: number; conflicts: boolean } | null => {
  const up = upstreamTip(workdir, prBase)
  if (!up) return null
  const behind = Number(tryGit(workdir, "rev-list", "--count", `${base}..${up}`) ?? "0")
  // merge-tree exits 1 on conflicts (tryGit -> null); it writes objects only, never the worktree or index.
  const conflicts = behind > 0 && tryGit(workdir, "merge-tree", "--write-tree", "HEAD", up) === null
  return { upstream: up, behind, conflicts }
}

/** Merged PR head for a branch, from the GitHub CLI (catches squash and rebase merges). Null when unknown. */
const mergedPrHead = (repo: string, branch: string): string | null => {
  try {
    const out = execFileSync(
      "gh",
      ["pr", "list", "--head", branch, "--state", "merged", "--json", "headRefOid", "--limit", "1"],
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 },
    )
    return (JSON.parse(out) as { headRefOid: string }[])[0]?.headRefOid ?? null
  } catch {
    return null
  }
}

/**
 * True only when the worktree's work is fully merged upstream:
 * no uncommitted changes, at least one commit of its own, and its tip is in origin's default
 * branch (merge commit or fast-forward) or is the head of a merged pull request (squash, rebase).
 */
export const fullyMerged = (repo: string, w: Worktree, prHead = mergedPrHead): boolean => {
  if (tryGit(w.worktree, "status", "--porcelain") !== "") return false
  const tip = tryGit(repo, "rev-parse", w.branch)
  if (!tip || tip === w.base) return false
  tryGit(repo, "fetch", "-q", "origin")
  const upstream = tryGit(repo, "rev-parse", "--verify", "-q", "refs/remotes/origin/HEAD")
  if (upstream && tryGit(repo, "merge-base", "--is-ancestor", tip, upstream) !== null) return true
  return prHead(repo, w.branch) === tip
}

/** Remove a merged worktree and its local branch. The remote branch is left alone. */
export const removeWorktree = (repo: string, w: Worktree): void => {
  git(repo, "worktree", "remove", w.worktree)
  git(repo, "branch", "-D", w.branch)
}

/** Delete a conversation's worktree (uncommitted changes too) and its local branch. A worktree already gone is pruned. */
export const discardWorktree = (repo: string, w: Worktree): void => {
  if (tryGit(repo, "worktree", "remove", "--force", w.worktree) === null) tryGit(repo, "worktree", "prune")
  tryGit(repo, "branch", "-D", w.branch)
}
