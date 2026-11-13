import { expect, test } from "bun:test"
import { factoryConfig } from "../src/config.ts"
import { awaitGateWorker, gateWaitMs, stuckReason, type Health } from "../src/gateWorker.ts"
import type { Worker } from "../src/factory.ts"

const c = factoryConfig()
const min = 60_000
const w = (over: Partial<Health> = {}): Health => ({
  status: "running",
  lastActivity: 0,
  failedTools: 0,
  toolsInFlight: 0,
  lastError: null,
  ...over,
})

test("defaults: no short limit; stuck after 10 silent minutes or 5 failed tools; one retry; 90 min backstop", () => {
  expect(c.workers).toEqual({ wait_minutes: 90, stuck_quiet_minutes: 10, stuck_failed_tools: 5, retries: 1 })
  expect(gateWaitMs(c, {})).toBe(90 * min)
  expect(gateWaitMs(c, { SF_SECURITY_TIMEOUT_MS: "5000" })).toBe(5000)
})

test("stuck means error, failing tools, or silence with no tool running; a long tool call is not stuck", () => {
  expect(stuckReason(w(), 9 * min, c)).toBeNull()
  expect(stuckReason(w(), 10 * min, c)).toBe("silent for 10 min with no tool running")
  expect(stuckReason(w({ toolsInFlight: 1 }), 60 * min, c)).toBeNull()
  expect(stuckReason(w({ status: "idle" }), 60 * min, c)).toBeNull()
  expect(stuckReason(w({ failedTools: 5, lastActivity: Date.now() }), Date.now(), c)).toBe(
    "5 tool calls failed in a row",
  )
  expect(stuckReason(w({ status: "error", lastError: "boom" }), 0, c)).toBe("failed: boom")
})

const fake = (states: ("idle" | "stuck")[]) => {
  const started: string[] = []
  const stopped: string[] = []
  const start = async () => {
    const id = `w-${started.length + 1}`
    const kind = states[started.length] ?? "idle"
    started.push(id)
    return {
      id,
      status: kind === "idle" ? "idle" : "error",
      lastError: kind === "idle" ? null : "crashed",
      lastActivity: Date.now(),
      failedTools: 0,
      toolsInFlight: 0,
      waitIdle: async () => true,
    } as unknown as Worker
  }
  return { started, stopped, start, stop: async (id: string) => void stopped.push(id) }
}

test("a stuck gate worker is stopped and replaced once; a second stuck one fails the gate with the reason", async () => {
  const ok = fake(["stuck", "idle"])
  expect((await awaitGateWorker(ok.start, "review", ok.stop, c, 1)).id).toBe("w-2")
  expect(ok.stopped).toEqual(["w-1"])
  const bad = fake(["stuck", "stuck"])
  await expect(awaitGateWorker(bad.start, "review", bad.stop, c, 1)).rejects.toThrow(
    "review worker failed: crashed (after 2 tries)",
  )
  expect(bad.stopped).toEqual(["w-1", "w-2"])
  const first = fake(["idle"])
  expect((await awaitGateWorker(first.start, "review", first.stop, c, 1)).id).toBe("w-1")
  expect(first.stopped).toEqual([])
})
