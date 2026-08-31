#!/usr/bin/env node
import path from "node:path"
import { pathToFileURL } from "node:url"

import { runHerdr } from "./lib/herdr.mjs"
import {
  consumeOverlayRequest,
  parseOverlayInvocationContext,
} from "./lib/overlay-request.mjs"
import {
  appendCaptureQueue,
  readCaptureQueue,
  resolvePluginStateDirectory,
} from "./lib/state.mjs"

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
  source,
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
    "--workspace",
    source.workspaceId,
    "--target-pane",
    source.paneId,
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

export const runOverlayAction = async ({
  env = process.env,
  requestConsumer = consumeOverlayRequest,
  queueAppender = appendCaptureQueue,
  queueEditorOpener = openOverlayQueueEditor,
} = {}) => {
  const actionId = localActionId(env.HERDR_PLUGIN_ACTION_ID)
  if (typeof env.HERDR_PLUGIN_CONTEXT_JSON !== "string") {
    throw new Error("HERDR_PLUGIN_CONTEXT_JSON is not set")
  }
  const context = parseOverlayInvocationContext(env.HERDR_PLUGIN_CONTEXT_JSON)
  const stateDir = resolvePluginStateDirectory(env)
  const request = await requestConsumer(env, context.requestId, context)
  const queue = await queueAppender(stateDir, {
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
  let queueCount = 0
  try {
    queueCount = (await readCaptureQueue(resolvePluginStateDirectory(env))).entries.length
  } catch {
    // Keep failure output bounded and independent from secondary state errors.
  }
  return actionResult(requestId, false, false, queueCount)
}

export const main = async (env = process.env) => {
  let requestId
  try {
    if (typeof env.HERDR_PLUGIN_CONTEXT_JSON === "string") {
      requestId = parseOverlayInvocationContext(env.HERDR_PLUGIN_CONTEXT_JSON).requestId
    }
    const result = await runOverlayAction({ env })
    process.stdout.write(JSON.stringify(result))
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const result =
      error instanceof OverlayActionFailure
        ? error.result
        : requestId === undefined
          ? undefined
          : await failureResult(env, requestId)
    if (result !== undefined) process.stdout.write(JSON.stringify(result))
    process.stderr.write(`${message}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main()
}
