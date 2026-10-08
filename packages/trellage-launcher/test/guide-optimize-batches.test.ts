import { describe, expect, it } from "vitest"
import { RestrictedGuideModelError } from "../src/copilot-guide-provider.ts"
import { defaultGuideModelRouting } from "../src/guide-model-routing.ts"
import {
  newOptimizeReview,
  optimizeReviewersFor,
  packOptimizeLimitations,
  parseOptimizeReport,
  runOptimizeReview,
  type OptimizeModelCall,
  type OptimizeBatchReport,
} from "../src/guide-optimize-review.ts"
import type { OptimizeSourceRange } from "../src/guide-optimize-evidence.ts"
import { fixtureOptimizeModelInfo, invokeReviewTool } from "./fixtures/guide-optimize-model.ts"
import { record } from "../src/guide-text.ts"

const evidence = {
  fingerprint: "frozen",
  sources: [
    {
      id: "@diff/arbitrary/chunk-7",
      content: Array.from({ length: 1000 }, (_, index) => `${index} ${"x".repeat(500)}`).join("\n"),
    },
    { id: "code.ts", content: "export const value = 1" },
  ],
  excluded: [],
}

const initialReview = (model: string = defaultGuideModelRouting.optimize.model) =>
  newOptimizeReview(
    {
      target: {
        cwd: process.cwd(),
        gitDirectory: `${process.cwd()}/.git`,
        head: null,
        scope: { kind: "uncommitted" },
        fingerprint: "frozen",
        changes: [
          {
            path: "code.ts",
            staged: false,
            unstaged: true,
            untracked: false,
            committed: false,
            kind: "file",
            fingerprint: "frozen",
          },
        ],
      },
      paths: ["code.ts"],
      reviewerIds: ["first-principles"],
    },
    evidence,
    optimizeReviewersFor({
      ...defaultGuideModelRouting,
      optimize: { ...defaultGuideModelRouting.optimize, model },
    }),
    { ...defaultGuideModelRouting.optimize, model },
  )

const readRanges = async (
  request: Parameters<OptimizeModelCall>[0],
  ranges: ReadonlyArray<OptimizeSourceRange>,
  seen: Set<number>,
): Promise<void> => {
  for (const range of ranges) {
    for (let line = range.startLine; line <= range.endLine; line += 20) {
      const count = Math.min(20, range.endLine - line + 1)
      const result = await invokeReviewTool(request, "read_review_source", {
        source: range.source,
        startLine: line,
        lineCount: count,
      })
      if (range.source.startsWith("@diff/")) {
        for (const key of Object.keys(result.lines as object)) seen.add(Number(key))
      }
    }
  }
}

const inspectModel = (
  request: Parameters<OptimizeModelCall>[0],
  capacity: number,
  wrapper?: "metadata" | "cleanup" | "cancelled",
): void => {
  try {
    request.inspectModel({
      ...fixtureOptimizeModelInfo,
      capabilities: {
        ...fixtureOptimizeModelInfo.capabilities,
        limits: { max_context_window_tokens: capacity },
      },
    })
  } catch (cause) {
    if (wrapper !== undefined)
      throw new RestrictedGuideModelError(
        wrapper === "cancelled" ? "cancelled" : "model-metadata-failed",
        wrapper === "cleanup" ? ["forceStop failed"] : [],
      )
    throw cause
  }
}

const invalidBatchResponse = (failure: string | undefined, batch: unknown, correction: unknown): boolean =>
  batch === 2 && (failure === "invalid-correction" || (failure === "invalid-batch" && correction === undefined))

const assertCitationBounds = (request: Parameters<OptimizeModelCall>[0]): void => {
  const properties = record(record(request.responseFormat?.jsonSchema.schema, "schema").properties, "properties")
  const rows = record(properties.findings ?? properties.responses ?? properties.decisions, "rows")
  const entry = record(record(rows.items, "entry").properties, "entry properties")
  const citation = record(record(entry.citations, "citations").items, "citation")
  const coordinates = record(citation.properties, "coordinates")
  if (request.model.startsWith("gpt")) {
    expect(record(coordinates.startLine, "startLine").maximum).toBe(1000)
    expect(record(coordinates.endLine, "endLine").maximum).toBe(1000)
  } else {
    expect(JSON.stringify(request.responseFormat)).not.toMatch(/"(?:minimum|maximum|exclusiveMinimum|exclusiveMaximum|multipleOf)":/u)
    expect(record(coordinates.startLine, "startLine").type).toBe("integer")
    expect(record(coordinates.endLine, "endLine").description).toContain("never greater than 1000")
  }
}

const corruptedCitationReport = () => JSON.stringify({
  summary: "Review with a corrupt citation.",
  limitations: [],
  findings: [{
    title: "Keep the boundary explicit",
    proposal: "Keep the value export.",
    benefit: "Preserve the public value.",
    risk: "Confirm consumers.",
    verification: "Run the existing tests.",
    paths: ["code.ts"],
    citations: [{ source: "code.ts", startLine: 1, endLine: 8279271655819871 }],
  }],
})

const faultyResponse = (failure: string | undefined, batch: unknown, correction: unknown): string | undefined => {
  if (invalidBatchResponse(failure, batch, correction)) return '{"summary":'
  if (failure === "invalid-citation" && batch === 2) return corruptedCitationReport()
  return undefined
}

const run = async (
  capacity: number,
  failure?: "missing" | "failed" | "invalid-batch" | "invalid-correction" | "invalid-citation",
  wrapper?: "metadata" | "cleanup" | "cancelled",
  manyLimitations = false,
  model: string = defaultGuideModelRouting.optimize.model,
) => {
  let calls = 0
  let batches = 0
  let consolidations = 0
  const seen = new Set<number>()
  const savedBatches: OptimizeBatchReport[] = []
  const batchAttempts = new Map<number, number>()
  const corrections: { readonly prompt: string; readonly instruction: string }[] = []
  const limitations = Array.from({ length: 6 }, (_, index) => `Material constraint ${index + 1}.`)
  const call: OptimizeModelCall = async (request) => {
    calls++
    assertCitationBounds(request)
    inspectModel(request, capacity, wrapper)
    const prompt = JSON.parse(request.prompt)
    if (prompt.correction !== undefined) corrections.push({ prompt: request.prompt, instruction: request.systemPrompt })
    if (prompt.data.batch !== undefined) {
      batches++
      batchAttempts.set(prompt.data.batch, (batchAttempts.get(prompt.data.batch) ?? 0) + 1)
      if (failure === "failed" && batches === 2) throw new Error("batch failed")
    }
    if (request.systemPrompt.includes("Cross-file consolidation")) consolidations++
    const ranges = [...prompt.requiredRanges, ...prompt.requiredCitations] as OptimizeSourceRange[]
    if (failure !== "missing") await readRanges(request, ranges, seen)
    await invokeReviewTool(request, "read_review_source", {
      source: "code.ts",
      startLine: 1,
      lineCount: 1,
    })
    const fault = faultyResponse(failure, prompt.data.batch, prompt.correction)
    if (fault !== undefined) return fault
    return request.responseFormat?.jsonSchema.name === "optimize_report"
      ? JSON.stringify({
          summary: "Reviewed all assigned ranges.",
          limitations: manyLimitations
            ? prompt.data.batch === undefined ? [limitations.join(" ")] : limitations
            : [],
          findings: [],
        })
      : JSON.stringify({ summary: "No changes needed.", decisions: [] })
  }
  const review = await runOptimizeReview(
    initialReview(model),
    async () => {},
    new AbortController().signal,
    () => {},
    call,
    "all",
    async (report) => { savedBatches.push(report) },
  )
  return { review, calls, batches, consolidations, seen, savedBatches, limitations, batchAttempts, corrections }
}

describe("bounded builtin review batches", () => {
  it("rejects plans above 128 evidence batches before any evidence batch executes", async () => {
    const result = await run(60_000)
    expect(result.review.status).toBe("incomplete")
    expect(result.review.error).toContain("exceeding the consented limit of 128")
    expect(result.calls).toBe(1)
    expect(result.batches).toBe(0)
    expect(result.consolidations).toBe(0)
    expect(result.seen.size).toBe(0)
  })

  it.each(["claude-opus-5.5", "grok-4.7", "unrecognized-model"])(
    "uses portable schemas without numeric constraint keywords for %s",
    async (model) => {
      const result = await run(200_000, undefined, undefined, false, model)
      expect(result.review.status).toBe("complete")
      expect(result.seen.size).toBe(1000)
    },
  )

  it("keeps strict local citation bounds when Claude's output schema cannot express them", async () => {
    const result = await run(200_000, "invalid-citation", undefined, false, "claude-opus-5.5")
    expect(result.review.status).toBe("incomplete")
    expect(result.review.error).toContain("8279271655819871")
    expect(result.batchAttempts.get(2)).toBe(2)
  })

  it("bounds citation integers and rejects corrupt endpoints after exactly one fresh correction", async () => {
    const result = await run(200_000, "invalid-citation")
    expect(result.review.status).toBe("incomplete")
    expect(result.review.error).toContain("8279271655819871")
    expect(result.batchAttempts.get(1)).toBe(1)
    expect(result.batchAttempts.get(2)).toBe(2)
    expect(result.corrections).toHaveLength(1)
    const correction = result.corrections[0]!
    expect(JSON.parse(correction.prompt).correction.rejectedResponse).toBe(corruptedCitationReport())
    expect(correction.instruction).toContain("rebuild each citation from the fresh tool")
    expect(correction.instruction).toContain("Do not copy, extend, concatenate")
    expect(result.review.calls).toBe(result.calls)
  })

  it("packs more than five long limitations without losing text or Unicode characters", () => {
    const original = Array.from({ length: 6 }, (_, index) => `${index}${"😀".repeat(299)}`)
    const packed = packOptimizeLimitations([...original, original[0]!])
    expect(packed).toHaveLength(5)
    expect(packed.every((entry) => [...entry].length <= 400)).toBe(true)
    expect(packed.join("")).toBe(original.join(" | "))
    expect(() => packOptimizeLimitations([...original, "x".repeat(200)])).toThrow("nothing was omitted")
  })

  it("preserves packed whitespace boundaries when a stored report is parsed", () => {
    const original = ["x".repeat(399), "y".repeat(399)]
    const packed = packOptimizeLimitations(original)
    const initial = initialReview()
    const parsed = parseOptimizeReport(
      { summary: "Reviewed.", findings: [], limitations: [...packed, "All batches read."] },
      "first-principles",
      initial.input,
      evidence,
    )
    expect(parsed.limitations.slice(0, -1).join("")).toBe(original.join(" | "))
  })

  it("corrects only the invalid batch without repeating successful evidence batches", async () => {
    const result = await run(200_000, "invalid-batch")
    expect(result.review.status).toBe("complete")
    expect(result.batchAttempts.get(1)).toBe(1)
    expect(result.batchAttempts.get(2)).toBe(2)
    expect(result.review.calls).toBe(result.calls)
  })

  it("stops after one failed local correction without restarting the full batch plan", async () => {
    const result = await run(200_000, "invalid-correction")
    expect(result.review.status).toBe("incomplete")
    expect(result.batchAttempts.get(1)).toBe(1)
    expect(result.batchAttempts.get(2)).toBe(2)
    expect(result.batchAttempts.has(3)).toBe(false)
    expect(result.consolidations).toBe(0)
    expect(result.review.calls).toBe(result.calls)
  })

  it("consolidates six distinct batch limitations and preserves full batch reports through the storage hook", async () => {
    const result = await run(200_000, undefined, undefined, true)
    expect(result.review.status).toBe("complete")
    expect(result.savedBatches.filter((entry) => entry.phase === "evidence")).toHaveLength(result.batches)
    expect(result.savedBatches.filter((entry) => entry.phase === "consolidation")).toHaveLength(result.consolidations)
    for (const limitation of result.limitations) {
      expect(result.review.reports[0]!.limitations.join(" ")).toContain(limitation)
    }
    expect(result.savedBatches[0]!.report.limitations).toEqual(result.limitations)
  })

  it("recovers the batch plan when the SDK wraps the metadata inspection error", async () => {
    const result = await run(200_000, undefined, "metadata")
    expect(result.review.status).toBe("complete")
    expect(result.batches).toBeGreaterThan(1)
    expect(result.consolidations).toBeGreaterThan(0)
    expect(result.seen.size).toBe(1000)
    expect(result.review.calls).toBe(result.calls)
  })

  it.each(["cleanup", "cancelled"] as const)("does not hide SDK %s failures behind a batch plan", async (wrapper) => {
    const result = await run(200_000, undefined, wrapper)
    expect(result.review.status).toBe("incomplete")
    expect(result.batches).toBe(0)
    expect(result.calls).toBe(1)
  })

  it("keeps a patch above 384 KiB in one call when the inspected model can hold it", async () => {
    const result = await run(1_000_000)
    expect(result.review.status).toBe("complete")
    expect(result.batches).toBe(0)
    expect(result.calls).toBe(2)
    expect(result.seen.size).toBe(1000)
  })

  it("reviews a patch over 384 KiB without truncation and consolidates cross-file results", async () => {
    expect(Buffer.byteLength(evidence.sources[0]!.content)).toBeGreaterThan(384 * 1024)
    const result = await run(200_000)
    expect(result.review.error).toBeNull()
    expect(result.review.status).toBe("complete")
    expect(result.batches).toBeGreaterThan(1)
    expect(result.consolidations).toBeGreaterThan(0)
    expect(result.seen.size).toBe(1000)
    expect(result.review.calls).toBe(result.calls)
    expect(result.review.reports[0]!.limitations.join(" ")).toContain("evidence batches were read")
  })

  it("uses fewer fresh batches with a larger model context", async () => {
    const smaller = await run(200_000)
    const larger = await run(500_000)
    expect(larger.review.status).toBe("complete")
    expect(smaller.batches).toBeGreaterThan(larger.batches)
    expect(larger.seen.size).toBe(1000)
  })

  it.each(["missing", "failed"] as const)("cannot pass a %s batch", async (failure) => {
    const result = await run(200_000, failure)
    expect(result.review.status).toBe("incomplete")
    expect(result.review.decisions).toEqual([])
    expect(result.review.calls).toBe(result.calls)
    expect(result.consolidations).toBe(0)
  })
})
