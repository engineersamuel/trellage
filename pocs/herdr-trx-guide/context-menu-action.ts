#!/usr/bin/env node
import path from "node:path"
import { pathToFileURL } from "node:url"

import {
  captureContextMenuRequest,
  contextMenuRequestFromChoice,
  contextMenuSourceMatches,
  parseContextMenuRequest,
  type ContextMenuRequest,
} from "./lib/context-menu.ts"
import {
  panelInvocationSource,
  parseInvocationContext,
  type InvocationContext,
} from "./lib/context.ts"
import {
  HerdrRequestError,
  notify,
  requestHerdr,
  runHerdr,
} from "./lib/herdr.ts"
import {
  consumeChoice,
  removeInvocation,
  removeChoice,
  resolvePluginStateDirectory,
  writeChoice,
  writeInvocation,
} from "./lib/state.ts"

const pluginId = "trellage.guide-handoff"
const invocationEnvironment = "TRELLAGE_GUIDE_CONTEXT_MENU_INVOCATION_PATH"

export interface ContextMenuActionDependencies {
  readonly env?: NodeJS.ProcessEnv
  readonly capture?: (context: InvocationContext, env: NodeJS.ProcessEnv) => Promise<ContextMenuRequest>
  readonly request?: typeof requestHerdr
  readonly run?: typeof runHerdr
  readonly choiceConsumer?: typeof consumeChoice
  readonly invocationWriter?: typeof writeInvocation
  readonly invocationRemover?: typeof removeInvocation
}

export interface ContextMenuChoiceDependencies {
  readonly request: ContextMenuRequest
  readonly context: InvocationContext
  readonly stateDir: string
  readonly herdr?: typeof requestHerdr
  readonly choiceWriter?: typeof writeChoice
  readonly choiceRemover?: typeof removeChoice
}

export const invokeContextMenuChoice = async ({
  request,
  context,
  stateDir,
  herdr = requestHerdr,
  choiceWriter = writeChoice,
  choiceRemover = removeChoice,
}: ContextMenuChoiceDependencies) => {
  const parsed = parseContextMenuRequest(request)
  const token = await choiceWriter(stateDir, { schemaVersion: 1, kind: "context-menu", request: parsed })
  try {
    await herdr("plugin.action.invoke", {
      action_id: "trellage.guide-handoff.context-menu",
      context: {
        workspace_id: context.workspaceId,
        ...(context.tabId === undefined ? {} : { tab_id: context.tabId }),
        focused_pane_id: context.paneId,
        focused_pane_cwd: context.cwd,
        ...(context.agent === undefined ? {} : { focused_pane_agent: context.agent }),
        invocation_source: panelInvocationSource,
        selected_text: token,
      },
    })
  } catch (error) {
    await choiceRemover(stateDir, token)
    throw error
  }
  return token
}

const closeSourcePicker = async (source: string | undefined, request: typeof requestHerdr) => {
  if (source !== panelInvocationSource) return
  try {
    await request("popup.close", {})
  } catch (error) {
    if (!(error instanceof HerdrRequestError && error.code === "popup_not_open")) throw error
  }
}

export const openContextMenuPopup = async (
  requestPath: string,
  env: NodeJS.ProcessEnv,
  run: typeof runHerdr = runHerdr,
) => {
  await run([
    "plugin",
    "pane",
    "open",
    "--plugin",
    "trellage.guide-handoff",
    "--entrypoint",
    "context-menu",
    "--env",
    `${invocationEnvironment}=${requestPath}`,
    "--focus",
  ], { binary: env.HERDR_BIN_PATH, timeoutMs: 30_000 })
}

const stagedRequest = async (
  context: InvocationContext,
  stateDir: string,
  token: string,
  consumer: typeof consumeChoice,
): Promise<ContextMenuRequest> => {
  const request = contextMenuRequestFromChoice(await consumer(stateDir, token))
  if (!contextMenuSourceMatches(request, context)) {
    throw new Error("The contextual rewrite source changed before it opened")
  }
  return request
}

export const runContextMenuAction = async ({
  env = process.env,
  capture = (context, captureEnv) => captureContextMenuRequest({ context, env: captureEnv }),
  request: requestHerdrClient = requestHerdr,
  run = runHerdr,
  choiceConsumer = consumeChoice,
  invocationWriter = writeInvocation,
  invocationRemover = removeInvocation,
}: ContextMenuActionDependencies = {}): Promise<{ readonly request: ContextMenuRequest; readonly requestPath: string }> => {
  if (typeof env.HERDR_PLUGIN_CONTEXT_JSON !== "string") throw new Error("HERDR_PLUGIN_CONTEXT_JSON is not set")
  const context = parseInvocationContext(env.HERDR_PLUGIN_CONTEXT_JSON)
  const stateDir = resolvePluginStateDirectory(env)
  const contextMenuRequest = context.invocationSource === panelInvocationSource && typeof context.selectedText === "string"
    ? await stagedRequest(context, stateDir, context.selectedText, choiceConsumer)
    : await capture(context, env)
  const requestPath = await invocationWriter(stateDir, parseContextMenuRequest(contextMenuRequest))
  try {
    await closeSourcePicker(context.invocationSource, requestHerdrClient)
    await openContextMenuPopup(requestPath, env, run)
  } catch (error) {
    await invocationRemover(requestPath)
    throw error
  }
  return { request: contextMenuRequest, requestPath }
}

export { captureContextMenuRequest, parseContextMenuRequest }

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runContextMenuAction()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`trellage.guide-handoff context menu: ${message}\n`)
    await notify("TRX rewrite unavailable", message)
    process.exitCode = 1
  }
}
