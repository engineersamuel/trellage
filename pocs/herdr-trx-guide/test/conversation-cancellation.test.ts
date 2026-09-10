import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { getEventListeners, once } from "node:events"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import net from "node:net"
import path from "node:path"
import test from "node:test"

import { checkConversationSource, main } from "../conversation-source.ts"
import { captureFocusedConversation } from "../lib/conversation-capture.ts"
import { ConversationSurface } from "../lib/conversation-contract.ts"
import { readConversationRequest, writeConversationRequest } from "../lib/conversation-state.ts"
import { requestHerdr } from "../lib/herdr.ts"
import { captureFixture } from "./helpers/conversation-fixtures.ts"

const require = createRequire(import.meta.url)
const { validateContinuationDraft } = require("../../../packages/trellage-guide-core/dist/conversation.js")

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

const writeCancellationHelper = async (root: string) => {
  const helper = path.join(root, "source-cancellation.cjs")
  const worker = path.join(root, "owned-page.cjs")
  const cleanup = path.join(root, "cleanup.json")
  const sourceUrl = new URL("../conversation-source.ts", import.meta.url).href
  const bridgeUrl = new URL("../lib/sandbox-bridge.ts", import.meta.url).href
  await writeFile(worker, `
const timer = setInterval(() => {}, 1000)
process.stdin.resume()
process.stdin.once("end", () => clearInterval(timer))
process.stdout.write("ready\\n")
`, { mode: 0o600 })
  await writeFile(helper, `
const { spawn } = require("node:child_process")
const { createHash } = require("node:crypto")
const fs = require("node:fs/promises")
;(async () => {
  const { runConversationSourceCli } = await import(${JSON.stringify(sourceUrl)})
  const { captureSandboxConversation } = await import(${JSON.stringify(bridgeUrl)})
  const original = JSON.parse(await fs.readFile(process.argv[3], "utf8"))
  const { agent, profile, sessionId, containerId, invocationId } = original.source
  const identity = { agent, profile, sessionId, containerId, invocationId }
  const source = { schemaVersion: 1, ...identity }
  const snapshotId = "c".repeat(64)
  let ownedPid
  const bridgeRunner = async (input) => {
    if (input.operation === "release-conversation") {
      if (input.signal?.aborted) throw new Error("Cleanup reused the cancelled signal")
      await fs.writeFile(${JSON.stringify(cleanup)}, JSON.stringify({
        released: true, snapshotId: input.snapshotId, ownedPid
      }), { mode: 0o600 })
      return JSON.stringify({ ...source, snapshotId: input.snapshotId, released: true })
    }
    if (input.cursor === undefined) return JSON.stringify({
      ...source, snapshotId, capturedAt: original.capturedAt, cutoff: original.cutoff,
      revision: createHash("sha256").update(JSON.stringify(original.messages)).digest("hex"),
      activityRevision: "d".repeat(64), coverage: { complete: true, notices: [] },
      messages: [original.messages[0]],
      page: { index: 0, total: 2, nextCursor: snapshotId + "e".repeat(64) }
    })
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [${JSON.stringify(worker)}], {
        signal: input.signal, stdio: ["pipe", "pipe", "ignore"]
      })
      ownedPid = child.pid
      let failure
      child.once("error", (error) => { failure = error })
      child.stdout.once("data", () => process.send({ ready: true, ownedPid }))
      child.once("close", () => reject(failure || new Error("The owned page ended")))
    })
  }
  process.exitCode = await runConversationSourceCli(process.argv.slice(2), {
    capture: async (_context, { signal }) => {
      await captureSandboxConversation({
        identity, cwd: original.source.cwd, signal, bridgeRunner
      })
      throw new Error("Expected cancellation")
    }
  })
})().catch(() => {
  console.error("Synthetic cancellation helper failed.")
  process.exitCode = 1
})
`, { mode: 0o600 })
  return { helper, cleanup }
}

for (const operation of ["--check", "--refresh"]) {
  for (const [signal, exitCode] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]] as const) {
    test(`${operation} ${signal} reaps its page, releases the sealed snapshot, and preserves private state`, {
      timeout: 10_000,
    }, async (t) => {
      const fixture = await captureFixture(t)
      const captured = await captureFocusedConversation(fixture.context, fixture.dependencies)
      const snapshot = {
        ...captured,
        source: {
          ...captured.source, surface: ConversationSurface.Sandbox, profile: "fixture-profile",
          containerId: "a".repeat(64), invocationId: "b".repeat(32),
        },
      }
      const requestPath = await writeConversationRequest(fixture.root, snapshot)
      const drafts = path.join(fixture.root, "continuations", "drafts")
      await mkdir(drafts, { mode: 0o700 })
      const draft = validateContinuationDraft({
        schemaVersion: 1, id: randomUUID(), revision: 0, snapshot, model: "synthetic-model",
        effort: "medium", summaries: [], actions: [],
      })
      const draftPath = path.join(drafts, `${draft.id}.json`)
      const originalDraft = JSON.stringify(draft)
      await writeFile(draftPath, originalDraft, { mode: 0o600 })
      const { helper, cleanup } = await writeCancellationHelper(fixture.root)
      const child = spawn(process.execPath, [helper, operation, requestPath], {
        env: { ...process.env, ...fixture.env }, stdio: ["ignore", "pipe", "pipe", "ipc"],
      })
      let stdout = ""
      let stderr = ""
      child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
      child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
      const finished = once(child, "close")
      t.after(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
      })
      const ready = once(child, "message")
      const [message] = await Promise.race([
        ready,
        finished.then(() => { throw new Error(`Cancellation helper ended before its page: ${stderr}`) }),
      ])
      assert.equal(message.ready, true)
      assert.ok(Number.isSafeInteger(message.ownedPid) && message.ownedPid > 0)
      assert.doesNotThrow(() => process.kill(message.ownedPid, 0))
      child.kill(signal)
      assert.deepEqual(await finished, [exitCode, null])
      assert.equal(stdout, "")
      assert.equal(stderr, "")
      const receipt = JSON.parse(await readFile(cleanup, "utf8"))
      assert.deepEqual(receipt, { released: true, snapshotId: "c".repeat(64), ownedPid: message.ownedPid })
      assert.throws(() => process.kill(message.ownedPid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH")
      assert.deepEqual(await readConversationRequest(fixture.root, requestPath), snapshot)
      assert.equal(await readFile(draftPath, "utf8"), originalDraft)
    })
  }
}
