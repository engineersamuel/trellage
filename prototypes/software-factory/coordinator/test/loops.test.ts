import { expect, test } from "bun:test"
import { loop, stopLoops } from "../src/loops.ts"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test("a loop keeps running after a tick throws or rejects", async () => {
  let calls = 0
  loop("flaky", 5, async () => {
    calls++
    if (calls === 1) throw new Error("boom")
    if (calls === 2) return Promise.reject(new Error("rejected"))
  })
  await wait(60)
  await stopLoops()
  expect(calls).toBeGreaterThan(3)
})

test("ticks never overlap", async () => {
  let running = 0
  let overlap = false
  loop("slow", 1, async () => {
    if (running++) overlap = true
    await wait(10)
    running--
  })
  await wait(60)
  await stopLoops()
  expect(overlap).toBe(false)
})

test("stopLoops stops every loop", async () => {
  let calls = 0
  loop("a", 2, () => void calls++, 0)
  loop("b", 2, () => void calls++, 0)
  await wait(20)
  await stopLoops()
  const after = calls
  await wait(20)
  expect(calls).toBe(after)
  expect(after).toBeGreaterThan(0)
})
