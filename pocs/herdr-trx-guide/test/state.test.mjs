import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, stat, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  consumeChoice,
  consumeInvocation,
  cleanupStaleGuideIntents,
  readCompletionMarker,
  removeChoice,
  removeCompletionMarker,
  removeGuideIntent,
  removeGuideIntentSync,
  resolvePluginStateDirectory,
  writeChoice,
  writeCompletionMarker,
  writeGuideIntent,
  writeInvocation,
} from "../lib/state.mjs"
import { guideIntentMaximumLength } from "../lib/context.mjs"

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
