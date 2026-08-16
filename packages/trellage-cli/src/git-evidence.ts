import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { createReadStream } from "node:fs"
import { lstat, readlink } from "node:fs/promises"
import path from "node:path"

const gitEvidenceSource = "git-diff" as const
const statusMaxBuffer = 128 * 1024 * 1024
const utf8 = new TextDecoder("utf-8", { fatal: true })

interface StatusPath {
  readonly path: string
  readonly descriptor: string
}

interface GitPathState {
  readonly path: string
  readonly fingerprint: string
}

export interface GitEvidenceSnapshot {
  readonly root: string
  readonly source: typeof gitEvidenceSource
  readonly headCommit: string | null
  readonly porcelainV2Sha256: string
  readonly paths: ReadonlyArray<GitPathState>
}

export interface GitChangedFilesEvidence {
  readonly changedFiles: ReadonlyArray<string> | null
  readonly changedFilesSource: typeof gitEvidenceSource | null
}

const unavailableEvidence = (): GitChangedFilesEvidence => ({
  changedFiles: null,
  changedFilesSource: null,
})

const runGit = (root: string, arguments_: ReadonlyArray<string>): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", root, ...arguments_],
      {
        encoding: null,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
        maxBuffer: statusMaxBuffer,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error)
          return
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout))
      },
    )
  })

const resolveGitRoot = async (candidate: string): Promise<string> => {
  const output = await runGit(candidate, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
  const root = utf8.decode(output).trim()
  if (root.length === 0) throw new Error("Git did not return a worktree root")
  return path.resolve(root)
}

const runGitStatus = (root: string): Promise<Buffer> =>
  runGit(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--renames", "--ignore-submodules=none"])

const resolveHeadCommit = async (root: string): Promise<string | null> => {
  try {
    const output = utf8.decode(await runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim()
    if (!/^[0-9a-f]{40,64}$/u.test(output)) throw new Error("Git returned an invalid HEAD commit")
    return output
  } catch {
    return null
  }
}

const nulFields = (status: Buffer): ReadonlyArray<Buffer> => {
  const fields: Array<Buffer> = []
  let start = 0
  while (start < status.length) {
    const end = status.indexOf(0, start)
    if (end < 0) throw new Error("Git porcelain-v2 output is not NUL terminated")
    fields.push(status.subarray(start, end))
    start = end + 1
  }
  return fields
}

const pathAfterSpaces = (record: string, count: number): string => {
  let offset = 0
  for (let index = 0; index < count; index += 1) {
    const separator = record.indexOf(" ", offset)
    if (separator < 0) throw new Error("Git porcelain-v2 record is malformed")
    offset = separator + 1
  }
  const candidate = record.slice(offset)
  if (candidate.length === 0) throw new Error("Git porcelain-v2 record has an empty path")
  return candidate
}

const parseStatusPaths = (status: Buffer): ReadonlyArray<StatusPath> => {
  const fields = nulFields(status)
  const paths: Array<StatusPath> = []
  for (let index = 0; index < fields.length; index += 1) {
    const record = utf8.decode(fields[index]!)
    if (record.startsWith("1 ")) {
      paths.push({ path: pathAfterSpaces(record, 8), descriptor: record })
      continue
    }
    if (record.startsWith("2 ")) {
      const currentPath = pathAfterSpaces(record, 9)
      const originalField = fields[index + 1]
      if (originalField === undefined) throw new Error("Git porcelain-v2 rename has no original path")
      const originalPath = utf8.decode(originalField)
      if (originalPath.length === 0) throw new Error("Git porcelain-v2 rename has an empty original path")
      const renameDescriptor = `${record}\0${originalPath}`
      paths.push(
        { path: currentPath, descriptor: `current\0${renameDescriptor}` },
        { path: originalPath, descriptor: `original\0${renameDescriptor}` },
      )
      index += 1
      continue
    }
    if (record.startsWith("u ")) {
      paths.push({ path: pathAfterSpaces(record, 10), descriptor: record })
      continue
    }
    if (record.startsWith("? ")) {
      const untrackedPath = record.slice(2)
      if (untrackedPath.length === 0) throw new Error("Git porcelain-v2 record has an empty untracked path")
      paths.push({ path: untrackedPath, descriptor: record })
      continue
    }
    if (record.startsWith("! ") || record.startsWith("# ")) continue
    throw new Error("Git porcelain-v2 output has an unknown record")
  }
  return paths
}

const containedPath = (root: string, candidate: string): string => {
  const absolute = path.resolve(root, candidate)
  const relative = path.relative(root, absolute)
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Git status path escapes the worktree root")
  }
  return absolute
}

const mode = (value: number): string => (value & 0o7777).toString(8).padStart(4, "0")

const fileSha256 = async (file: string): Promise<string> => {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("hex")
}

const contentIdentity = async (root: string, candidate: string): Promise<string> => {
  const absolute = containedPath(root, candidate)
  try {
    const metadata = await lstat(absolute)
    if (metadata.isFile()) {
      return `file:${mode(metadata.mode)}:${metadata.size}:sha256:${await fileSha256(absolute)}`
    }
    if (metadata.isSymbolicLink()) {
      const target = await readlink(absolute, { encoding: "buffer" })
      return `symlink:${mode(metadata.mode)}:sha256:${createHash("sha256").update(target).digest("hex")}`
    }
    if (metadata.isDirectory()) return `directory:${mode(metadata.mode)}`
    return `special:${mode(metadata.mode)}:${metadata.size}:${metadata.mtimeMs}`
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return "missing"
    throw error
  }
}

const pathStates = async (
  root: string,
  statusPaths: ReadonlyArray<StatusPath>,
): Promise<ReadonlyArray<GitPathState>> => {
  const descriptors = new Map<string, Array<string>>()
  for (const statusPath of statusPaths) {
    const values = descriptors.get(statusPath.path)
    if (values === undefined) descriptors.set(statusPath.path, [statusPath.descriptor])
    else values.push(statusPath.descriptor)
  }

  const states: Array<GitPathState> = []
  for (const candidate of [...descriptors.keys()].sort()) {
    const identity = await contentIdentity(root, candidate)
    states.push(
      Object.freeze({
        path: candidate,
        fingerprint: JSON.stringify({
          descriptors: descriptors.get(candidate)!.sort(),
          identity,
        }),
      }),
    )
  }
  return Object.freeze(states)
}

const commitChangedPaths = async (
  before: GitEvidenceSnapshot,
  after: GitEvidenceSnapshot,
): Promise<ReadonlyArray<string>> => {
  if (before.headCommit === after.headCommit) return []

  let output: Buffer
  if (before.headCommit !== null && after.headCommit !== null) {
    output = await runGit(after.root, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      before.headCommit,
      after.headCommit,
      "--",
    ])
  } else {
    const commit = after.headCommit ?? before.headCommit
    if (commit === null) return []
    output = await runGit(after.root, [
      "diff-tree",
      "--root",
      "--no-commit-id",
      "--name-only",
      "-r",
      "-z",
      "--no-renames",
      commit,
      "--",
    ])
  }

  return Object.freeze(
    nulFields(output).map((field) => {
      const candidate = utf8.decode(field)
      if (candidate.length === 0) throw new Error("Git commit diff has an empty path")
      containedPath(after.root, candidate)
      return candidate
    }),
  )
}

export const captureGitEvidenceSnapshot = async (gitRoot: string): Promise<GitEvidenceSnapshot | null> => {
  try {
    const root = await resolveGitRoot(path.resolve(gitRoot))
    const headCommit = await resolveHeadCommit(root)
    const status = await runGitStatus(root)
    return Object.freeze({
      root,
      source: gitEvidenceSource,
      headCommit,
      porcelainV2Sha256: `sha256:${createHash("sha256").update(status).digest("hex")}`,
      paths: await pathStates(root, parseStatusPaths(status)),
    })
  } catch {
    return null
  }
}

export const compareGitEvidenceSnapshots = (
  before: GitEvidenceSnapshot | null,
  after: GitEvidenceSnapshot | null,
): Promise<GitChangedFilesEvidence> => {
  return compareSnapshots(before, after)
}

const compareSnapshots = async (
  before: GitEvidenceSnapshot | null,
  after: GitEvidenceSnapshot | null,
): Promise<GitChangedFilesEvidence> => {
  if (before === null || after === null || before.root !== after.root) return unavailableEvidence()
  const beforePaths = new Map(before.paths.map((entry) => [entry.path, entry.fingerprint]))
  const afterPaths = new Map(after.paths.map((entry) => [entry.path, entry.fingerprint]))
  const statusChangedPaths = [...new Set([...beforePaths.keys(), ...afterPaths.keys()])].filter(
    (candidate) => beforePaths.get(candidate) !== afterPaths.get(candidate),
  )
  const changedFiles = [...new Set([...statusChangedPaths, ...(await commitChangedPaths(before, after))])].sort()
  return Object.freeze({
    changedFiles: Object.freeze(changedFiles),
    changedFilesSource: gitEvidenceSource,
  })
}
