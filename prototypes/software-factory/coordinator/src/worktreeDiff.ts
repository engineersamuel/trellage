// All changes of a worktree against its base commit, for the diff panel: committed, staged, unstaged and untracked.
// Read-only: it never writes the index (no `git add -N`); new files are diffed against /dev/null.
import { execFileSync } from "node:child_process"

export type ChangedFile = {
  path: string
  /** M changed, A added (committed or staged), D deleted, ? untracked. */
  status: "M" | "A" | "D" | "?"
  added: number
  removed: number
  binary: boolean
  /** Unified diff of this file; empty when binary or larger than MAX_PATCH_BYTES. */
  patch: string
  tooLarge: boolean
}
export type WorktreeDiff = { worktree: string; base: string; files: ChangedFile[] }

/** Bytes of patch text sent per file; a larger file shows only its counts. */
export const MAX_PATCH_BYTES = 512 * 1024
/** Untracked files diffed at most (build output that is not ignored can be large). */
export const MAX_UNTRACKED = 200

const run = (cwd: string, args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 << 20 })

/** `git diff --no-index` exits 1 when the files differ; that is the normal case here. */
const runDiffNoIndex = (cwd: string, args: string[]): string => {
  try {
    return run(cwd, args)
  } catch (e) {
    const out = (e as { stdout?: string; status?: number }).stdout
    if ((e as { status?: number }).status === 1 && typeof out === "string") return out
    throw e
  }
}

const lines = (s: string) => s.split("\n").filter(Boolean)

/** Split a multi-file git diff at each `diff --git` line, keyed by the b/ path. */
export const splitPatch = (text: string): Map<string, string> => {
  const out = new Map<string, string>()
  const parts = text.split(/^(?=diff --git )/m).filter((p) => p.startsWith("diff --git "))
  for (const p of parts) {
    const m = p.match(/^diff --git a\/(.*) b\/(.*)$/m)
    if (m) out.set(m[2]!, p)
  }
  return out
}

const limit = (patch: string) => (patch.length > MAX_PATCH_BYTES ? { patch: "", tooLarge: true } : { patch, tooLarge: false })

/** Files changed in `worktree` since `base`, sorted by path. */
export const worktreeDiff = (worktree: string, base: string): WorktreeDiff => {
  const flags = ["--no-renames", "--no-color", "--no-ext-diff"]
  const status = new Map<string, ChangedFile["status"]>()
  for (const l of lines(run(worktree, ["diff", ...flags, "--name-status", base]))) {
    const [s, p] = l.split("\t")
    status.set(p!, s === "A" ? "A" : s === "D" ? "D" : "M")
  }
  const counts = new Map<string, { added: number; removed: number; binary: boolean }>()
  for (const l of lines(run(worktree, ["diff", ...flags, "--numstat", base]))) {
    const [a, r, p] = l.split("\t")
    counts.set(p!, { added: a === "-" ? 0 : Number(a), removed: r === "-" ? 0 : Number(r), binary: a === "-" })
  }
  const patches = splitPatch(run(worktree, ["diff", ...flags, base]))
  const files: ChangedFile[] = [...status].map(([path, s]) => ({
    path,
    status: s,
    ...(counts.get(path) ?? { added: 0, removed: 0, binary: false }),
    ...limit(patches.get(path) ?? ""),
  }))
  for (const path of lines(run(worktree, ["ls-files", "--others", "--exclude-standard"])).slice(0, MAX_UNTRACKED)) {
    const patch = runDiffNoIndex(worktree, ["diff", "--no-index", "--no-color", "--", "/dev/null", path])
    const binary = /^Binary files /m.test(patch)
    const added = binary ? 0 : patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).length
    files.push({ path, status: "?", added, removed: 0, binary, ...limit(patch) })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { worktree, base, files }
}
