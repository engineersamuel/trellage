import { expect, test } from "bun:test"
import { findIssues } from "../src/supervisor.ts"

const w = (o: object) => ({ id: "w1", name: "impl", role: "worker", status: "running", task: "t", lastActivity: 0, failedTools: 0, lastError: null, collected: false, ...o }) as any
const L = { stallSeconds: 300, uncollectedSeconds: 60, failedToolsInARow: 3 }

test("supervisor reports stuck, failing, errored and uncollected workers, never the coordinator", () => {
  const now = 1_000_000
  expect(findIssues([w({ lastActivity: now - 10_000 })], now, L)).toEqual([])
  expect(findIssues([w({ lastActivity: now - 400_000 })], now, L).map((i) => i.kind)).toEqual(["stalled"])
  expect(findIssues([w({ lastActivity: now, failedTools: 3, lastError: "boom" })], now, L)[0]?.detail).toContain("boom")
  expect(findIssues([w({ status: "error", lastError: "auth", lastActivity: now })], now, L).map((i) => i.kind)).toEqual(["error"])
  expect(findIssues([w({ status: "idle", lastActivity: now - 120_000 })], now, L).map((i) => i.kind)).toEqual(["uncollected"])
  expect(findIssues([w({ status: "idle", collected: true, lastActivity: now - 120_000 })], now, L)).toEqual([])
  expect(findIssues([w({ role: "coordinator", status: "error", lastActivity: 0 })], now, L)).toEqual([])
})
