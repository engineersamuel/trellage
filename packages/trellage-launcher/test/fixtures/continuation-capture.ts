import assert from "node:assert/strict"
import { captureFocusedConversation, writeConversationRequest } from "@trellage/conversation-source"

assert(process.versions.bun, "Conversation capture fixtures must execute with Bun")
const raw = process.env.TRELLAGE_GUIDE_HERDR_CONTEXT_JSON
const stateRoot = process.env.HERDR_PLUGIN_STATE_DIR
if (raw === undefined || stateRoot === undefined)
  throw new Error("Conversation capture fixture requires context and private state.")
const context: unknown = JSON.parse(raw)
if (
  context === null ||
  typeof context !== "object" ||
  !("workspaceId" in context) ||
  typeof context.workspaceId !== "string" ||
  !("paneId" in context) ||
  typeof context.paneId !== "string" ||
  !("cwd" in context) ||
  typeof context.cwd !== "string"
)
  throw new Error("Conversation capture fixture received invalid focused-pane context.")
const snapshot = await captureFocusedConversation({
  workspaceId: context.workspaceId,
  paneId: context.paneId,
  cwd: context.cwd,
})
const requestPath = await writeConversationRequest(stateRoot, snapshot)
process.stdout.write(JSON.stringify({ requestPath }))
