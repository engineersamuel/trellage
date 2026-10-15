import { createHash } from "node:crypto"
import type { Tool, ToolResultObject } from "@github/copilot-sdk"
import { boundedNumber, exactKeys, record, text } from "./guide-text.ts"
import { ReviewReadLedger, reviewSnapshotBytes } from "./review-context.ts"

export const optimizeEvidenceLimits = {
  files: 5000,
  fileBytes: 1_000_000,
  totalBytes: reviewSnapshotBytes,
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
  limits: { readonly maximumCalls?: number; readonly maximumBytes?: number; readonly maximumResponseBytes?: number } = {},
) => {
  const ledger = new ReviewReadLedger(limits.maximumBytes ?? optimizeEvidenceLimits.toolBytes, signal,
    "Review evidence budget exhausted. Reduce the selected scope.", limits.maximumCalls ?? optimizeEvidenceLimits.toolCalls)
  const firstUnreadRange = (
    range: OptimizeSourceRange,
    delivered?: OptimizeSourceRange,
  ): OptimizeSourceRange | undefined => {
    const gap = ledger.firstGap({ source: range.source, start: range.startLine, end: range.endLine + 1 },
      delivered ? { source: delivered.source, start: delivered.startLine, end: delivered.endLine + 1 } : undefined)
    return gap ? { source: gap.source, startLine: gap.start, endLine: gap.end - 1 } : undefined
  }
  const handle =
    (operation: (input: unknown) => unknown, after?: (input: unknown) => void) =>
    (input: unknown): ToolResultObject => {
      ledger.request(Buffer.byteLength(JSON.stringify(input)) + 256)
      const output = JSON.stringify(operation(input))
      const size = Buffer.byteLength(output)
      if (size > (limits.maximumResponseBytes ?? optimizeEvidenceLimits.toolResponseBytes))
        throw new Error(`Read fewer lines; this response exceeds ${limits.maximumResponseBytes ?? optimizeEvidenceLimits.toolResponseBytes} bytes.`)
      ledger.charge(size)
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
        const offset = integer(fields.offset, "offset", 0, optimizeEvidenceLimits.files * 2 + 8)
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
          ledger.record({ source: id, start, end: Math.min(start + count, source.content.split("\n").length + 1) })
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
      ledger.setBudget(value)
    },
    assertComplete: (
      requiredSources: ReadonlyArray<string>,
      citations: ReadonlyArray<OptimizeSourceRange> = [],
    ): void => {
      ledger.assertHealthy()
      if (!ledger.hasReads) throw new Error("Reviewer did not read any snapshot evidence.")
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
