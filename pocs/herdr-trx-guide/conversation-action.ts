#!/usr/bin/env bun
import path from "node:path"
import { pathToFileURL } from "node:url"
import { bunExecutable } from "@trellage/runtime"

import { bindFocusedConversation, captureFocusedConversation } from "./lib/conversation-capture.ts"
import { panelInvocationSource, parseConversationInvocationContext } from "./lib/context.ts"
import { consumeConversationChoice, writeConversationRequest } from "./lib/conversation-state.ts"
import { HerdrRequestError, requestHerdr, runHerdr } from "./lib/herdr.ts"
import { ConversationSourceError } from "./lib/conversation-reader.ts"

const closeSourcePicker = async (source: string | undefined, request: typeof requestHerdr) => {
  if (source !== panelInvocationSource) return
  try {
    await request("popup.close", {})
  } catch (error) {
    if (!(error instanceof HerdrRequestError && error.code === "popup_not_open")) throw error
  }
}

export const main = async ({
  env = process.env,
  bind = bindFocusedConversation,
  capture = captureFocusedConversation,
  consumeChoice = consumeConversationChoice,
  stageRequest = writeConversationRequest,
  request = requestHerdr,
  run = runHerdr,
} = {}) => {
  if (!env.HERDR_PLUGIN_CONTEXT_JSON || !env.HERDR_PLUGIN_STATE_DIR) {
    throw new Error("The conversation action is missing plugin runtime context.")
  }
  const context = parseConversationInvocationContext(env.HERDR_PLUGIN_CONTEXT_JSON)
  const stateDir = env.HERDR_PLUGIN_STATE_DIR
  const binding = context.conversationChoiceToken === undefined
    ? await bind(context, { env })
    : await consumeChoice(stateDir, context.conversationChoiceToken)
  const snapshot = await capture({ ...context, binding }, { env })
  const requestPath = await stageRequest(stateDir, snapshot)
  await closeSourcePicker(context.invocationSource, request)
  await run([
    "plugin", "pane", "open", "--plugin", "trellage.guide-handoff",
    "--entrypoint", "conversation", "--env",
    `TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE=${requestPath}`, "--focus",
  ], { binary: env.HERDR_BIN_PATH, timeoutMs: 30_000 })
  return requestPath
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    bunExecutable()
    await main()
  } catch (error) {
    const message = error instanceof ConversationSourceError
      ? error.message
      : "The focused conversation could not be captured or opened. No other source was selected; any saved snapshot remains private."
    console.error(message)
    try {
      await runHerdr(["notification", "show", "Conversation next steps unavailable", "--body", message], { timeoutMs: 5000 })
    } catch {
      // Notification failure must not disclose an external command's stderr.
    }
    process.exitCode = 1
  }
}
