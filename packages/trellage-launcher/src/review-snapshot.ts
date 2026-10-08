import type { Tool } from "@github/copilot-sdk"
import { optimizeDigest, type OptimizeEvidence } from "./guide-optimize-evidence.ts"
import { record, boundedNumber, exactKeys } from "./guide-text.ts"
import { ReviewReadLedger, packReviewRanges, reviewTokenUpperBound } from "./review-context.ts"

export interface ReviewSlice {
  readonly source: string
  readonly start: number
  readonly end: number
}

const integer = (value: unknown, name: string, min: number, max: number): number => {
  const result = boundedNumber(value, name, min, max)
  if (!Number.isInteger(result)) throw new Error(`${name} must be an integer.`)
  return result
}

function* segments(evidence: OptimizeEvidence, sourceIds: ReadonlyArray<string>, budget: number) {
  for (const id of sourceIds) {
    const source = evidence.sources.find((entry) => entry.id === id)
    if (!source) throw new Error(`Snapshot source missing: ${id}`)
    for (let start = 0; start < source.content.length;) {
      let end = Math.min(start + Math.min(4000, Math.floor(budget / 8)), source.content.length)
      const code = source.content.charCodeAt(end - 1)
      if (end < source.content.length && code >= 0xd800 && code <= 0xdbff) end--
      const cost = reviewTokenUpperBound(JSON.stringify(source.content.slice(start, end))) + 1024
      if (cost > budget) throw new Error("A snapshot segment cannot fit the selected model.")
      yield { range: { source: id, start, end }, cost }
      start = end
    }
  }
}

export const snapshotBatches = (
  evidence: OptimizeEvidence,
  sourceIds: ReadonlyArray<string>,
  budget: number,
): ReadonlyArray<ReadonlyArray<ReviewSlice>> => {
  if (!Number.isSafeInteger(budget) || budget < 4096) throw new Error("Model has insufficient snapshot capacity.")
  const batches = packReviewRanges(segments(evidence, sourceIds, budget), budget)
  if (!batches.length) return [[]]
  if (batches.length > 128)
    throw new Error("Review exceeds the 128-batch execution safety limit; reduce the selected scope.")
  return batches
}

export const snapshotSliceText = (evidence: OptimizeEvidence, ranges: ReadonlyArray<ReviewSlice>): string =>
  ranges
    .map((range) => {
      const source = evidence.sources.find((entry) => entry.id === range.source)
      if (!source) throw new Error(`Snapshot source missing: ${range.source}`)
      return `## ${range.source} [characters ${range.start}..${range.end})\n${source.content.slice(range.start, range.end)}`
    })
    .join("\n\n")

export class ReviewSnapshotReader {
  private readonly ledger: ReviewReadLedger

  constructor(
    private readonly evidence: OptimizeEvidence,
    readonly required: ReadonlyArray<ReviewSlice>,
    budget: number,
    signal: AbortSignal,
  ) {
    this.ledger = new ReviewReadLedger(
      budget,
      signal,
      "Review exceeded this model's frozen-evidence context budget. No complete coverage is accepted.",
    )
  }

  get consumed(): number {
    return this.ledger.consumed
  }

  setBudget(remaining: number): void {
    this.ledger.setBudget(remaining, "Review history leaves insufficient model context for the frozen evidence.")
  }

  private remaining(): ReviewSlice[] {
    return this.required.flatMap((range) => {
      const gap = this.ledger.firstGap(range)
      return gap ? [{ ...range, start: gap.start }] : []
    })
  }

  assertComplete(): void {
    this.ledger.assertHealthy()
    const missing = this.remaining()
    if (missing.length)
      throw new Error(
        `Review did not read all frozen batch evidence: ${missing.length} gaps; first ${JSON.stringify(missing[0])}.`,
      )
  }

  private read(input: unknown): unknown {
    this.ledger.assertHealthy()
    const args = record(input, "read_snapshot")
    exactKeys(args, "read_snapshot", [], ["source", "offset", "length"])
    const offset = integer(args.offset ?? 0, "offset", 0, Number.MAX_SAFE_INTEGER)
    const length = integer(args.length ?? 16000, "length", 1, 16000)
    if (args.source === undefined) return this.manifest(offset)
    const source = this.evidence.sources.find((entry) => entry.id === args.source)
    if (!source || offset > source.content.length) throw new Error("Snapshot source or offset is unavailable.")
    const end = Math.min(offset + length, source.content.length)
    return {
      source: source.id,
      offset,
      end,
      totalCharacters: source.content.length,
      text: source.content.slice(offset, end),
      nextOffset: end < source.content.length ? end : null,
    }
  }

  private manifest(offset: number): unknown {
    if (offset > this.evidence.sources.length) throw new Error("Snapshot manifest offset is unavailable.")
    return {
      fingerprint: this.evidence.fingerprint,
      sources: this.evidence.sources.slice(offset, offset + 60).map((source) => ({
        id: source.id,
        characters: source.content.length,
        bytes: Buffer.byteLength(source.content),
        digest: optimizeDigest(source.content),
      })),
      nextOffset: offset + 60 < this.evidence.sources.length ? offset + 60 : null,
      remainingRequired: this.remaining().slice(0, 3),
      totalRequiredSegments: this.required.length,
    }
  }

  readonly tool: Tool = {
    name: "read_snapshot",
    description:
      "Read immutable review evidence. With no source, list the manifest (offset pages the list). With source, offset and length are UTF-16 character offsets. Read remainingRequired ranges until empty. No live files or commands.",
    skipPermission: true,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: [],
      properties: {
        source: { type: "string" },
        offset: { type: "integer", minimum: 0 },
        length: { type: "integer", minimum: 1, maximum: 16000 },
      },
    },
    handler: (input: unknown) => {
      this.ledger.request(reviewTokenUpperBound(JSON.stringify(input)) + 512)
      const page = this.read(input)
      const data = record(page, "snapshot page")
      if (typeof data.source === "string" && typeof data.offset === "number" && typeof data.end === "number") {
        this.ledger.record({ source: data.source, start: data.offset, end: data.end })
      }
      const result = JSON.stringify({ ...data, remainingRequired: this.remaining().slice(0, 3) })
      this.ledger.charge(reviewTokenUpperBound(result))
      return { resultType: "success", textResultForLlm: result }
    },
  }
}
