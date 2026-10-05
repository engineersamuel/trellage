import { createHash } from "node:crypto"
import { lstat } from "node:fs/promises"
import path from "node:path"
import type { Tool, ToolResultObject } from "@github/copilot-sdk"
import { engagementPath, readEngagementFile } from "./engagement-context.ts"
import type { CommandRunner } from "./guide-launch.ts"
import {
  assertGuideOptimizeTargetCurrent,
  selectedGuideOptimizeChanges,
  type GuideOptimizeTarget,
} from "./guide-optimize-target.ts"
import { boundedNumber, exactKeys, GuideValidationError, record, text } from "./guide-text.ts"

export const optimizeEvidenceLimits = {
  files: 5000,
  fileBytes: 1_000_000,
  totalBytes: 32_000_000,
  toolCalls: 120,
  toolLines: 200,
  toolBytes: 768_000,
  toolResponseBytes: 16_000,
} as const

export interface OptimizeSource {
  readonly id: string
  readonly content: string
}

export interface OptimizeSourceRange {
  readonly source: string
  readonly startLine: number
  readonly endLine: number
}

export interface OptimizeEvidence {
  readonly fingerprint: string
  readonly sources: ReadonlyArray<OptimizeSource>
  readonly excluded: ReadonlyArray<{ readonly path: string; readonly reason: string }>
}

export const optimizeDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex")

const sourceReason = (filename: string): string | undefined => {
  if (filename.startsWith("@diff/") || filename.startsWith("@skill/")) return "reserved evidence path"
  try {
    engagementPath(filename)
  } catch {
    return "private or unsafe path"
  }
  if (
    /(?:^|\/)(?:credentials?|secrets?|id_rsa|id_ed25519)(?:\.|\/|$)/iu.test(filename) ||
    /\.(?:pem|key|p12|pfx)$/iu.test(filename)
  )
    return "credential-like path"
  if (/\.(?:png|jpe?g|gif|ico|webp|pdf|zip|gz|woff2?|ttf|mp4|mov|sqlite|db|wasm)$/iu.test(filename))
    return "binary format"
  return undefined
}

const snapshotGit = async (
  runner: CommandRunner,
  target: GuideOptimizeTarget,
  args: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<string> =>
  (
    await runner.run("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", ...args], {
      cwd: target.cwd,
      signal,
      timeoutMs: 30_000,
      outputOverflow: "terminate",
      env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    })
  ).stdout

const addCurrentSource = async (
  target: GuideOptimizeTarget,
  filename: string,
  selected: ReadonlySet<string>,
  sources: OptimizeSource[],
  excluded: { path: string; reason: string }[],
): Promise<void> => {
  let reason = sourceReason(filename)
  if (reason === undefined) {
    const metadata = await lstat(path.join(target.cwd, filename))
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
      reason = "not a regular single-link file"
    else if (metadata.size > optimizeEvidenceLimits.fileBytes) reason = "file exceeds the snapshot byte limit"
  }
  if (reason !== undefined) {
    if (selected.has(filename))
      throw new Error(`Cannot review ${JSON.stringify(filename)}: ${reason}. Exclude it explicitly.`)
    excluded.push({ path: filename, reason })
    return
  }
  try {
    const content = await readEngagementFile(target.cwd, filename, optimizeEvidenceLimits.fileBytes, {
      allowBlank: true,
    })
    sources.push({ id: filename, content })
  } catch (cause) {
    const notText =
      cause instanceof GuideValidationError ||
      (cause instanceof TypeError && "code" in cause && cause.code === "ERR_ENCODING_INVALID_ENCODED_DATA")
    if (!notText) throw cause
    if (selected.has(filename))
      throw new Error(
        `Cannot review ${JSON.stringify(filename)}: unsupported UTF-8 source text. Exclude it explicitly.`,
        { cause },
      )
    excluded.push({ path: filename, reason: "not supported UTF-8 source text" })
  }
}

export const captureOptimizeEvidence = async (
  runner: CommandRunner,
  target: GuideOptimizeTarget,
  paths: ReadonlyArray<string>,
  signal: AbortSignal,
): Promise<OptimizeEvidence> => {
  const changes = selectedGuideOptimizeChanges(target, paths)
  for (const filename of paths) {
    const reason = sourceReason(filename)
    if (reason !== undefined)
      throw new Error(`Cannot review ${JSON.stringify(filename)}: ${reason}. Exclude it explicitly.`)
  }
  await assertGuideOptimizeTargetCurrent(runner, target, signal)
  const tracked = (await snapshotGit(runner, target, ["ls-files", "-z"], signal)).split("\0").filter(Boolean)
  const names = [
    ...new Set([...tracked, ...changes.filter((entry) => entry.untracked).map((entry) => entry.path)]),
  ].sort()
  if (names.length > optimizeEvidenceLimits.files)
    throw new Error("Repository snapshot exceeds 5000 files; review is blocked, not truncated.")
  const selected = new Set(paths)
  const deleted = new Set(target.changes.filter((entry) => entry.kind === "deleted").map((entry) => entry.path))
  const sources: OptimizeSource[] = []
  const excluded: { path: string; reason: string }[] = []
  let bytes = 0
  for (const filename of names) {
    signal.throwIfAborted()
    if (deleted.has(filename)) continue
    const count = sources.length
    await addCurrentSource(target, filename, selected, sources, excluded)
    if (sources.length > count) bytes += Buffer.byteLength(sources[sources.length - 1]!.content)
    if (bytes > optimizeEvidenceLimits.totalBytes)
      throw new Error("Repository snapshot exceeds 32 MB; review is blocked, not truncated.")
  }
  const flags = ["--no-ext-diff", "--no-textconv", "--no-renames", "--unified=5"]
  const literalPaths = paths.map((filename) => `:(literal)${filename}`)
  const diffs: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
    ["@diff/staged", ["diff", "--cached", ...flags, "--", ...literalPaths]],
    ["@diff/unstaged", ["diff", ...flags, "--", ...literalPaths]],
    ...(target.base === undefined
      ? []
      : [["@diff/committed", ["diff", ...flags, target.base.mergeBase, target.head!, "--", ...literalPaths]] as const]),
  ]
  for (const [id, args] of diffs) {
    const content = await snapshotGit(runner, target, args, signal)
    bytes += Buffer.byteLength(content)
    if (bytes > optimizeEvidenceLimits.totalBytes)
      throw new Error("Review evidence exceeds 32 MB; nothing was truncated.")
    sources.push({ id, content })
  }
  await assertGuideOptimizeTargetCurrent(runner, target, signal)
  return { sources, excluded, fingerprint: optimizeDigest({ sources, excluded }) }
}

const integer = (value: unknown, name: string, minimum: number, maximum: number): number => {
  const result = boundedNumber(value, name, minimum, maximum)
  if (!Number.isInteger(result)) throw new Error(`${name} must be an integer.`)
  return result
}

const readSource = (evidence: OptimizeEvidence, input: unknown) => {
  const fields = record(input, "read_review_source")
  exactKeys(fields, "read_review_source", ["source", "startLine", "lineCount"])
  const source = evidence.sources.find((entry) => entry.id === fields.source)
  if (source === undefined) throw new Error("Source is not in the frozen review snapshot.")
  const lines = source.content.split("\n")
  const start = integer(fields.startLine, "startLine", 1, lines.length)
  const count = integer(fields.lineCount, "lineCount", 1, optimizeEvidenceLimits.toolLines)
  return {
    source: source.id,
    totalLines: lines.length,
    startLine: start,
    endLine: Math.min(start + count - 1, lines.length),
    lines: Object.fromEntries(lines.slice(start - 1, start - 1 + count).map((value, index) => [start + index, value])),
    nextLine: start + count <= lines.length ? start + count : null,
  }
}

const searchSources = (evidence: OptimizeEvidence, input: unknown): unknown => {
  const fields = record(input, "search_review_sources")
  exactKeys(fields, "search_review_sources", ["query", "pathContains", "offset"])
  const query = text(fields.query, "query", 200, { preserve: true })
  if (typeof fields.pathContains !== "string" || fields.pathContains.length > 200)
    throw new Error("Invalid path filter.")
  const offset = integer(fields.offset, "offset", 0, 100_000)
  const matches: { source: string; line: number }[] = []
  let total = 0
  for (const source of evidence.sources) {
    if (!source.id.includes(fields.pathContains)) continue
    source.content.split("\n").forEach((line, index) => {
      if (!line.includes(query)) return
      if (total >= offset && matches.length < 60) matches.push({ source: source.id, line: index + 1 })
      total += 1
    })
  }
  return { matches, total, nextOffset: offset + matches.length < total ? offset + matches.length : null }
}

export const optimizeEvidenceTools = (
  evidence: OptimizeEvidence,
  signal: AbortSignal,
  requiredRanges: ReadonlyArray<OptimizeSourceRange> = [],
) => {
  let calls = 0
  let bytes = 0
  let byteBudget: number = optimizeEvidenceLimits.toolBytes
  let fatal: Error | undefined
  const readLines = new Map<string, Set<number>>()
  const firstUnreadRange = (
    range: OptimizeSourceRange,
    delivered?: OptimizeSourceRange,
  ): OptimizeSourceRange | undefined => {
    const seen = readLines.get(range.source)
    const isRead = (line: number): boolean =>
      seen?.has(line) === true ||
      (delivered?.source === range.source && line >= delivered.startLine && line <= delivered.endLine)
    let startLine = range.startLine
    while (startLine <= range.endLine && isRead(startLine)) startLine += 1
    if (startLine > range.endLine) return undefined
    let endLine = startLine
    while (endLine < range.endLine && !isRead(endLine + 1)) endLine += 1
    return { source: range.source, startLine, endLine }
  }
  const failBudget = (message: string): never => {
    fatal = new Error(message)
    throw fatal
  }
  const handle =
    (operation: (input: unknown) => unknown, after?: (input: unknown) => void) =>
    (input: unknown): ToolResultObject => {
      signal.throwIfAborted()
      if (fatal !== undefined) throw fatal
      if (++calls > optimizeEvidenceLimits.toolCalls)
        failBudget("Review tool-call budget exhausted. Reduce the selected scope.")
      bytes += Buffer.byteLength(JSON.stringify(input)) + 256
      if (bytes > byteBudget) failBudget("Review evidence budget exhausted. Reduce the selected scope.")
      const output = JSON.stringify(operation(input))
      const size = Buffer.byteLength(output)
      if (size > optimizeEvidenceLimits.toolResponseBytes)
        throw new Error("Read fewer lines; this response exceeds 16000 bytes.")
      bytes += size
      if (bytes > byteBudget) failBudget("Review evidence budget exhausted. Reduce the selected scope.")
      after?.(input)
      return { resultType: "success", textResultForLlm: output }
    }
  const tools: ReadonlyArray<Tool> = [
    {
      name: "list_review_sources",
      description: "List frozen source IDs and line counts, filtered by a literal substring.",
      skipPermission: true,
      defer: "never",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["pathContains", "offset"],
        properties: { pathContains: { type: "string" }, offset: { type: "integer", minimum: 0 } },
      },
      handler: handle((input) => {
        const fields = record(input, "list_review_sources")
        exactKeys(fields, "list_review_sources", ["pathContains", "offset"])
        if (typeof fields.pathContains !== "string" || fields.pathContains.length > 200)
          throw new Error("Invalid path filter.")
        const filter = fields.pathContains
        const offset = integer(fields.offset, "offset", 0, optimizeEvidenceLimits.files + 5)
        const sources = evidence.sources.filter((entry) => entry.id.includes(filter))
        const excluded = evidence.excluded.filter((entry) => entry.path.includes(filter))
        return {
          sources: sources
            .slice(offset, offset + 60)
            .map((entry) => ({ id: entry.id, lines: entry.content.split("\n").length })),
          excluded: excluded.slice(offset, offset + 60),
          total: sources.length,
          excludedTotal: excluded.length,
          nextOffset: offset + 60 < Math.max(sources.length, excluded.length) ? offset + 60 : null,
        }
      }),
    },
    {
      name: "read_review_source",
      description:
        "Read frozen source or diff text. The lines object maps absolute line numbers to exact text. remainingRequired lists the next required gaps (at most three); keep reading until it is empty. No live filesystem access.",
      skipPermission: true,
      defer: "never",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["source", "startLine", "lineCount"],
        properties: {
          source: { type: "string" },
          startLine: { type: "integer", minimum: 1 },
          lineCount: { type: "integer", minimum: 1, maximum: optimizeEvidenceLimits.toolLines },
        },
      },
      handler: handle(
        (input) => {
          const page = readSource(evidence, input)
          const remainingRequired = requiredRanges.flatMap((range) => {
            const unread = firstUnreadRange(range, page)
            return unread === undefined ? [] : [unread]
          })
          return { ...page, remainingRequired: remainingRequired.slice(0, 3) }
        },
        (input) => {
          const fields = record(input, "read_review_source")
          const id = text(fields.source, "source", 4096, { preserve: true })
          const source = evidence.sources.find((entry) => entry.id === id)!
          const start = integer(fields.startLine, "startLine", 1, source.content.split("\n").length)
          const count = integer(fields.lineCount, "lineCount", 1, optimizeEvidenceLimits.toolLines)
          const lines = readLines.get(id) ?? new Set<number>()
          for (let line = start; line < start + count; line++) lines.add(line)
          readLines.set(id, lines)
        },
      ),
    },
    {
      name: "search_review_sources",
      description: "Literal search across frozen source text. Returns locations; read the source for evidence.",
      skipPermission: true,
      defer: "never",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query", "pathContains", "offset"],
        properties: {
          query: { type: "string" },
          pathContains: { type: "string" },
          offset: { type: "integer", minimum: 0 },
        },
      },
      handler: handle((input) => searchSources(evidence, input)),
    },
  ]
  return {
    tools,
    setByteBudget: (value: number) => {
      byteBudget = Math.min(optimizeEvidenceLimits.toolBytes, value)
    },
    assertComplete: (
      requiredSources: ReadonlyArray<string>,
      citations: ReadonlyArray<OptimizeSourceRange> = [],
    ): void => {
      signal.throwIfAborted()
      if (fatal !== undefined) throw fatal
      if (readLines.size === 0) throw new Error("Reviewer did not read any snapshot evidence.")
      for (const id of requiredSources) {
        const source = evidence.sources.find((entry) => entry.id === id)
        if (source === undefined) throw new Error(`Required review source is missing: ${id}.`)
        if (source.content.length === 0) continue
        const unread = firstUnreadRange({ source: id, startLine: 1, endLine: source.content.split("\n").length })
        if (unread !== undefined)
          throw new Error(
            `Reviewer did not inspect all selected evidence in ${id}:${unread.startLine}-${unread.endLine}. Reduce the scope and run a new review.`,
          )
      }
      const unread = citations.map((entry) => firstUnreadRange(entry)).find((entry) => entry !== undefined)
      if (unread !== undefined)
        throw new Error(
          `Reviewer did not inspect cited evidence at ${unread.source}:${unread.startLine}-${unread.endLine}.`,
        )
    },
  }
}
