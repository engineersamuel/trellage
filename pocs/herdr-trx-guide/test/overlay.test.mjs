import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { PassThrough } from "node:stream"
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import { main as runQueueEditor } from "../custom-popup.mjs"
import {
  main as runOverlayActionMain,
  openOverlayQueueEditor,
  queueEditorOpenTimeoutMs,
  runOverlayAction,
} from "../overlay-action.mjs"
import { runHerdr } from "../lib/herdr.mjs"
import {
  cleanupStaleOverlayRequests,
  consumeOverlayRequest,
  ensureOverlayRequestDirectories,
  overlayInvocationSource,
  overlayRequestDirectories,
  overlayRequestId,
  parseOverlayInvocationContext,
} from "../lib/overlay-request.mjs"
import {
  appendCaptureQueue,
  captureQueueIntent,
  consumeChoice,
  readCaptureQueue,
} from "../lib/state.mjs"

const execFileAsync = promisify(execFile)
const pluginRoot = fileURLToPath(new URL("..", import.meta.url))
const overlayEntrypoint = path.join(pluginRoot, "overlay-action.mjs")
const requestId = "11111111-2222-4333-8444-555555555555"
const requestToken = `trellage-guide-overlay-request:v1:${requestId}`

const contextValue = (overrides = {}) => ({
  workspace_id: "w1",
  tab_id: "w1:t1",
  focused_pane_id: "w1:p1",
  focused_pane_cwd: "/repo",
  focused_pane_agent: "copilot",
  invocation_source: overlayInvocationSource,
  selected_text: requestToken,
  correlation_id: requestId,
  ...overrides,
})

const requestValue = (overrides = {}) => ({
  schemaVersion: 1,
  requestId,
  selection: "Selected overlay text",
  capturedAt: new Date().toISOString(),
  source: {
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    cwd: "/repo",
    agent: "copilot",
    paneTitle: "Copilot task",
  },
  ...overrides,
})

const testRoot = async (t, prefix) => {
  const root = await mkdtemp(path.join(pluginRoot, `.${prefix}-`))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const writeRequest = async (home, value = requestValue(), id = requestId) => {
  const env = { HOME: home }
  const { requests } = await ensureOverlayRequestDirectories(env)
  const target = path.join(requests, `${id}.json`)
  await writeFile(target, JSON.stringify(value), { mode: 0o600 })
  await chmod(target, 0o600)
  return target
}

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error("Timed out waiting for test state")
}

const ttyPair = () => {
  const input = new PassThrough()
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = (value) => {
    input.isRaw = value
  }
  const output = new PassThrough()
  output.isTTY = true
  output.columns = 88
  output.rows = 20
  return { input, output }
}

const outputCollector = () => {
  let value = ""
  return {
    stream: {
      write: (chunk) => {
        value += chunk
        return true
      },
    },
    value: () => value,
  }
}

const runAmbiguousAppend = async (queueReader) => {
  const env = {
    HOME: "/private/home",
    HERDR_PLUGIN_STATE_DIR: "/private/state",
    HERDR_PLUGIN_ACTION_ID: "queue-add-selection-open",
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(contextValue()),
  }
  const output = outputCollector()
  const errorOutput = outputCollector()
  const status = await runOverlayActionMain(env, {
    output: output.stream,
    errorOutput: errorOutput.stream,
    actionRunner: () =>
      runOverlayAction({
        env,
        requestConsumer: async () => requestValue(),
        queueAppender: async () => {
          throw new Error("append failed after an unknown commit point")
        },
        queueReader,
        queueEditorOpener: async () => {
          throw new Error("queue editor must not open after an ambiguous append")
        },
      }),
  })
  return { status, stdout: output.value(), stderr: errorOutput.value() }
}

test("overlay tokens and request paths are fixed and private", async (t) => {
  const home = await testRoot(t, "overlay-path")
  assert.equal(overlayRequestId(requestToken), requestId)
  for (const token of [
    "trellage-guide-overlay-request:v1:AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE",
    "trellage-guide-overlay-request:v1:../../capture",
    `other:${requestId}`,
  ]) {
    assert.throws(() => overlayRequestId(token), /token is invalid/u)
  }
  const directories = overlayRequestDirectories({ HOME: home })
  assert.equal(
    directories.requests,
    path.join(
      home,
      "Library",
      "Application Support",
      "Trellage",
      "TRX Guide Overlay",
      "requests",
    ),
  )
  await ensureOverlayRequestDirectories({ HOME: home })
  assert.equal((await lstat(directories.parent)).mode & 0o777, 0o700)
  assert.equal((await lstat(directories.requests)).mode & 0o777, 0o700)
})

test("consumes one safe request and rejects symlinks and hard links", async (t) => {
  const home = await testRoot(t, "overlay-consume")
  const env = { HOME: home }
  const context = parseOverlayInvocationContext(JSON.stringify(contextValue()))
  const target = await writeRequest(home)
  const written = JSON.parse(await readFile(target, "utf8"))
  assert.deepEqual(await consumeOverlayRequest(env, requestId, context), requestValue({
    capturedAt: written.capturedAt,
  }))
  await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" })

  const { requests } = await ensureOverlayRequestDirectories(env)
  const symlinkId = "21111111-2222-4333-8444-555555555555"
  const symlinkTarget = path.join(requests, `${symlinkId}.source`)
  await writeFile(symlinkTarget, "{}", { mode: 0o600 })
  await symlink(symlinkTarget, path.join(requests, `${symlinkId}.json`))
  await assert.rejects(
    consumeOverlayRequest(env, symlinkId, { ...context, requestId: symlinkId }),
    /symlink/u,
  )

  const hardLinkId = "31111111-2222-4333-8444-555555555555"
  const hardLinkTarget = await writeRequest(
    home,
    requestValue({ requestId: hardLinkId }),
    hardLinkId,
  )
  await link(hardLinkTarget, path.join(requests, `${hardLinkId}.copy`))
  await assert.rejects(
    consumeOverlayRequest(env, hardLinkId, { ...context, requestId: hardLinkId }),
    /unsafe/u,
  )
})

test("cleans only stale safe overlay request files", async (t) => {
  const home = await testRoot(t, "overlay-stale")
  const staleId = "41111111-2222-4333-8444-555555555555"
  const currentId = "51111111-2222-4333-8444-555555555555"
  const stale = await writeRequest(home, requestValue({ requestId: staleId }), staleId)
  const current = await writeRequest(home, requestValue({ requestId: currentId }), currentId)
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000)
  await utimes(stale, old, old)

  await cleanupStaleOverlayRequests({ HOME: home })

  await assert.rejects(readFile(stale, "utf8"), { code: "ENOENT" })
  assert.equal(JSON.parse(await readFile(current, "utf8")).requestId, currentId)
})

test("rejects source and correlation mismatches after one-use consumption", async (t) => {
  const home = await testRoot(t, "overlay-mismatch")
  assert.throws(
    () =>
      parseOverlayInvocationContext(
        JSON.stringify(contextValue({ correlation_id: "61111111-2222-4333-8444-555555555555" })),
      ),
    /correlation id/u,
  )
  const target = await writeRequest(
    home,
    requestValue({ source: { ...requestValue().source, paneId: "w1:p9" } }),
  )
  const context = parseOverlayInvocationContext(JSON.stringify(contextValue()))
  await assert.rejects(
    consumeOverlayRequest({ HOME: home }, requestId, context),
    /does not match the action context/u,
  )
  await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" })
})

test("queue append is idempotent and old queue entries remain readable", async (t) => {
  const stateDir = await testRoot(t, "overlay-queue")
  await mkdir(stateDir, { recursive: true })
  await writeFile(
    path.join(stateDir, "capture-queue.json"),
    JSON.stringify({
      schemaVersion: 1,
      entries: [{ id: "legacy", answer: "Legacy capture" }],
    }),
    { mode: 0o600 },
  )
  assert.equal(captureQueueIntent(await readCaptureQueue(stateDir)), "## Captured item 1\n\nLegacy capture")

  const entry = {
    id: requestId,
    answer: "Overlay capture",
    origin: {
      surface: overlayInvocationSource,
      workspaceId: "w1",
      tabId: "w1:t1",
      paneId: "w1:p1",
      cwd: "/repo",
      capturedAt: "2026-08-31T13:47:06.967Z",
      agent: "copilot",
      paneTitle: "Copilot task",
    },
  }
  await appendCaptureQueue(stateDir, entry)
  const queue = await appendCaptureQueue(stateDir, entry)
  assert.equal(queue.entries.length, 2)
  assert.equal(queue.entries[1].id, requestId)
  assert.deepEqual(queue.entries[1].origin, entry.origin)
  assert.match(captureQueueIntent(queue), /Captured item 2 — Copilot task/u)
  assert.match(captureQueueIntent(queue), /w1 · w1:t1 · w1:p1 · \/repo/u)
})

test("add and add-and-open actions return the safe result shape", async () => {
  const baseEnv = {
    HOME: "/private/home",
    HERDR_PLUGIN_STATE_DIR: "/private/state",
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(contextValue()),
  }
  const requestConsumer = async () => requestValue()
  const queueAppender = async () => ({
    schemaVersion: 1,
    entries: [{ id: requestId, answer: "must not be returned" }],
  })
  const added = await runOverlayAction({
    env: { ...baseEnv, HERDR_PLUGIN_ACTION_ID: "queue-add-selection" },
    requestConsumer,
    queueAppender,
  })
  assert.deepEqual(added, {
    schemaVersion: 1,
    requestId,
    queued: true,
    opened: false,
    queueCount: 1,
  })
  assert.equal(JSON.stringify(added).includes("must not be returned"), false)

  let openedSource
  const opened = await runOverlayAction({
    env: {
      ...baseEnv,
      HERDR_PLUGIN_ACTION_ID: "trellage.guide-handoff.queue-add-selection-open",
    },
    requestConsumer,
    queueAppender,
    queueEditorOpener: async (source) => {
      openedSource = source
    },
  })
  assert.equal(opened.opened, true)
  assert.deepEqual(openedSource, requestValue().source)
})

test("reports queued true when an append throws after the request id was committed", async () => {
  const result = await runAmbiguousAppend(async () => ({
    schemaVersion: 1,
    entries: [{ id: requestId, answer: requestValue().selection }],
  }))
  assert.equal(result.status, 1)
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    requestId,
    queued: true,
    opened: false,
    queueCount: 1,
  })
  assert.match(result.stderr, /append did not complete cleanly/u)
  assert.equal(result.stdout.includes(requestValue().selection), false)
  assert.equal(result.stderr.includes(requestValue().selection), false)
})

test("reports queued false when a readable queue proves an append was not committed", async () => {
  const result = await runAmbiguousAppend(async () => ({
    schemaVersion: 1,
    entries: [{ id: "other", answer: "Other capture" }],
  }))
  assert.equal(result.status, 1)
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    requestId,
    queued: false,
    opened: false,
    queueCount: 1,
  })
  assert.match(result.stderr, /append did not complete cleanly/u)
})

test("emits no safe result when append completion cannot be proven", async () => {
  const result = await runAmbiguousAppend(async () => {
    throw new Error("queue state is unreadable")
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /append completion could not be proven/u)
  assert.equal(result.stderr.includes(requestValue().selection), false)
})

test("queue editor opens as a popup on the active captured pane", async () => {
  let args
  let options
  await openOverlayQueueEditor(requestValue().source, async (value, runOptions) => {
    args = value
    options = runOptions
  })
  assert.deepEqual(args, [
    "plugin",
    "pane",
    "open",
    "--plugin",
    "trellage.guide-handoff",
    "--entrypoint",
    "queue-editor",
    "--focus",
  ])
  assert.deepEqual(options, { timeoutMs: queueEditorOpenTimeoutMs })
})

test("queue editor launch timeout terminates the child and returns a safe partial result", async (t) => {
  const root = await testRoot(t, "overlay-timeout")
  const fakeHerdr = path.join(root, "herdr")
  const terminatedPath = path.join(root, "terminated")
  await writeFile(
    fakeHerdr,
    `#!/usr/bin/env node
import fs from "node:fs"
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(terminatedPath)}, String(process.pid))
  process.exit(0)
})
setInterval(() => {}, 1000)
`,
    "utf8",
  )
  await chmod(fakeHerdr, 0o755)
  const env = {
    HOME: root,
    HERDR_PLUGIN_STATE_DIR: path.join(root, "state"),
    HERDR_PLUGIN_ACTION_ID: "queue-add-selection-open",
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(contextValue()),
  }

  await assert.rejects(
    runOverlayAction({
      env,
      requestConsumer: async () => requestValue(),
      queueAppender: async () => ({
        schemaVersion: 1,
        entries: [{ id: requestId, answer: "not logged" }],
      }),
      queueEditorOpener: (source) =>
        openOverlayQueueEditor(
          source,
          (args, options) => runHerdr(args, { ...options, binary: fakeHerdr }),
          500,
        ),
    }),
    (error) => {
      assert.match(error.message, /timed out after 500ms/u)
      assert.deepEqual(error.result, {
        schemaVersion: 1,
        requestId,
        queued: true,
        opened: false,
        queueCount: 1,
      })
      assert.equal(error.message.includes("not logged"), false)
      return true
    },
  )
  assert.match(await readFile(terminatedPath, "utf8"), /^[0-9]+$/u)
})

test("partial add-and-open failure preserves the queue and emits only a safe result", async (t) => {
  const home = await testRoot(t, "overlay-partial")
  const stateDir = path.join(home, "plugin-state")
  const bin = path.join(home, "bin")
  await mkdir(bin, { recursive: true })
  const fakeHerdr = path.join(bin, "herdr")
  await writeFile(
    fakeHerdr,
    "#!/bin/sh\necho 'popup unavailable' >&2\nexit 7\n",
    "utf8",
  )
  await chmod(fakeHerdr, 0o755)
  const target = await writeRequest(home)
  const selection = requestValue().selection

  await assert.rejects(
    execFileAsync(process.execPath, [overlayEntrypoint], {
      env: {
        ...process.env,
        HOME: home,
        HERDR_BIN_PATH: fakeHerdr,
        HERDR_PLUGIN_STATE_DIR: stateDir,
        HERDR_PLUGIN_ACTION_ID: "queue-add-selection-open",
        HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify(contextValue()),
      },
    }),
    (error) => {
      assert.equal(error.code, 1)
      assert.deepEqual(JSON.parse(error.stdout), {
        schemaVersion: 1,
        requestId,
        queued: true,
        opened: false,
        queueCount: 1,
      })
      assert.match(error.stderr, /queue editor did not open.*popup unavailable/u)
      assert.equal(error.stdout.includes(selection), false)
      assert.equal(error.stderr.includes(selection), false)
      return true
    },
  )
  assert.deepEqual((await readCaptureQueue(stateDir)).entries.map((entry) => entry.id), [requestId])
  await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" })
})

test("direct queue editor navigates, removes, clears, closes, and opens the queue", async (t) => {
  const stateDir = await testRoot(t, "overlay-editor")
  await appendCaptureQueue(stateDir, { id: "one", answer: "First capture" })
  await appendCaptureQueue(stateDir, { id: "two", answer: "Second capture" })
  const context = {
    workspaceId: "w1",
    tabId: "w1:t1",
    paneId: "w1:p1",
    cwd: "/repo",
  }
  const firstTty = ttyPair()
  const firstRun = runQueueEditor({
    env: { HERDR_PLUGIN_STATE_DIR: stateDir },
    context,
    input: firstTty.input,
    output: firstTty.output,
    initialScreen: "queue",
    queueOnly: true,
  })
  firstTty.input.write("j")
  firstTty.input.write("x")
  await waitFor(async () => (await readCaptureQueue(stateDir)).entries.length === 1)
  assert.deepEqual((await readCaptureQueue(stateDir)).entries.map((entry) => entry.id), ["one"])
  firstTty.input.write("c")
  await waitFor(async () => (await readCaptureQueue(stateDir)).entries.length === 0)
  firstTty.input.write("\x1b")
  assert.equal(await firstRun, 0)

  await appendCaptureQueue(stateDir, { id: "three", answer: "Third capture" })
  const calls = []
  const secondTty = ttyPair()
  const secondRun = runQueueEditor({
    env: { HERDR_PLUGIN_STATE_DIR: stateDir },
    context,
    input: secondTty.input,
    output: secondTty.output,
    initialScreen: "queue",
    queueOnly: true,
    request: async (method, params) => calls.push({ method, params }),
  })
  secondTty.input.write("\r")
  assert.equal(await secondRun, 0)
  assert.equal(calls[0].method, "plugin.action.invoke")
  const choice = await consumeChoice(stateDir, calls[0].params.context.selected_text)
  assert.deepEqual(choice, { schemaVersion: 1, kind: "queue" })
  assert.equal((await readCaptureQueue(stateDir)).entries.length, 1)
})

test("manifest registers both pane actions on one entrypoint and the queue editor pane", async () => {
  const manifest = await readFile(path.join(pluginRoot, "herdr-plugin.toml"), "utf8")
  assert.match(manifest, /id = "queue-add-selection"[\s\S]*command = \["node", "overlay-action\.mjs"\]/u)
  assert.match(manifest, /id = "queue-add-selection-open"[\s\S]*command = \["node", "overlay-action\.mjs"\]/u)
  assert.match(manifest, /id = "queue-editor"[\s\S]*command = \["node", "queue-editor\.mjs"\]/u)
})
