import assert from "node:assert/strict"
import { getEventListeners } from "node:events"
import net from "node:net"
import path from "node:path"
import test from "node:test"
import { requestHerdr } from "../lib/herdr.ts"
import { captureFixture } from "./helpers/conversation-fixtures.ts"

test("source checks reject a pre-aborted operation without starting capture", async (t) => {
  const fixture = await captureFixture(t)
  const snapshot = await captureFocusedConversation(fixture.context, fixture.dependencies)
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  await assert.rejects(checkConversationSource(snapshot, {
    signal: controller.signal,
    capture: async () => { calls += 1; return snapshot },
  }), { name: "AbortError" })
  assert.equal(calls, 0)
})

test("refresh passes cancellation to capture and does not stage an aborted result", async (t) => {
  const fixture = await captureFixture(t)
  const snapshot = await captureFocusedConversation(fixture.context, fixture.dependencies)
  const controller = new AbortController()
  let started
  const capturing = new Promise<void>((resolve) => { started = resolve })
  let staged = false
  let cleaned = false
  const result = main(["--refresh", "owned-request"], {
    env: fixture.env,
    signal: controller.signal,
    readRequest: async () => snapshot,
    capture: async (_context, { signal }) => {
      assert.equal(signal, controller.signal)
      try {
        await new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true })
          started()
        })
        return snapshot
      } finally {
        cleaned = true
      }
    },
    stageRequest: async () => { staged = true; return "must-not-publish" },
  })
  const rejected = assert.rejects(result, { name: "AbortError" })
  await capturing
  controller.abort()
  await rejected
  assert.equal(cleaned, true)
  assert.equal(staged, false)
})

test("Herdr request cancellation closes the owned socket and removes its listener", async (t) => {
  const fixture = await captureFixture(t)
  const socketPath = path.join(fixture.root, "abort.sock")
  let began
  let disconnected
  const pending = new Promise<void>((resolve) => { began = resolve })
  const closed = new Promise<void>((resolve) => { disconnected = resolve })
  const sockets = new Set<net.Socket>()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.once("data", () => began())
    socket.once("close", () => { sockets.delete(socket); disconnected() })
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socketPath, resolve)
  })
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  const controller = new AbortController()
  const rejected = assert.rejects(requestHerdr("agent.get", { target: fixture.context.paneId }, {
    socketPath, signal: controller.signal,
  }), { name: "AbortError" })
  await pending
  controller.abort()
  await rejected
  await closed
  assert.equal(getEventListeners(controller.signal, "abort").length, 0)
})
