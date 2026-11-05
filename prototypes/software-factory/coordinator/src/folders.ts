// Repo folders: each conversation belongs to one folder. "general" is a plain folder for the
// global coordinator. A repo folder gives each conversation its own git worktree and branch.
import { execFileSync } from "node:child_process"
import { homedir } from "node:os"
import path from "node:path"

export type Folder = { id: string; name: string; path: string }
export const GENERAL: Folder = { id: "general", name: "General", path: "" }

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()

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
  const base = path.basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, "-")
  let id = base
  for (let n = 2; id === GENERAL.id || folders.some((f) => f.id === id); n++) id = `${base}-${n}`
  return { id, name: path.basename(root), path: root }
}

/** Default home of conversation worktrees: ~/.trellage/worktrees/<folder>/<id8>. */
export const worktreeRoot = (env = process.env): string => env.SF_WORKTREES ?? path.join(homedir(), ".trellage", "worktrees")

export type Worktree = { worktree: string; branch: string; base: string }

/** Create a worktree on a new branch from `baseRef`, else the remote default branch (or HEAD when there is none). */
export const createWorktree = (repo: string, dir: string, branch: string, baseRef?: string): Worktree => {
  let base: string
  if (baseRef) {
    try {
      base = git(repo, "rev-parse", "--verify", "-q", `${baseRef}^{commit}`)
    } catch {
      throw new Error(`base '${baseRef}' is not a branch or commit in ${repo}`)
    }
  } else try {
    base = git(repo, "rev-parse", "--verify", "-q", "refs/remotes/origin/HEAD")
  } catch {
    base = git(repo, "rev-parse", "HEAD")
  }
  git(repo, "worktree", "add", "-q", "-b", branch, dir, base)
  return { worktree: dir, branch, base }
}

const tryGit = (cwd: string, ...a: string[]): string | null => {
  try {
    return git(cwd, ...a)
  } catch {
    return null
  }
}

/** Merged PR head for a branch, from the GitHub CLI (catches squash and rebase merges). Null when unknown. */
const mergedPrHead = (repo: string, branch: string): string | null => {
  try {
    const out = execFileSync("gh", ["pr", "list", "--head", branch, "--state", "merged", "--json", "headRefOid", "--limit", "1"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 })
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
