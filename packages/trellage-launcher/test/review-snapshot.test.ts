import { describe, expect, it } from "vitest"
import { ReviewSnapshotReader, snapshotBatches, snapshotSliceText } from "../src/review-snapshot.ts"
import { optimizeDigest, optimizeEvidenceTools, type OptimizeEvidence } from "../src/guide-optimize-evidence.ts"

const evidenceFor = (content: string): OptimizeEvidence => ({
  sources: [{ id: "@diff/net", content }],
  excluded: [],
  fingerprint: optimizeDigest(content),
})
const invoke = (reader: ReviewSnapshotReader, args: Record<string, unknown>) =>
  reader.tool.handler!(args, {
    sessionId: "review",
    toolName: "read_snapshot",
    toolCallId: "read",
    arguments: args,
  })

describe("frozen skill-review batches", () => {
  it.each(["lines", "utf16"] as const)(
    "tracks disjoint, repeated and cancelled %s reads through the same coverage contract", async (coordinates) => {
      const controller = new AbortController()
      const evidence = evidenceFor("one😀\ntwo\nthree")
      const tools = optimizeEvidenceTools(evidence, controller.signal)
      const reader = new ReviewSnapshotReader(evidence,
        [{ source: "@diff/net", start: 0, end: evidence.sources[0]!.content.length }], 100_000, controller.signal)
      const read = async (last: boolean) => {
        if (coordinates === "utf16")
          return invoke(reader, { source: "@diff/net", offset: last ? 6 : 0, length: last ? 9 : 6 })
        const args = { source: "@diff/net", startLine: last ? 2 : 1, lineCount: last ? 2 : 1 }
        return tools.tools.find((tool) => tool.name === "read_review_source")!.handler!(args, {
          sessionId: "review", toolName: "read_review_source", toolCallId: "read", arguments: args,
        })
      }
      const complete = () => coordinates === "utf16" ? reader.assertComplete() : tools.assertComplete(["@diff/net"])
      await read(true)
      await read(true)
      expect(complete).toThrow(/did not/iu)
      await read(false)
      expect(complete).not.toThrow()
      controller.abort(new Error("cancelled after delivery"))
      expect(complete).toThrow("cancelled after delivery")
    },
  )

  it.each(["lines", "utf16"] as const)("latches reduced context after successful %s reads", async (coordinates) => {
    const signal = new AbortController().signal
    const evidence = evidenceFor("frozen😀")
    const tools = optimizeEvidenceTools(evidence, signal)
    const reader = new ReviewSnapshotReader(evidence, [{ source: "@diff/net", start: 0, end: 8 }], 100_000, signal)
    if (coordinates === "utf16") {
      await invoke(reader, { source: "@diff/net" })
      expect(() => reader.setBudget(1)).toThrow("context")
      expect(() => reader.assertComplete()).toThrow("context")
      expect(() => invoke(reader, {})).toThrow("context")
    } else {
      const args = { source: "@diff/net", startLine: 1, lineCount: 1 }
      await tools.tools[1]!.handler!(args, {
        sessionId: "review", toolName: "read_review_source", toolCallId: "read", arguments: args,
      })
      expect(() => tools.setByteBudget(1)).toThrow("budget")
      expect(() => tools.assertComplete(["@diff/net"])).toThrow("budget")
    }
  })

  it("partitions large Unicode evidence without gaps, overlaps, or broken surrogate pairs", () => {
    const text = "code \u{1f600} \u00e9\n".repeat(70_000)
    const evidence = evidenceFor(text)
    const batches = snapshotBatches(evidence, ["@diff/net"], 80_000)
    expect(Buffer.byteLength(text)).toBeGreaterThan(384 * 1024)
    expect(batches.length).toBeGreaterThan(1)
    const ranges = batches.flat()
    expect(ranges[0]?.start).toBe(0)
    expect(ranges.at(-1)?.end).toBe(text.length)
    for (let index = 1; index < ranges.length; index++) expect(ranges[index]!.start).toBe(ranges[index - 1]!.end)
    expect(ranges.map((range) => text.slice(range.start, range.end)).join("")).toBe(text)
    for (const range of ranges)
      expect(text.charCodeAt(range.start) >= 0xdc00 && text.charCodeAt(range.start) <= 0xdfff).toBe(false)
    expect(snapshotSliceText(evidence, ranges.slice(0, 1))).toContain("@diff/net [characters 0..")
  })

  it("larger context capacity produces fewer batches for the same complete snapshot", () => {
    const evidence = evidenceFor("+value\n".repeat(80_000))
    const small = snapshotBatches(evidence, ["@diff/net"], 80_000)
    const large = snapshotBatches(evidence, ["@diff/net"], 900_000)
    expect(small.length).toBeGreaterThan(large.length)
    expect(large).toHaveLength(1)
    expect(() => snapshotBatches(evidence, ["missing"], 80_000)).toThrow("missing")
    expect(() => snapshotBatches(evidence, ["@diff/net"], 4095)).toThrow("capacity")
  })

  it("requires actual delivery of every assigned range, including disjoint reads", async () => {
    const evidence = evidenceFor("x".repeat(30_000))
    const reader = new ReviewSnapshotReader(
      evidence,
      [{ source: "@diff/net", start: 0, end: 30_000 }],
      100_000,
      new AbortController().signal,
    )
    await invoke(reader, {})
    expect(() => reader.assertComplete()).toThrow("did not read")
    await invoke(reader, { source: "@diff/net", offset: 15_000, length: 15_000 })
    expect(() => reader.assertComplete()).toThrow("did not read")
    await invoke(reader, { source: "@diff/net", offset: 0, length: 15_000 })
    expect(() => reader.assertComplete()).not.toThrow()
  })

  it("rejects budget exhaustion permanently, even after the last required read", () => {
    const evidence = evidenceFor("x".repeat(4000))
    const reader = new ReviewSnapshotReader(
      evidence,
      [{ source: "@diff/net", start: 0, end: 4000 }],
      1000,
      new AbortController().signal,
    )
    expect(() => invoke(reader, { source: "@diff/net" })).toThrow("context budget")
    expect(() => reader.assertComplete()).toThrow("context budget")
    expect(() => invoke(reader, {})).toThrow("context budget")
  })

  it("never reads a live path and propagates cancellation before accepting coverage", async () => {
    const controller = new AbortController()
    const reader = new ReviewSnapshotReader(evidenceFor("frozen"), [], 10_000, controller.signal)
    expect(() => invoke(reader, { source: "/etc/passwd" })).toThrow("unavailable")
    expect(() => invoke(reader, { source: "@diff/net", offset: -1 })).toThrow("offset")
    expect(() => invoke(reader, { source: "@diff/net", length: 16_001 })).toThrow("length")
    await invoke(reader, { source: "@diff/net" })
    controller.abort(new Error("review cancelled"))
    expect(() => reader.assertComplete()).toThrow("review cancelled")
    expect(() => invoke(reader, {})).toThrow("review cancelled")
  })
})
