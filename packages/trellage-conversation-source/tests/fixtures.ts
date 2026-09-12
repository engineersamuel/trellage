import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { ConversationAgent, ConversationSurface } from "@trellage/guide-core/conversation"
import type { FocusedCaptureDependencies } from "../src/conversation-capture.ts"
import type { JsonRecord } from "../src/records.ts"

export const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url))
export const sessionId = "11111111-1111-4111-8111-111111111111"
export const jsonl = (records: ReadonlyArray<JsonRecord>) =>
  `${records.map((record) => JSON.stringify(record)).join("\n")}\n`

export const humanRecord = (agent: ConversationAgent, id: string, text: string): JsonRecord => {
  if (agent === ConversationAgent.Copilot) return { type: "user.message", id, data: { content: text } }
  if (agent === ConversationAgent.Codex) return {
    type: "response_item", id: `event-${id}`,
    payload: {
      id, type: "message", role: "user", content: [{ type: "input_text", text }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
    },
  }
  return { type: "user", uuid: id, message: { content: text } }
}

export const assistantRecord = (
  agent: ConversationAgent, id: string, text: string, completed = true,
): JsonRecord => {
  if (agent === ConversationAgent.Copilot) return {
    type: "assistant.message", id, data: { content: text, ...(completed ? { phase: "final_answer" } : {}) },
  }
  if (agent === ConversationAgent.Codex) return {
    type: "response_item", id: `event-${id}`,
    payload: {
      id, type: "message", role: "assistant", ...(completed ? { phase: "final_answer" } : {}),
      content: [{ type: "output_text", text }],
    },
  }
  return {
    type: "assistant", uuid: `event-${id}`,
    message: { id, content: [{ type: "text", text }], stop_reason: completed ? "end_turn" : null },
  }
}

export const metadataRecord = (agent: ConversationAgent, cwd: string): JsonRecord => {
  if (agent === ConversationAgent.Copilot) return { type: "session.start", data: { sessionId } }
  if (agent === ConversationAgent.Codex) return { type: "session_meta", payload: { id: sessionId, cwd } }
  return { type: "file-history-snapshot", sessionId, cwd }
}

export const writeHistory = async (
  home: string, agent: ConversationAgent, cwd: string, records: ReadonlyArray<JsonRecord>,
) => {
  const transcriptPath = agent === ConversationAgent.Copilot
    ? path.join(home, "session-state", sessionId, "events.jsonl")
    : agent === ConversationAgent.Codex
      ? path.join(home, "sessions", "2026", `rollout-${sessionId}.jsonl`)
      : path.join(home, "projects", "synthetic", `${sessionId}.jsonl`)
  await mkdir(path.dirname(transcriptPath), { recursive: true, mode: 0o700 })
  if (agent === ConversationAgent.Copilot) {
    await writeFile(path.join(path.dirname(transcriptPath), "workspace.yaml"), `cwd: ${cwd}\n`, { mode: 0o600 })
  }
  await writeFile(transcriptPath, jsonl(records), { mode: 0o600 })
  return transcriptPath
}

export const captureFixture = async (
  t: Pick<TestContext, "after">,
  agent = ConversationAgent.Copilot,
  surface: ConversationSurface.Host | ConversationSurface.Native = ConversationSurface.Host,
) => {
  const fixtureParent = path.join(repositoryRoot, ".t")
  await mkdir(fixtureParent, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(path.join(fixtureParent, "conversation-source-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const cwd = path.join(root, "repo")
  await mkdir(cwd, { mode: 0o700 })
  const home = surface === ConversationSurface.Host
    ? path.join(root, `.${agent}`)
    : path.join(root, ".local/share/trellage/profiles", agent, "fixture-profile", "home")
  const records = [
    metadataRecord(agent, cwd),
    humanRecord(agent, "user-1", "Synthetic human goal"),
    assistantRecord(agent, "assistant-1", "Synthetic completed answer"),
    humanRecord(agent, "user-2", "Synthetic pending follow-up"),
    assistantRecord(agent, "assistant-2", "Synthetic unfinished answer", false),
  ]
  const transcriptPath = await writeHistory(home, agent, cwd, records)
  const context = { workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", cwd }
  const agentInfo: JsonRecord = {
    workspace_id: context.workspaceId, tab_id: context.tabId, pane_id: context.paneId,
    agent, agent_status: "working", cwd,
    agent_session: { agent, kind: "id", value: sessionId },
    ...(surface === ConversationSurface.Native ? {
      tokens: {
        trellage_surface: surface, trellage_agent: agent, trellage_profile: "fixture-profile",
        trellage_session_id: sessionId, trellage_pgrp: "12345",
      },
    } : {}),
  }
  const processInfo: JsonRecord = {
    pane_id: context.paneId, foreground_process_group_id: 12345,
    foreground_processes: [{ name: agent, argv: [agent, "--session-id", sessionId] }],
  }
  const env: NodeJS.ProcessEnv = {
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    HOME: root, HERDR_PLUGIN_STATE_DIR: root, TRELLAGE_ROOT: repositoryRoot,
    COPILOT_HOME: path.join(root, ".copilot"), CODEX_HOME: path.join(root, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
    XDG_CONFIG_HOME: path.join(root, "config"), XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
  }
  const dependencies = {
    env,
    getAgentForPane: async (paneId: string) => { assert.equal(paneId, context.paneId); return agentInfo },
    processReader: async (paneId: string) => { assert.equal(paneId, context.paneId); return processInfo },
    serverIdentifier: async () => "synthetic-server",
  } satisfies FocusedCaptureDependencies
  return { root, cwd, home, records, transcriptPath, context, agentInfo, processInfo, env, dependencies }
}
