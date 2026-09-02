import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { promisify } from "node:util"

import {
  appendCaptureQueue,
  captureQueueIntent,
  clearCaptureQueue,
  consumeChoice,
  consumeInvocation,
  cleanupStaleGuideIntents,
  readCompletionMarker,
  readCaptureQueue,
  removeChoice,
  removeCompletionMarker,
  removeCaptureQueueEntry,
  removeCaptureQueueEntries,
  removeGuideIntent,
  removeGuideIntentSync,
  resolvePluginStateDirectory,
  writeChoice,
  writeCompletionMarker,
  writeGuideIntent,
  writeInvocation,
  withCaptureQueueLock,
} from "../lib/state.mjs"
import { guideIntentMaximumLength } from "../lib/context.mjs"

const execFileAsync = promisify(execFile)
const stateModuleUrl = new URL("../lib/state.mjs", import.meta.url).href

test("completion markers and invocations are private and one-use", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-state-"))
  t.after(async () => {
    const { rm } = await import("node:fs/promises")
    await rm(root, { recursive: true, force: true })
  })
  const marker = {
    schemaVersion: 1,
    paneId: "w1:p1",
    agent: "copilot",
    stateChangeSeq: 9,
    completedAt: "2026-01-01T00:00:00.000Z",
  }
  const markerPath = await writeCompletionMarker(root, marker)
  assert.deepEqual(await readCompletionMarker(root, "w1:p1"), marker)
  assert.equal((await stat(markerPath)).mode & 0o777, 0o600)

  const invocationPath = await writeInvocation(root, {
    schemaVersion: 1,
    answer: "Result",
    source: { workspaceId: "w1", paneId: "w1:p1", cwd: "/repo" },
  })
  assert.equal((await stat(invocationPath)).mode & 0o777, 0o600)
  assert.equal(JSON.parse(await readFile(invocationPath, "utf8")).answer, "Result")
  assert.equal((await consumeInvocation(root, invocationPath)).answer, "Result")
  await assert.rejects(readFile(invocationPath, "utf8"), { code: "ENOENT" })

  const maximumAnswer = "\\".repeat(guideIntentMaximumLength)
  const maximumPath = await writeInvocation(root, {
    schemaVersion: 1,
    answer: maximumAnswer,
    source: { workspaceId: "w1", paneId: "w1:p1", cwd: "/repo" },
  })
  assert.equal((await consumeInvocation(root, maximumPath)).answer, maximumAnswer)

  const guideIntentPath = await writeGuideIntent(root, "Highlighted\ntext")
  assert.equal((await stat(path.dirname(guideIntentPath))).mode & 0o777, 0o700)
  assert.equal((await stat(guideIntentPath)).mode & 0o777, 0o600)
  assert.equal(await readFile(guideIntentPath, "utf8"), "Highlighted\ntext")
  await removeGuideIntent(root, guideIntentPath)
  await assert.rejects(readFile(guideIntentPath, "utf8"), { code: "ENOENT" })

  const choiceToken = await writeChoice(root, {
    schemaVersion: 1,
    kind: "selection",
    selectedText: "Highlighted\ntext",
  })
  assert.match(choiceToken, /^trellage-guide-choice:v1:/u)
  const [choiceName] = await readdir(path.join(root, "choices"))
  const choicePath = path.join(root, "choices", choiceName)
  assert.equal((await stat(choicePath)).mode & 0o777, 0o600)
  assert.deepEqual(await consumeChoice(root, choiceToken), {
    schemaVersion: 1,
    kind: "selection",
    selectedText: "Highlighted\ntext",
  })
  await assert.rejects(readFile(choicePath, "utf8"), { code: "ENOENT" })

  const removedChoiceToken = await writeChoice(root, {
    schemaVersion: 1,
    kind: "terminal",
    paneId: "w1:p1",
    stateChangeSeq: 9,
  })
  await removeChoice(root, removedChoiceToken)
  await assert.rejects(consumeChoice(root, removedChoiceToken), { code: "ENOENT" })

  await removeCompletionMarker(root, "w1:p1")
  assert.equal(await readCompletionMarker(root, "w1:p1"), null)
})

test("does not consume an invocation path outside plugin state", async () => {
  await assert.rejects(consumeInvocation("/tmp/plugin-state", "/tmp/other.json"), /outside plugin state/)
  await assert.rejects(removeGuideIntent("/tmp/plugin-state", "/tmp/other.txt"), /outside plugin state/)
  await assert.rejects(
    consumeChoice("/tmp/plugin-state", "trellage-guide-choice:v1:../../other"),
    /Choice token is invalid/u,
  )
})

test("resolves the plugin state directory from Herdr or XDG conventions", () => {
  assert.equal(
    resolvePluginStateDirectory({
      HERDR_PLUGIN_STATE_DIR: "/private/herdr-state",
      HOME: "/home/example",
    }),
    "/private/herdr-state",
  )
  assert.equal(
    resolvePluginStateDirectory({
      XDG_STATE_HOME: "/state",
      HOME: "/home/example",
    }),
    "/state/herdr/plugins/trellage.guide-handoff",
  )
  assert.equal(
    resolvePluginStateDirectory({ HOME: "/home/example" }),
    "/home/example/.local/state/herdr/plugins/trellage.guide-handoff",
  )
})

test("capture queue persists ordered snippets until explicitly cleared", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-capture-queue-"))
  t.after(async () => {
    const { rm } = await import("node:fs/promises")
    await rm(root, { recursive: true, force: true })
  })
  await appendCaptureQueue(root, {
    answer: "First highlighted section",
    capture: { source: "selection", confidence: "user-selected" },
  })
  const queue = await appendCaptureQueue(root, {
    answer: "Second agent result",
    capture: { source: "transcript", confidence: "exact" },
  })
  assert.equal(queue.entries.length, 2)
  assert.equal(
    captureQueueIntent(queue),
    "## Captured item 1\n\nFirst highlighted section\n\n---\n\n## Captured item 2\n\nSecond agent result",
  )
  assert.equal((await stat(path.join(root, "capture-queue.json"))).mode & 0o777, 0o600)
  const reduced = await removeCaptureQueueEntry(root, queue.entries[1].id)
  assert.deepEqual(reduced.entries.map((entry) => entry.answer), ["First highlighted section"])
  await clearCaptureQueue(root)
  assert.deepEqual(await readCaptureQueue(root), { schemaVersion: 1, entries: [] })
})

test("serializes concurrent cross-process queue appends and removals", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-concurrent-queue-"))
  t.after(async () => {
    const { rm } = await import("node:fs/promises")
    await rm(root, { recursive: true, force: true })
  })
  await appendCaptureQueue(root, { id: "keep", answer: "Keep" })
  for (let index = 0; index < 6; index += 1) {
    await appendCaptureQueue(root, { id: `remove-${index}`, answer: `Remove ${index}` })
  }
  const appendScript = `
import { appendCaptureQueue } from ${JSON.stringify(stateModuleUrl)}
await appendCaptureQueue(process.argv[1], { id: process.argv[2], answer: process.argv[3] })
`
  const removeScript = `
import { removeCaptureQueueEntry } from ${JSON.stringify(stateModuleUrl)}
await removeCaptureQueueEntry(process.argv[1], process.argv[2])
`
  await Promise.all([
    ...Array.from({ length: 12 }, (_, index) =>
      execFileAsync(process.execPath, [
        "--input-type=module",
        "--eval",
        appendScript,
        root,
        `add-${index}`,
        `Added ${index}`,
      ]),
    ),
    ...Array.from({ length: 6 }, (_, index) =>
      execFileAsync(process.execPath, [
        "--input-type=module",
        "--eval",
        removeScript,
        root,
        `remove-${index}`,
      ]),
    ),
  ])

  const queue = await readCaptureQueue(root)
  assert.deepEqual(
    new Set(queue.entries.map((entry) => entry.id)),
    new Set(["keep", ...Array.from({ length: 12 }, (_, index) => `add-${index}`)]),
  )
  assert.equal((await stat(path.join(root, "capture-queue.json"))).mode & 0o777, 0o600)
})

test("serializes concurrent clear and append without restoring cleared entries", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-concurrent-clear-"))
  t.after(async () => {
    const { rm } = await import("node:fs/promises")
    await rm(root, { recursive: true, force: true })
  })
  await appendCaptureQueue(root, { id: "old", answer: "Old capture" })
  const appendScript = `
import { appendCaptureQueue } from ${JSON.stringify(stateModuleUrl)}
await appendCaptureQueue(process.argv[1], { id: "new", answer: "New capture" })
`
  const clearScript = `
import { clearCaptureQueue } from ${JSON.stringify(stateModuleUrl)}
await clearCaptureQueue(process.argv[1])
`
  await Promise.all([
    execFileAsync(process.execPath, ["--input-type=module", "--eval", appendScript, root]),
    execFileAsync(process.execPath, ["--input-type=module", "--eval", clearScript, root]),
  ])

  const ids = (await readCaptureQueue(root)).entries.map((entry) => entry.id)
  assert.ok(
    ids.length === 0 || (ids.length === 1 && ids[0] === "new"),
    `unexpected serialized result: ${JSON.stringify(ids)}`,
  )
})

test("recovers safe stale queue locks and fails closed on unsafe or live locks", async (t) => {
  const staleRoot = await mkdtemp(path.join(tmpdir(), "herdr-guide-stale-lock-"))
  const unsafeRoot = await mkdtemp(path.join(tmpdir(), "herdr-guide-unsafe-lock-"))
  const liveRoot = await mkdtemp(path.join(tmpdir(), "herdr-guide-live-lock-"))
  t.after(async () => {
    const { rm } = await import("node:fs/promises")
    await Promise.all([
      rm(staleRoot, { recursive: true, force: true }),
      rm(unsafeRoot, { recursive: true, force: true }),
      rm(liveRoot, { recursive: true, force: true }),
    ])
  })

  const staleLock = path.join(staleRoot, "capture-queue.lock")
  await mkdir(staleLock, { mode: 0o700 })
  const old = new Date(Date.now() - 10_000)
  await utimes(staleLock, old, old)
  await appendCaptureQueue(
    staleRoot,
    { id: "recovered", answer: "Recovered" },
    { stale: 2000, update: 1000, retries: 0 },
  )
  assert.deepEqual((await readCaptureQueue(staleRoot)).entries.map((entry) => entry.id), ["recovered"])

  const unsafeLock = path.join(unsafeRoot, "capture-queue.lock")
  await writeFile(unsafeLock, "not a directory", { mode: 0o600 })
  await assert.rejects(
    appendCaptureQueue(
      unsafeRoot,
      { id: "blocked", answer: "Blocked" },
      { stale: 2000, update: 1000, retries: 0 },
    ),
    /Lock file is already being held/u,
  )
  assert.deepEqual(await readCaptureQueue(unsafeRoot), { schemaVersion: 1, entries: [] })
  assert.equal(await readFile(unsafeLock, "utf8"), "not a directory")

  const liveLock = path.join(liveRoot, "capture-queue.lock")
  await mkdir(liveLock, { mode: 0o700 })
  await assert.rejects(
    appendCaptureQueue(
      liveRoot,
      { id: "timed-out", answer: "Timed out" },
      {
        stale: 60_000,
        update: 1000,
        retries: { retries: 2, factor: 1, minTimeout: 5, maxTimeout: 5 },
      },
    ),
    /Lock file is already being held/u,
  )
  assert.deepEqual(await readCaptureQueue(liveRoot), { schemaVersion: 1, entries: [] })
})

test("fails a queue mutation when proper-lockfile reports compromise", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-compromised-lock-"))
  t.after(() => rm(root, { recursive: true, force: true }))

  await assert.rejects(
    withCaptureQueueLock(
      root,
      async (assertLockHealthy) => {
        await rm(path.join(root, "capture-queue.lock"), { recursive: true, force: true })
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50))
          assertLockHealthy()
        }
      },
      { stale: 2000, update: 1000, retries: 0 },
    ),
    /lock was compromised/u,
  )
})

test("removes only captured snapshot ids under the queue lock", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-snapshot-remove-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await appendCaptureQueue(root, { id: "snapshot-1", answer: "First snapshot item" })
  await appendCaptureQueue(root, { id: "snapshot-2", answer: "Second snapshot item" })
  await appendCaptureQueue(root, { id: "later", answer: "Later item" })

  const queue = await removeCaptureQueueEntries(root, ["snapshot-1", "snapshot-2"])

  assert.deepEqual(queue.entries.map((entry) => entry.id), ["later"])
  assert.deepEqual((await readCaptureQueue(root)).entries.map((entry) => entry.id), ["later"])
})

test("removes stale guide intents and keeps current files", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-stale-state-"))
  t.after(async () => {
    const { rm } = await import("node:fs/promises")
    await rm(root, { recursive: true, force: true })
  })
  const stalePath = await writeGuideIntent(root, "stale")
  const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000)
  await utimes(stalePath, staleTime, staleTime)
  const currentPath = await writeGuideIntent(root, "current")

  await assert.rejects(readFile(stalePath, "utf8"), { code: "ENOENT" })
  assert.equal(await readFile(currentPath, "utf8"), "current")
  await cleanupStaleGuideIntents(root)
  assert.equal(await readFile(currentPath, "utf8"), "current")
  removeGuideIntentSync(root, currentPath)
  await assert.rejects(readFile(currentPath, "utf8"), { code: "ENOENT" })
})
