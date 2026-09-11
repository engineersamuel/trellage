#!/usr/bin/env node
import path from "node:path"
import { pathToFileURL } from "node:url"

import { panelInvocationSource, parseInvocationContext } from "./lib/context.ts"
import { HerdrRequestError, requestHerdr, runHerdr } from "./lib/herdr.ts"
import { removeInvocation, resolvePluginStateDirectory, writeInvocation } from "./lib/state.ts"

const pluginId = "trellage.guide-handoff"
const invocationEnvironment = "TRELLAGE_GUIDE_SOURCE_PICKER_INVOCATION_PATH"

export const openSourcePickerPopup = async (requestPath, env = process.env, run = runHerdr) => {
  await run([
    "plugin", "pane", "open", "--plugin", pluginId, "--entrypoint", "source-picker",
    "--env", `${invocationEnvironment}=${requestPath}`, "--focus",
  ], { binary: env.HERDR_BIN_PATH, timeoutMs: 30_000 })
}

const closeExistingPopup = async (context, request = requestHerdr) => {
  if (context.invocationSource !== panelInvocationSource) return
  try {
    await request("popup.close", {})
  } catch (error) {
    if (!(error instanceof HerdrRequestError && error.code === "popup_not_open")) throw error
  }
}

export const runSourcePickerAction = async ({
  env = process.env,
  request = requestHerdr,
  run = runHerdr,
  invocationWriter = writeInvocation,
  invocationRemover = removeInvocation,
} = {}) => {
  if (typeof env.HERDR_PLUGIN_CONTEXT_JSON !== "string") throw new Error("HERDR_PLUGIN_CONTEXT_JSON is not set")
  const context = parseInvocationContext(env.HERDR_PLUGIN_CONTEXT_JSON)
  const stateDir = resolvePluginStateDirectory(env)
  const requestPath = await invocationWriter(stateDir, { schemaVersion: 1, kind: "source-picker", context })
  try {
    await closeExistingPopup(context, request)
    await openSourcePickerPopup(requestPath, env, run)
  } catch (error) {
    await invocationRemover(requestPath)
    throw error
  }
  return requestPath
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runSourcePickerAction()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
