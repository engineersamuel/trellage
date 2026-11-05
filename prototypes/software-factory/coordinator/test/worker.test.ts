import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Factory, Worker } from "../src/factory.ts"

const factory: any = { publish: (workerId: string, type: string, agentId: string | null, timestamp: string, data: unknown) => ({ seq: 0, workerId, type, agentId, timestamp, data }) }
const ev = (type: string) => ({ type, timestamp: "0", data: {} }) as any

test("onDone fires once, on the first idle after the task's turn starts", () => {
  const w = new Worker("w1", "impl", "worker", "native", "/tmp/h", "task", {} as any, "m")
  const done: string[] = []
  w.onDone = (x) => done.push(x.id)
  w.observe(factory, ev("session.idle"))
  expect(done).toEqual([])
  w.observe(factory, ev("assistant.turn_start"))
  expect(done).toEqual([])
  w.observe(factory, ev("session.idle"))
  w.observe(factory, ev("assistant.turn_start"))
  w.observe(factory, ev("session.idle"))
  expect(done).toEqual(["w1"])
})

test("a worker whose first prompt fails is stopped and unregistered, and the error is rethrown", async () => {
  const f = new Factory({ SF_STATE_DIR: mkdtempSync(path.join(tmpdir(), "sf-w-")) })
  const stopped: string[] = []
  const client: any = { stop: async () => void stopped.push("client") }
  const w = new Worker("w-1", "impl", "worker", "native", "/tmp/h", "task", client, "m")
  w.session = { send: () => Promise.reject(new Error("send failed")), disconnect: async () => void stopped.push("session") } as any
  await expect(f.register(w, "task")).rejects.toThrow("send failed")
  expect([f.workers.has("w-1"), stopped]).toEqual([false, ["session", "client"]])
})

test("a registered worker without a prompt stays registered", async () => {
  const f = new Factory({ SF_STATE_DIR: mkdtempSync(path.join(tmpdir(), "sf-w-")) })
  const w = new Worker("w-2", "coord", "coordinator", "native", "/tmp/h", null, {} as any, "m")
  expect(await f.register(w)).toBe(w)
  expect(f.workers.get("w-2")).toBe(w)
})

test("Copilot workers get a gate by default: push, merge and delete are rejected, the rest approved", async () => {
  const { workerPermissions } = await import("../src/factory.ts")
  const inv: any = { sessionId: "s" }
  const shell = (fullCommandText: string): any => ({ kind: "shell", fullCommandText })
  expect((workerPermissions(shell("git push origin main"), inv) as any).kind).toBe("reject")
  expect((workerPermissions(shell("git -C x branch -D feat"), inv) as any).kind).toBe("reject")
  expect((workerPermissions(shell("bun test && git merge main"), inv) as any).kind).toBe("reject")
  expect(workerPermissions(shell("git status"), inv)).toEqual({ kind: "approve-once" })
  expect(workerPermissions({ kind: "write" } as any, inv)).toEqual({ kind: "approve-once" })
})
