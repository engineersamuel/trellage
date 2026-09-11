#!/usr/bin/env node
import { consumeInvocation } from "./lib/state.ts"
import { parseInvocationContext } from "./lib/context.ts"
import { main as runCustomPopup } from "./custom-popup.ts"
import path from "node:path"
import { pathToFileURL } from "node:url"

export const main = async (env = process.env, runPopup = runCustomPopup) => {
  const stateDir = env.HERDR_PLUGIN_STATE_DIR
  const requestPath = env.TRELLAGE_GUIDE_SOURCE_PICKER_INVOCATION_PATH
  if (stateDir === undefined || requestPath === undefined) {
    throw new Error("The source picker is missing its private invocation path")
  }
  const invocation = await consumeInvocation(stateDir, requestPath)
  if (invocation?.schemaVersion !== 1 || invocation.kind !== "source-picker") {
    throw new Error("The source picker invocation is invalid")
  }
  return (runPopup as (options: Record<string, unknown>) => Promise<number>)({ env, context: parseInvocationContext(JSON.stringify({
    workspace_id: invocation.context.workspaceId,
    ...(invocation.context.tabId === undefined ? {} : { tab_id: invocation.context.tabId }),
    focused_pane_id: invocation.context.paneId,
    focused_pane_cwd: invocation.context.cwd,
    ...(invocation.context.agent === undefined ? {} : { focused_pane_agent: invocation.context.agent }),
    ...(invocation.context.invocationSource === undefined ? {} : { invocation_source: invocation.context.invocationSource }),
    ...(invocation.context.selectedText === undefined ? {} : { selected_text: invocation.context.selectedText }),
  })) })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exit(Number(await main()))
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
