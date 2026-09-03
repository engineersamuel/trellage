#!/usr/bin/env node
// @ts-nocheck -- Legacy macOS overlay adapter; protocol modules are type-checked.
import path from "node:path"
import { pathToFileURL } from "node:url"

import { runHerdr } from "./lib/herdr.ts"
import {
  consumeOverlayRequest,
  parseOverlayInvocationContext,
} from "./lib/overlay-request.ts"
import {
  appendCaptureQueue,
  readCaptureQueue,
  resolvePluginStateDirectory,
} from "./lib/state.ts"

const pluginId = "trellage.guide-handoff"
const addActionId = "queue-add-selection"
const addAndOpenActionId = "queue-add-selection-open"
export const queueEditorOpenTimeoutMs = 10_000

class OverlayActionFailure extends Error {
  constructor(message, result) {
    super(message)
    this.name = "OverlayActionFailure"
    this.result = result
  }
}

class OverlayActionUnresolvedFailure extends Error {
  constructor(message) {
    super(message)
    this.name = "OverlayActionUnresolvedFailure"
  }
}

const localActionId = (value) => {
  if (typeof value !== "string") throw new Error("HERDR_PLUGIN_ACTION_ID is not set")
  const prefix = `${pluginId}.`
  const actionId = value.startsWith(prefix) ? value.slice(prefix.length) : value
  if (actionId !== addActionId && actionId !== addAndOpenActionId) {
    throw new Error("Overlay action id is invalid")
  }
  return actionId
}

export const openOverlayQueueEditor = async (
  _source,
  runner = runHerdr,
  timeoutMs = queueEditorOpenTimeoutMs,
) => {
  await runner([
    "plugin",
    "pane",
    "open",
    "--plugin",
    pluginId,
    "--entrypoint",
    "queue-editor",
    "--focus",
  ], { timeoutMs })
}

const actionResult = (requestId, queued, opened, queueCount) => ({
  schemaVersion: 1,
  requestId,
  queued,
  opened,
  queueCount,
})

const queueCommitResult = async (stateDir, requestId, queueReader) => {
  try {
    const queue = await queueReader(stateDir)
    return actionResult(
      requestId,
      queue.entries.some((entry) => entry.id === requestId),
      false,
      queue.entries.length,
    )
  } catch {
    return undefined
  }
}

export const runOverlayAction = async ({
  env = process.env,
  requestConsumer = consumeOverlayRequest,
  queueAppender = appendCaptureQueue,
  queueReader = readCaptureQueue,
  queueEditorOpener = openOverlayQueueEditor,
} = {}) => {
  const actionId = localActionId(env.HERDR_PLUGIN_ACTION_ID)
  if (typeof env.HERDR_PLUGIN_CONTEXT_JSON !== "string") {
    throw new Error("HERDR_PLUGIN_CONTEXT_JSON is not set")
  }
  const context = parseOverlayInvocationContext(env.HERDR_PLUGIN_CONTEXT_JSON)
  const stateDir = resolvePluginStateDirectory(env)
  const request = await requestConsumer(env, context.requestId, context)
  let queue
  try {
    queue = await queueAppender(stateDir, {
      id: request.requestId,
      answer: request.selection,
      capture: { source: "selection", confidence: "user-selected" },
      addedAt: new Date().toISOString(),
      origin: {
        surface: "trellage-guide-overlay",
        workspaceId: request.source.workspaceId,
        tabId: request.source.tabId,
        paneId: request.source.paneId,
        cwd: request.source.cwd,
        capturedAt: request.capturedAt,
        ...(request.source.agent === undefined ? {} : { agent: request.source.agent }),
        ...(request.source.paneTitle === undefined ? {} : { paneTitle: request.source.paneTitle }),
      },
    })
  } catch {
    const result = await queueCommitResult(stateDir, request.requestId, queueReader)
    if (result === undefined) {
      throw new OverlayActionUnresolvedFailure("Capture queue append completion could not be proven")
    }
    throw new OverlayActionFailure("Capture queue append did not complete cleanly", result)
  }
  const queuedResult = actionResult(request.requestId, true, false, queue.entries.length)
  if (actionId === addActionId) return queuedResult
  try {
    await queueEditorOpener(request.source)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new OverlayActionFailure(`Selection was queued, but the queue editor did not open: ${message}`, queuedResult)
  }
  return actionResult(request.requestId, true, true, queue.entries.length)
}

const failureResult = async (env, requestId) => {
  try {
    const queue = await readCaptureQueue(resolvePluginStateDirectory(env))
    return actionResult(
      requestId,
      queue.entries.some((entry) => entry.id === requestId),
      false,
      queue.entries.length,
    )
  } catch {
    return undefined
  }
}

const safeFailureResult = async (error, env, requestId) => {
  if (error instanceof OverlayActionFailure) return error.result
  if (error instanceof OverlayActionUnresolvedFailure || requestId === undefined) {
    return undefined
  }
  return failureResult(env, requestId)
}

export const main = async (
  env = process.env,
  {
    output = process.stdout,
    errorOutput = process.stderr,
    actionRunner = runOverlayAction,
  } = {},
) => {
  let requestId
  try {
    if (typeof env.HERDR_PLUGIN_CONTEXT_JSON === "string") {
      requestId = parseOverlayInvocationContext(env.HERDR_PLUGIN_CONTEXT_JSON).requestId
    }
    const result = await actionRunner({ env })
    output.write(JSON.stringify(result))
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const result = await safeFailureResult(error, env, requestId)
    if (result !== undefined) output.write(JSON.stringify(result))
    errorOutput.write(`${message}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
