import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

export const repositoryRoot = path.resolve(import.meta.dirname, "../../../..")
export const sessionId = "11111111-1111-4111-8111-111111111111"
export const jsonl = (records) => `${records.map((record) => JSON.stringify(record)).join("\n")}\n`

export const fixtureDirectory = async (t) => {
  const root = path.join(repositoryRoot, ".t", `conv-${randomUUID().slice(0, 8)}`)
  await mkdir(root, { recursive: true, mode: 0o700 })
  await writeFile(path.join(root, "package.json"), '{"type":"commonjs"}\n', { mode: 0o600 })
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

const humanCodex = (id, content) => ({
  type: "response_item", id: `event-${id}`,
  payload: {
    id, type: "message", role: "user", content: [{ type: "input_text", text: content }],
    internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
  },
})

export const humanRecord = (agent, id, content) => {
  if (agent === "copilot") return { type: "user.message", id, data: { content } }
  if (agent === "codex") return humanCodex(id, content)
  return { type: "user", uuid: id, message: { content } }
}

export const assistantRecord = (agent, id, content, completed = true) => {
  if (agent === "copilot") return {
    type: "assistant.message", id,
    data: { content, ...(completed ? { phase: "final_answer" } : {}) },
  }
  if (agent === "codex") return {
    type: "response_item", id: `event-${id}`,
    payload: {
      id, type: "message", role: "assistant",
      ...(completed ? { phase: "final_answer" } : {}),
      content: [{ type: "output_text", text: content }],
    },
  }
  return {
    type: "assistant", uuid: `event-${id}`,
    message: {
      id, content: [{ type: "text", text: content }],
      stop_reason: completed ? "end_turn" : null,
    },
  }
}

export const metadataRecord = (agent, cwd, id = sessionId) => {
  if (agent === "copilot") return { type: "session.start", data: { sessionId: id } }
  if (agent === "codex") return { type: "session_meta", payload: { id, cwd } }
  return { type: "file-history-snapshot", sessionId: id, cwd }
}

export const historyRecords = (agent, cwd) => [
  metadataRecord(agent, cwd),
  humanRecord(agent, "user-1", "Original human goal"),
  assistantRecord(agent, "assistant-1", "Completed visible answer"),
  humanRecord(agent, "user-2", "Pending human follow-up"),
  assistantRecord(agent, "assistant-2", "Pending assistant text", false),
]

export const writeHarnessHistory = async (home, agent, cwd, records, id = sessionId) => {
  const transcriptPath = agent === "copilot"
    ? path.join(home, "session-state", id, "events.jsonl")
    : agent === "codex"
      ? path.join(home, "sessions", "2026", `rollout-${id}.jsonl`)
      : path.join(home, "projects", "synthetic", `${id}.jsonl`)
  await mkdir(path.dirname(transcriptPath), { recursive: true, mode: 0o700 })
  if (agent === "copilot") {
    await writeFile(path.join(path.dirname(transcriptPath), "workspace.yaml"), `id: ${id}\ncwd: ${cwd}\n`, { mode: 0o600 })
  }
  await writeFile(transcriptPath, jsonl(records), { mode: 0o600 })
  return transcriptPath
}

export const captureFixture = async (t, agent = "copilot", surface = "host") => {
  const root = await fixtureDirectory(t)
  const cwd = path.join(root, "repo")
  await mkdir(cwd, { mode: 0o700 })
  const home = surface === "host"
    ? path.join(root, `.${agent}`)
    : path.join(root, ".local", "share", "trellage", "profiles", agent, "fixture-profile", "home")
  const records = historyRecords(agent, cwd)
  const transcriptPath = await writeHarnessHistory(home, agent, cwd, records)
  const context = { workspaceId: "workspace-1", tabId: "tab-1", paneId: "pane-1", cwd }
  const agentInfo = {
    workspace_id: context.workspaceId, tab_id: context.tabId, pane_id: context.paneId,
    agent, agent_status: "working", state_change_seq: 1, cwd,
    agent_session: { agent, kind: "id", value: sessionId },
    ...(surface === "native" ? {
      tokens: {
        trellage_surface: "native", trellage_agent: agent,
        trellage_profile: "fixture-profile", trellage_session_id: sessionId,
        trellage_pgrp: "12345",
      },
    } : {}),
  }
  const processInfo = {
    pane_id: context.paneId, foreground_process_group_id: 12345,
    foreground_processes: [{ name: agent, argv: [agent, "--session-id", sessionId] }],
  }
  const env = {
    HOME: root,
    HERDR_PLUGIN_STATE_DIR: root,
    COPILOT_HOME: path.join(root, ".copilot"),
    CODEX_HOME: path.join(root, ".codex"),
    CLAUDE_CONFIG_DIR: path.join(root, ".claude"),
  }
  const dependencies = {
    env,
    getAgentForPane: async (paneId) => {
      if (paneId !== context.paneId) throw new Error("Wrong pane")
      return { ...agentInfo, state_change_seq: ++agentInfo.state_change_seq }
    },
    processReader: async (paneId) => {
      if (paneId !== context.paneId) throw new Error("Wrong pane")
      return processInfo
    },
    serverIdentifier: async () => "synthetic-server",
  }
  return { root, cwd, home, records, transcriptPath, context, agentInfo, processInfo, env, dependencies }
}
