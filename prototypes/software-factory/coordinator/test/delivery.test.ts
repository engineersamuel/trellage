import { expect, test } from "bun:test"
import { sendWhenIdle } from "../src/delivery.ts"

const target = (status: string, send: (p: string) => Promise<void>) => ({ status, send })

test("sendWhenIdle waits while the target is running, then prepares and sends", async () => {
  const log: string[] = []
  const c = target("running", async (p) => void log.push(`send ${p}`))
  let settled = false
  const sent = sendWhenIdle(c, "hi", () => log.push("prepare"), 5).then(() => (settled = true))
  await Bun.sleep(20)
  expect([log, settled]).toEqual([[], false])
  c.status = "idle"
  await sent
  expect(log).toEqual(["prepare", "send hi"])
})

test("sendWhenIdle rejects when the send rejects", async () => {
  const c = target("idle", () => Promise.reject(new Error("session gone")))
  await expect(sendWhenIdle(c, "hi", () => {}, 5)).rejects.toThrow("session gone")
})
