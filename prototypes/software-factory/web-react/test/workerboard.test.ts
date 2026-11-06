import { describe, expect, test } from "bun:test"
import { snapshotOf, toBoard } from "../src/genui/WorkerBoard"

const w = (id: string, name: string, status: string, extra: Record<string, unknown> = {}) =>
  ({ id, name, role: id === "coordinator" ? "coordinator" : "worker", status, model: "m", auth: "native", pid: 1, rssKb: 51200, home: "", task: null, lastMessage: null, eventCount: 0, contextTokens: null, contextLimit: null, ...extra }) as never

describe("genui/WorkerBoard", () => {
  test("counts, order and cells", () => {
    const b = toBoard([w("w2", "Beta", "error"), w("coordinator", "Desk", "idle", { contextTokens: 32000, contextLimit: 128000 }), w("w1", "Alpha", "running", { rssKb: null })])
    expect([b.total, b.running, b.errors]).toEqual([3, 1, 1])
    expect(b.rows.map((r) => r.id)).toEqual(["coordinator", "w1", "w2"])
    expect(b.rows.map((r) => [r.variant, r.memory, r.context])).toEqual([["success", "50 MB", "25%"], ["info", "–", "–"], ["danger", "50 MB", "–"]])
  })
  test("snapshot from the tool result; bad JSON is empty", () => {
    expect(snapshotOf(JSON.stringify({ workers: [w("a", "A", "idle")] })).length).toBe(1)
    expect(snapshotOf("nope")).toEqual([])
    expect(snapshotOf(undefined)).toEqual([])
  })
})
