import { execFile } from "node:child_process"
import { copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { githubUrl, type SourceTransport } from "./source.ts"

const execFilePromise = promisify(execFile)
const githubHttpsUrl = /^https:\/\/github\.com\/[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+\.git$/

/** Parse whitespace-separated `<GitHub URL>=<absolute worktree>` development overrides. */
export const devSourceRoots = (value: string | undefined): ReadonlyMap<string, string> => {
  const roots = new Map<string, string>()
  for (const entry of (value ?? "").split(/\s+/).filter(Boolean)) {
    const separator = entry.indexOf("=")
    const repository = separator < 0 ? "" : entry.slice(0, separator)
    const root = separator < 0 ? "" : entry.slice(separator + 1)
    if (!githubHttpsUrl.test(repository) || !path.isAbsolute(root))
      throw new Error(`TRELLAGE_DEV_SOURCES entry must be <https://github.com/OWNER/REPO.git>=<absolute path>: ${entry}`)
    roots.set(repository, root)
  }
  return roots
}

const git = async (
  root: string,
  args: ReadonlyArray<string>,
  environment: Readonly<Record<string, string>> = {},
): Promise<string> =>
  (
    await execFilePromise("git", ["-C", root, ...args], {
      encoding: "utf8",
      env: { ...process.env, ...environment },
    })
  ).stdout.trim()

const withTemporaryDirectory = async <A>(prefix: string, use: (directory: string) => Promise<A>): Promise<A> => {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  try {
    return await use(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const snapshotIdentity = {
  GIT_AUTHOR_NAME: "trellage-dev",
  GIT_AUTHOR_EMAIL: "dev@trellage.invalid",
  GIT_AUTHOR_DATE: "@0 +0000",
  GIT_COMMITTER_NAME: "trellage-dev",
  GIT_COMMITTER_EMAIL: "dev@trellage.invalid",
  GIT_COMMITTER_DATE: "@0 +0000",
}

/** Create a deterministic commit from tracked and untracked, non-ignored worktree files through a private index. */
export const snapshotDevSource = (root: string): Promise<string> =>
  withTemporaryDirectory("trellage-dev-index-", async (directory) => {
    const index = path.join(directory, "index")
    const liveIndex = await git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"])
    await copyFile(liveIndex, index).catch(() => undefined)
    await git(root, ["add", "--all"], { GIT_INDEX_FILE: index })
    const tree = await git(root, ["write-tree"], { GIT_INDEX_FILE: index })
    const head = await git(root, ["rev-parse", "HEAD"])
    return git(root, ["commit-tree", tree, "-p", head, "-m", "trellage development source snapshot"], snapshotIdentity)
  })

const extractCommit = (root: string, commit: string, destination: string): Promise<void> =>
  withTemporaryDirectory("trellage-dev-archive-", async (directory) => {
    const archive = path.join(directory, "source.tar")
    await git(root, ["archive", "--format=tar", "-o", archive, commit])
    await execFilePromise("tar", ["-xf", archive, "-C", destination])
  })

/** Override mapped GitHub repositories with deterministic snapshots of local worktrees. */
export const devSourceTransport = (
  base: SourceTransport,
  roots: ReadonlyMap<string, string>,
): SourceTransport => ({
  ...(base.listTags ? { listTags: base.listTags } : {}),
  resolveRef: (repository, ref) => {
    const root = roots.get(githubUrl(repository))
    return root === undefined ? base.resolveRef(repository, ref) : snapshotDevSource(root)
  },
  fetchCommit: (repository, commit, destination) => {
    const root = roots.get(githubUrl(repository))
    return root === undefined ? base.fetchCommit(repository, commit, destination) : extractCommit(root, commit, destination)
  },
})
