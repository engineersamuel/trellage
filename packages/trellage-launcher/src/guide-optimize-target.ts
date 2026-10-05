import { createHash } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, open, readlink, realpath } from "node:fs/promises"
import path from "node:path"
import { CommandRunnerError, parseGitWorktreeList, type CommandRunner } from "./guide-launch.ts"
import { array, boolean, exactKeys, literal, record, text } from "./guide-text.ts"

export type GuideOptimizeScope =
  | { readonly kind: "uncommitted" }
  | { readonly kind: "current-branch" }
  | { readonly kind: "branch"; readonly baseRef: string }

export interface GuideOptimizeChange {
  readonly path: string
  readonly staged: boolean
  readonly unstaged: boolean
  readonly untracked: boolean
  readonly committed: boolean
  readonly kind: "file" | "deleted" | "symlink" | "unsupported"
  readonly fingerprint: string
}

export interface GuideOptimizeTarget {
  readonly cwd: string
  readonly gitDirectory: string
  readonly head: string | null
  readonly scope: Exclude<GuideOptimizeScope, { readonly kind: "current-branch" }>
  readonly base?: { readonly ref: string; readonly commit: string; readonly mergeBase: string }
  readonly changes: ReadonlyArray<GuideOptimizeChange>
  readonly fingerprint: string
}

const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const objectId = (value: string): string => {
  const result = value.trim()
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(result)) throw new Error("Git returned an invalid commit or object ID.")
  return result
}

const missingPath = (cause: unknown): boolean => cause instanceof Error && "code" in cause && cause.code === "ENOENT"

const gitDirectoryOutput = (value: string): string => {
  const directory = value.endsWith("\n") ? value.slice(0, -1) : value
  if (!path.isAbsolute(directory)) throw new Error("Git did not return an absolute worktree path.")
  return directory
}

const gitReader =
  (runner: CommandRunner, cwd: string, signal?: AbortSignal) =>
  async (args: ReadonlyArray<string>, stdin?: string): Promise<string> =>
    (
      await runner.run("git", ["-c", "core.fsmonitor=false", ...args], {
        cwd,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
        timeoutMs: 30_000,
        ...(signal === undefined ? {} : { signal }),
        ...(stdin === undefined ? {} : { stdin }),
      })
    ).stdout

const headCommit = async (git: ReturnType<typeof gitReader>): Promise<string | null> => {
  try {
    return objectId(await git(["rev-parse", "--verify", "--quiet", "HEAD"]))
  } catch (cause) {
    if (cause instanceof CommandRunnerError && cause.kind === "exited" && cause.exitCode === 1) return null
    throw cause
  }
}

const changedPaths = (value: string): ReadonlyArray<string> => {
  if (value === "") return []
  if (!value.endsWith("\0")) throw new Error("Git returned an incomplete changed-file list.")
  const names = value.slice(0, -1).split("\0")
  for (const name of names) {
    if (
      name.length === 0 ||
      path.isAbsolute(name) ||
      name.split("/").some((part) => part === ".." || part === ".git")
    ) {
      throw new Error("Git returned a path outside the optimization target.")
    }
  }
  return names
}

const sameFile = (before: Stats, after: Stats): boolean =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeMs === after.mtimeMs &&
  before.ctimeMs === after.ctimeMs

const hashRegularFile = async (file: string, before: Stats, signal?: AbortSignal): Promise<string> => {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error("A changed file was replaced during inspection. Refresh the target.")
    }
    const hash = createHash("sha256").update(`${before.mode}\0`)
    for await (const chunk of handle.createReadStream({
      autoClose: false,
      ...(signal === undefined ? {} : { signal }),
    })) {
      hash.update(chunk)
    }
    const after = await lstat(file)
    if (!sameFile(before, after)) {
      throw new Error("A changed file was edited during inspection. Refresh the target.")
    }
    return hash.digest("hex")
  } finally {
    await handle.close()
  }
}

const fingerprintFile = async (
  cwd: string,
  relative: string,
  signal?: AbortSignal,
): Promise<Pick<GuideOptimizeChange, "kind" | "fingerprint">> => {
  signal?.throwIfAborted()
  const file = path.join(cwd, relative)
  let before: Stats
  try {
    if ((await realpath(path.dirname(file))) !== path.dirname(file)) {
      throw new Error(`A changed path has a symbolic-link ancestor: ${JSON.stringify(relative)}.`)
    }
    before = await lstat(file)
  } catch (cause) {
    if (missingPath(cause)) return { kind: "deleted", fingerprint: digest("deleted") }
    throw cause
  }
  if (before.isSymbolicLink()) return { kind: "symlink", fingerprint: digest(await readlink(file)) }
  if (!before.isFile()) return { kind: "unsupported", fingerprint: digest([before.mode, before.ino, before.mtimeMs]) }
  return { kind: "file", fingerprint: await hashRegularFile(file, before, signal) }
}

const currentBranchBase = async (git: ReturnType<typeof gitReader>): Promise<string> => {
  const [referenceList, branch, worktreeList] = await Promise.all([
    git(["for-each-ref", "--format=%(refname)\t%(symref)", "refs/heads/", "refs/remotes/"]),
    git(["branch", "--show-current"]),
    git(["worktree", "list", "--porcelain"]),
  ])
  const references = new Map<string, string>()
  for (const line of referenceList.split("\n")) {
    const [ref, symbolic = ""] = line.split("\t")
    if (ref) references.set(ref, symbolic)
  }
  const remoteDefaults = [...references]
    .filter(([ref, symbolic]) => ref.startsWith("refs/remotes/") && ref.endsWith("/HEAD") && symbolic !== "")
    .map(([, symbolic]) => symbolic)
  const currentRef = `refs/heads/${branch.trim()}`
  const candidates = [
    references.get("refs/remotes/origin/HEAD"),
    ...(remoteDefaults.length === 1 ? remoteDefaults : []),
    "refs/remotes/origin/main",
    "refs/heads/main",
    "refs/remotes/origin/master",
    "refs/heads/master",
    parseGitWorktreeList(worktreeList)[0]?.branch,
  ]
  const base = candidates.find((ref) => ref != null && ref !== currentRef && references.has(ref))
  if (base == null) {
    throw new Error("Cannot detect a comparison base for this branch. Press b to choose one, or use --base.")
  }
  return base
}

const inspectBase = async (
  git: ReturnType<typeof gitReader>,
  scope: GuideOptimizeScope,
  head: string | null,
): Promise<GuideOptimizeTarget["base"]> => {
  if (scope.kind === "uncommitted") return undefined
  if (scope.kind === "current-branch" && head === null) return undefined
  if (head === null) throw new Error("Branch comparison requires an existing commit.")
  const ref = text(
    scope.kind === "current-branch" ? await currentBranchBase(git) : scope.baseRef,
    "Comparison base",
    256,
    { preserve: true },
  ).trim()
  const commit = objectId(await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]))
  return { ref, commit, mergeBase: objectId(await git(["merge-base", head, commit])) }
}

export const guideOptimizeTargetIdentity = async (
  runner: CommandRunner,
  directory: string,
  signal?: AbortSignal,
): Promise<Pick<GuideOptimizeTarget, "cwd" | "gitDirectory">> => {
  const toplevel = await gitReader(runner, directory, signal)(["rev-parse", "--show-toplevel"])
  const cwd = await realpath(gitDirectoryOutput(toplevel))
  const gitDirectory = await realpath(
    gitDirectoryOutput(await gitReader(runner, cwd, signal)(["rev-parse", "--absolute-git-dir"])),
  )
  return { cwd, gitDirectory }
}

export const inspectGuideOptimizeTarget = async (
  runner: CommandRunner,
  directory: string,
  scope: GuideOptimizeScope = { kind: "uncommitted" },
  signal?: AbortSignal,
): Promise<GuideOptimizeTarget> => {
  const initialGit = gitReader(runner, directory, signal)
  const cwd = await realpath(gitDirectoryOutput(await initialGit(["rev-parse", "--show-toplevel"])))
  const git = gitReader(runner, cwd, signal)
  const [gitDirectory, head] = await Promise.all([
    git(["rev-parse", "--absolute-git-dir"]).then((value) => realpath(gitDirectoryOutput(value))),
    headCommit(git),
  ])
  const base = await inspectBase(git, scope, head)
  const indexBase = head ?? objectId(await git(["hash-object", "-t", "tree", "--stdin"], ""))
  const diffFlags = ["--no-ext-diff", "--no-textconv", "--no-renames"]
  const indexArgs = ["diff", "--cached", "--raw", "-z", "--abbrev=64", ...diffFlags, indexBase, "--"]
  const statusArgs = ["status", "--porcelain=v1", "-z", "--untracked-files=all"]
  const [status, index, staged, unstaged, untracked, committed, conflicts] = await Promise.all([
    git(statusArgs),
    git(indexArgs),
    git(["diff", "--cached", "--name-only", "-z", ...diffFlags, indexBase, "--"]).then(changedPaths),
    git(["diff", "--name-only", "-z", ...diffFlags, "--"]).then(changedPaths),
    git(["ls-files", "--others", "--exclude-standard", "-z"]).then(changedPaths),
    base === undefined
      ? Promise.resolve([])
      : git(["diff", "--name-only", "-z", ...diffFlags, base.mergeBase, head ?? indexBase, "--"]).then(changedPaths),
    git(["ls-files", "--unmerged", "-z"]),
  ])
  if (conflicts !== "") throw new Error("Resolve merge conflicts before optimizing changes.")
  const stagedSet = new Set(staged)
  const unstagedSet = new Set(unstaged)
  const untrackedSet = new Set(untracked)
  const committedSet = new Set(committed)
  const names = [...new Set([...staged, ...unstaged, ...untracked, ...committed])].sort()
  const changes: GuideOptimizeChange[] = []
  for (const name of names) {
    changes.push({
      path: name,
      staged: stagedSet.has(name),
      unstaged: unstagedSet.has(name),
      untracked: untrackedSet.has(name),
      committed: committedSet.has(name),
      ...(await fingerprintFile(cwd, name, signal)),
    })
  }
  const [currentStatus, currentIndex, currentHead, currentBase] = await Promise.all([
    git(statusArgs),
    git(indexArgs),
    headCommit(git),
    base === undefined
      ? Promise.resolve(undefined)
      : git(["rev-parse", "--verify", "--end-of-options", `${base.ref}^{commit}`]).then(objectId),
  ])
  if (status !== currentStatus || index !== currentIndex || head !== currentHead || base?.commit !== currentBase) {
    throw new Error("The worktree changed during inspection. Refresh the target before continuing.")
  }
  const stableScope: GuideOptimizeTarget["scope"] =
    base === undefined ? { kind: "uncommitted" } : { kind: "branch", baseRef: base.ref }
  return {
    cwd,
    gitDirectory,
    head,
    scope: stableScope,
    ...(base === undefined ? {} : { base }),
    changes,
    fingerprint: digest({ cwd, gitDirectory, head, base, index, status, changes }),
  }
}

export const selectedGuideOptimizeChanges = (
  target: GuideOptimizeTarget,
  paths: ReadonlyArray<string>,
): ReadonlyArray<GuideOptimizeChange> => {
  if (paths.length === 0) throw new Error("Select at least one changed file.")
  if (new Set(paths).size !== paths.length) throw new Error("The optimization target contains duplicate paths.")
  return paths.map((name) => {
    const change = target.changes.find((entry) => entry.path === name)
    if (change === undefined) throw new Error("A selected path is not part of the inspected change set.")
    if (change.kind === "unsupported" || change.kind === "symlink") {
      throw new Error(
        `Select regular files only; this path is a link, directory, or special file: ${JSON.stringify(name)}.`,
      )
    }
    return change
  })
}

export const assertGuideOptimizeTargetCurrent = async (
  runner: CommandRunner,
  target: GuideOptimizeTarget,
  signal?: AbortSignal,
): Promise<GuideOptimizeTarget> => {
  const current = await inspectGuideOptimizeTarget(runner, target.cwd, target.scope, signal)
  if (current.fingerprint !== target.fingerprint) {
    throw new Error("The worktree or comparison base changed. Refresh and confirm the target again; nothing was sent.")
  }
  return current
}

export const parseGuideOptimizeTarget = (input: unknown): GuideOptimizeTarget => {
  const fields = record(input, "Optimize target")
  exactKeys(fields, "Optimize target", ["cwd", "gitDirectory", "head", "scope", "changes", "fingerprint"], ["base"])
  const scope = record(fields.scope, "scope")
  const kind = literal(scope.kind, "scope.kind", ["uncommitted", "branch"])
  exactKeys(scope, "scope", kind === "branch" ? ["kind", "baseRef"] : ["kind"])
  const parsedScope: GuideOptimizeTarget["scope"] =
    kind === "branch" ? { kind, baseRef: text(scope.baseRef, "baseRef", 256) } : { kind }
  const changes = array(fields.changes, "changes", { maximum: 10_000 }).map((value): GuideOptimizeChange => {
    const entry = record(value, "change")
    exactKeys(entry, "change", ["path", "staged", "unstaged", "untracked", "committed", "kind", "fingerprint"])
    const filename = text(entry.path, "path", 4096, { preserve: true })
    changedPaths(`${filename}\0`)
    return {
      path: filename,
      staged: boolean(entry.staged, "staged"),
      unstaged: boolean(entry.unstaged, "unstaged"),
      untracked: boolean(entry.untracked, "untracked"),
      committed: boolean(entry.committed, "committed"),
      kind: literal(entry.kind, "kind", ["file", "deleted", "symlink", "unsupported"]),
      fingerprint: text(entry.fingerprint, "fingerprint", 128),
    }
  })
  let base: GuideOptimizeTarget["base"]
  if (fields.base !== undefined) {
    const entry = record(fields.base, "base")
    exactKeys(entry, "base", ["ref", "commit", "mergeBase"])
    base = {
      ref: text(entry.ref, "ref", 256),
      commit: objectId(text(entry.commit, "commit", 64)),
      mergeBase: objectId(text(entry.mergeBase, "mergeBase", 64)),
    }
  }
  if (
    (parsedScope.kind === "branch") !== (base !== undefined) ||
    (parsedScope.kind === "branch" && parsedScope.baseRef !== base?.ref)
  )
    throw new Error("Saved Optimize base and scope differ.")
  return {
    cwd: gitDirectoryOutput(text(fields.cwd, "cwd", 4096, { preserve: true })),
    gitDirectory: gitDirectoryOutput(text(fields.gitDirectory, "gitDirectory", 4096, { preserve: true })),
    head: fields.head === null ? null : objectId(text(fields.head, "head", 64)),
    scope: parsedScope,
    changes,
    fingerprint: text(fields.fingerprint, "fingerprint", 128),
    ...(base === undefined ? {} : { base }),
  }
}
