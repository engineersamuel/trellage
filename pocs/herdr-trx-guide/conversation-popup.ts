#!/usr/bin/env bun
import { spawn } from "node:child_process"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { bunExecutable } from "@trellage/runtime"

import { bindFocusedConversation } from "./lib/conversation-capture.ts"
import type { ConversationSnapshot } from "./lib/conversation-contract.ts"
import { conversationGuidePopupContext } from "./lib/context.ts"
import { readConversationRequest } from "./lib/conversation-state.ts"
import { findTrellageRoot } from "./lib/trellage-root.ts"
import { waitForDismissal } from "./popup.ts"

export const conversationGuideEnvironment = (
  snapshot: ConversationSnapshot,
  requestPath: string,
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv => {
  const next: NodeJS.ProcessEnv = {
    ...env,
    TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE: requestPath,
    TRELLAGE_GUIDE_HERDR_CONTEXT_JSON: JSON.stringify(conversationGuidePopupContext(snapshot)),
  }
  for (const key of [
    "HERDR_PANE_ID", "HERDR_PLUGIN_CONTEXT_JSON", "TRELLAGE_GUIDE_HERDR_INTENT_FILE",
    "TRELLAGE_GUIDE_INVOCATION_PATH",
  ]) delete next[key]
  if (typeof env.HERDR_BIN_PATH === "string" && path.isAbsolute(env.HERDR_BIN_PATH)) {
    next.PATH = `${path.dirname(env.HERDR_BIN_PATH)}${path.delimiter}${next.PATH ?? ""}`
  }
  return next
}

const launchGuide = (root: string, env: NodeJS.ProcessEnv): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn("mise", ["run", "--raw", "trx", "--", "guide", "--next-steps"], {
      cwd: root, env, shell: false, windowsHide: true, stdio: "inherit",
    })
    child.once("error", reject)
    child.once("close", (status, signal) => {
      if (signal !== null) reject(new Error("The conversation guide was interrupted."))
      else resolve(status ?? 1)
    })
  })

export const main = async ({
  env = process.env,
  readRequest = readConversationRequest,
  bind = bindFocusedConversation,
  findRoot = findTrellageRoot,
  launch = launchGuide,
} = {}) => {
  const stateDir = env.HERDR_PLUGIN_STATE_DIR
  const requestPath = env.TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE
  const pluginRoot = env.HERDR_PLUGIN_ROOT
  if (!stateDir || !requestPath || !pluginRoot) {
    throw new Error("The conversation popup is missing plugin runtime context.")
  }
  const snapshot = await readRequest(stateDir, requestPath)
  await bind({ ...snapshot.source, expectedSource: snapshot.source }, { env })
  const root = await findRoot(pluginRoot)
  return launch(root, conversationGuideEnvironment(snapshot, requestPath, {
    ...env,
    HERDR_PLUGIN_STATE_DIR: stateDir,
    TRELLAGE_GUIDE_CONVERSATION_HELPER_ROOT: root,
  }))
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    bunExecutable()
    const status = await main()
    if (status !== 0 && status !== 130) await waitForDismissal(`Conversation guide exited with status ${status}.`)
    process.exitCode = status
  } catch {
    await waitForDismissal("The conversation guide could not start. The private request was not discarded.")
    process.exitCode = 1
  }
}
