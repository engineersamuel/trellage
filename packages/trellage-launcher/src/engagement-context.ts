import { createHash } from "node:crypto"
import { constants, type Stats } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { CommandRunnerError, type CommandRunner } from "./guide-launch.ts"
import { array, boolean, exactKeys, record, text, uniqueArray } from "./guide-text.ts"

export const engagementDefaultIntent = "What's the next step in this engagement?"
export const engagementManifestPath = "engagement/guide.json"
export const engagementContextSource = "@user-context"
export const engagementLimits = {
  files: 64,
  inventory: 512,
  fileBytes: 64_000,
  snapshotBytes: 128_000,
  recordBytes: 1_000_000,
  contextCharacters: 8_000,
} as const

export interface EngagementSource {
  readonly path: string
  readonly content: string
  readonly digest: string
  readonly tracked: boolean
}

export interface EngagementSnapshot {
  readonly schemaVersion: 1
  readonly head: string | null
  readonly sources: ReadonlyArray<EngagementSource>
  readonly context: string
  readonly fingerprint: string
}

export interface EngagementRepository {
  readonly root: string
  readonly files: ReadonlyArray<string>
  readonly selected: ReadonlyArray<string>
  readonly notices: ReadonlyArray<string>
}

export const engagementDigest = (value: string): string => createHash("sha256").update(value).digest("hex")

export const engagementPath = (value: unknown): string => {
  const filename = text(value, "repository path", 1024, { preserve: true })
  const parts = filename.split("/")
  if (
    filename === engagementContextSource ||
    path.isAbsolute(filename) ||
    filename.includes("\\") ||
    parts.some(
      (part) =>
        part === "" ||
        part === "." ||
        part === ".." ||
        [".git", "node_modules", ".trx-guide", ".ssh"].includes(part.toLowerCase()) ||
        /^\.env(?:\.|$)/iu.test(part),
    )
  ) {
    throw new Error(`Unsafe engagement path: ${filename}`)
  }
  return filename
}

export const isMissingEngagementFile = (error: unknown): boolean =>
  error instanceof Error && "code" in error && error.code === "ENOENT"

export const engagementErrorMessage = (cause: unknown): string => {
  if (cause instanceof CommandRunnerError) return [cause.message, cause.stderr.trim()].filter(Boolean).join("\n")
  return cause instanceof Error ? cause.message : String(cause)
}

export const checkEngagementParents = async (root: string, filename: string): Promise<string> => {
  const parts = engagementPath(filename).split("/")
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part)
    const metadata = await lstat(current)
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`Engagement paths require real directories: ${filename}`)
    }
  }
  return path.join(root, ...parts)
}

const requireRegularSource = (metadata: Stats, filename: string, maximum: number): void => {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > maximum) {
    throw new Error(`Engagement source must be a regular, single-link file within ${maximum} bytes: ${filename}`)
  }
}

export const readEngagementFile = async (
  root: string,
  filename: string,
  maximum: number = engagementLimits.fileBytes,
): Promise<string> => {
  const absolute = await checkEngagementParents(root, filename)
  const entry = await lstat(absolute)
  requireRegularSource(entry, filename, maximum)
  const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await handle.stat()
    requireRegularSource(before, filename, maximum)
    const buffer = Buffer.alloc(maximum + 1)
    let size = 0
    while (size < buffer.length) {
      const result = await handle.read(buffer, size, buffer.length - size, size)
      if (result.bytesRead === 0) break
      size += result.bytesRead
    }
    const after = await handle.stat()
    const current = await lstat(await checkEngagementParents(root, filename))
    if (
      size > maximum ||
      before.size !== size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      current.isSymbolicLink() ||
      current.ino !== before.ino ||
      current.dev !== before.dev
    ) {
      throw new Error(`Engagement source changed while reading: ${filename}`)
    }
    const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, size))
    if (content.length > 0) text(content, filename, maximum, { multiline: true, preserve: true })
    return content
  } finally {
    await handle.close()
  }
}

const git = async (runner: CommandRunner, root: string, args: ReadonlyArray<string>): Promise<string> =>
  (
    await runner.run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
      cwd: root,
      timeoutMs: 10_000,
    })
  ).stdout

const documentPath = (filename: string): boolean =>
  /\.(?:md|mdx|txt|ya?ml)$/iu.test(filename) &&
  (!filename.startsWith("engagement/work/") || /^engagement\/work\/[a-f0-9-]+\.md$/u.test(filename)) &&
  !filename.split("/").some((part) => ["vendor", "dist", "build", ".agents", ".github"].includes(part))

export const defaultEngagementSources = (files: ReadonlyArray<string>): ReadonlyArray<string> => {
  const preferred = files.filter(
    (filename) =>
      filename.startsWith("docs/engagement/") ||
      filename.startsWith("engagement/work/") ||
      filename.startsWith(".copilot-tracking/dt/") ||
      filename.startsWith(".copilot-tracking/mve/"),
  )
  if (preferred.length > 0) return preferred

  const ranked = files
    .map((filename) => {
      const basename = path.basename(filename).toLowerCase()
      const lower = filename.toLowerCase()
      const score = /^readme\.md$/iu.test(filename)
        ? 100
        : /^(?:open-questions|current-status|project-status|next-steps|roadmap)(?:[.-]|$)/u.test(basename)
          ? 95
          : lower.startsWith("docs/") &&
              /(?:requirements|discovery|recommendations|clarification|decision|plan)/u.test(basename)
            ? 80
            : /^architecture\/readme\.md$/u.test(lower)
              ? 60
              : 0
      return { filename, score }
    })
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.filename.localeCompare(right.filename))
    .slice(0, 5)
    .map(({ filename }) => filename)
  return ranked.length > 0 ? ranked : files.filter((filename) => /^readme\.md$/iu.test(filename))
}

const hveDocuments = async (root: string): Promise<ReadonlyArray<string>> => {
  const result: string[] = []
  let visited = 0
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8) throw new Error(`HVE evidence nesting exceeds eight levels: ${directory}`)
    let entries
    try {
      const absolute = await checkEngagementParents(root, `${directory}/entry`)
      entries = await readdir(path.dirname(absolute), { withFileTypes: true })
    } catch (error) {
      if (isMissingEngagementFile(error)) return
      throw error
    }
    for (const entry of entries) {
      if (++visited > engagementLimits.inventory) {
        throw new Error("Too many HVE artifacts. Use engagement/guide.json to select explicit source paths.")
      }
      const filename = `${directory}/${entry.name}`
      if (entry.isSymbolicLink()) throw new Error(`Symlinked HVE evidence is not supported: ${filename}`)
      if (entry.isDirectory()) await walk(filename, depth + 1)
      else if (entry.isFile() && documentPath(filename)) result.push(engagementPath(filename))
    }
  }
  for (const directory of [".copilot-tracking/dt", ".copilot-tracking/mve"]) await walk(directory, 0)
  return result
}

export const inspectEngagementRepository = async (
  runner: CommandRunner,
  cwd: string,
): Promise<EngagementRepository> => {
  const root = await realpath((await git(runner, cwd, ["rev-parse", "--show-toplevel"])).trim())
  let configured: ReadonlyArray<string> | undefined
  try {
    const manifest = record(JSON.parse(await readEngagementFile(root, engagementManifestPath)), engagementManifestPath)
    exactKeys(manifest, engagementManifestPath, ["schemaVersion", "sources"])
    if (manifest.schemaVersion !== 1) throw new Error("engagement/guide.json requires schemaVersion 1")
    configured = uniqueArray(
      array(manifest.sources, "sources", { minimum: 1, maximum: engagementLimits.files }).map(engagementPath),
      "sources",
      "paths",
    )
  } catch (error) {
    if (!isMissingEngagementFile(error)) throw error
  }
  const discovered = (
    await git(runner, root, [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      ...(configured === undefined ? [] : ["--", "engagement/work/"]),
    ])
  )
    .split("\0")
    .filter((filename) => filename && documentPath(filename))
    .map(engagementPath)
  const files = uniqueArray(
    [...(configured ?? []), ...discovered, ...(configured === undefined ? await hveDocuments(root) : [])]
      .filter((filename, index, all) => all.indexOf(filename) === index)
      .sort(),
    "sources",
    "paths",
  )
  if (files.length > engagementLimits.inventory) {
    throw new Error("Too many repository documents. Use engagement/guide.json to select explicit source paths.")
  }
  const selected = configured === undefined ? defaultEngagementSources(files) : files
  return {
    root,
    files,
    selected,
    notices: [
      configured === undefined
        ? "Document discovery only: code, binary files, and most ignored files are not included. Select sources before assessment."
        : "Sources come from engagement/guide.json and recorded Guide review notes. Other files are not assessment evidence.",
      "HVE artifacts can be untracked or ignored. Repository presence is not customer approval or permission to share.",
    ],
  }
}

const snapshotFingerprint = (snapshot: Omit<EngagementSnapshot, "fingerprint">): string =>
  engagementDigest(JSON.stringify(snapshot))

export const captureEngagementSnapshot = async (
  runner: CommandRunner,
  root: string,
  paths: ReadonlyArray<string>,
  context: string,
): Promise<EngagementSnapshot> => {
  uniqueArray(paths, "sources", "paths")
  if (paths.length === 0 || paths.length > engagementLimits.files) {
    throw new Error(`Select between 1 and ${engagementLimits.files} evidence files.`)
  }
  if (context) text(context, "your context", engagementLimits.contextCharacters, { multiline: true, preserve: true })
  const tracked = new Set(
    (await git(runner, root, ["--literal-pathspecs", "ls-files", "-z", "--", ...paths])).split("\0"),
  )
  let head: string | null
  try {
    head = (await git(runner, root, ["rev-parse", "--verify", "--quiet", "HEAD"])).trim()
  } catch (error) {
    if (!(error instanceof CommandRunnerError) || error.kind !== "exited" || error.exitCode !== 1) throw error
    head = null
  }
  const sources: EngagementSource[] = []
  let total = 0
  for (const filename of [...paths].sort()) {
    const content = await readEngagementFile(root, filename)
    total += Buffer.byteLength(content)
    if (total > engagementLimits.snapshotBytes) {
      throw new Error(
        `Selected evidence exceeds ${engagementLimits.snapshotBytes} bytes. Select fewer sources; nothing was truncated.`,
      )
    }
    sources.push({ path: filename, content, digest: engagementDigest(content), tracked: tracked.has(filename) })
  }
  const snapshot = { schemaVersion: 1 as const, head, sources, context }
  return { ...snapshot, fingerprint: snapshotFingerprint(snapshot) }
}

export const parseEngagementSnapshot = (input: unknown): EngagementSnapshot => {
  const fields = record(input, "snapshot")
  exactKeys(fields, "snapshot", ["schemaVersion", "head", "sources", "context", "fingerprint"])
  if (fields.schemaVersion !== 1) throw new Error("Unsupported engagement snapshot version")
  const head = fields.head === null ? null : text(fields.head, "head", 64)
  if (head !== null && !/^[a-f0-9]{40,64}$/u.test(head)) throw new Error("Invalid snapshot Git revision")
  const sources = array(fields.sources, "sources", { minimum: 1, maximum: engagementLimits.files }).map((value) => {
    const source = record(value, "source")
    exactKeys(source, "source", ["path", "content", "digest", "tracked"])
    const content =
      source.content === ""
        ? ""
        : text(source.content, "source.content", engagementLimits.fileBytes, { multiline: true, preserve: true })
    if (Buffer.byteLength(content) > engagementLimits.fileBytes) throw new Error("Stored source exceeds its byte limit")
    const digest = text(source.digest, "source.digest", 64)
    if (digest !== engagementDigest(content)) throw new Error("Stored evidence digest does not match its contents")
    return { path: engagementPath(source.path), content, digest, tracked: boolean(source.tracked, "source.tracked") }
  })
  uniqueArray(
    sources.map((source) => source.path),
    "sources",
    "paths",
  )
  if (sources.reduce((sum, source) => sum + Buffer.byteLength(source.content), 0) > engagementLimits.snapshotBytes) {
    throw new Error("Stored evidence exceeds the snapshot byte limit")
  }
  const context =
    fields.context === ""
      ? ""
      : text(fields.context, "context", engagementLimits.contextCharacters, { multiline: true, preserve: true })
  const snapshot = { schemaVersion: 1 as const, head, sources, context }
  const fingerprint = text(fields.fingerprint, "fingerprint", 64)
  if (fingerprint !== snapshotFingerprint(snapshot)) throw new Error("Stored engagement snapshot was changed")
  return { ...snapshot, fingerprint }
}

export const assertEngagementSnapshotCurrent = async (
  runner: CommandRunner,
  root: string,
  snapshot: EngagementSnapshot,
): Promise<void> => {
  const current = await captureEngagementSnapshot(
    runner,
    root,
    snapshot.sources.map((source) => source.path),
    snapshot.context,
  )
  if (current.fingerprint !== snapshot.fingerprint) {
    throw new Error(
      "Engagement evidence or Git revision changed. Reload and assess again before preparing or launching.",
    )
  }
}
