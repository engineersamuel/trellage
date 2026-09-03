import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"

import {
  codexSessionMetadata,
  extractClaudeConversation,
  extractClaudeFinalMessage,
  extractCodexConversation,
  extractCodexFinalMessage,
  extractCopilotConversation,
  extractCopilotFinalMessage,
} from "../lib/transcript-format.ts"
import { formatConversationIntent } from "../lib/conversation.ts"
import { captureStructuredFinalMessage, findTranscript, sessionIdFromProcessInfo } from "../lib/transcripts.ts"

const fixtures = path.join(import.meta.dirname, "fixtures")
const fixture = (name) => readFile(path.join(fixtures, name), "utf8")

test("extracts Copilot, Codex, and split Claude final answers", async () => {
  assert.equal(
    extractCopilotFinalMessage(await fixture("copilot.jsonl")),
    "Final Copilot answer.\n\n- First point\n- Second point",
  )
  assert.equal(extractCodexFinalMessage(await fixture("codex.jsonl")), "Final Codex answer.\n\nUse the council next.")
  assert.equal(
    extractClaudeFinalMessage(await fixture("claude.jsonl")),
    "Final Claude answer.\nHand this to the guide.",
  )
})

test("extracts Copilot conversation messages without tool or nested-agent traffic", () => {
  const source = [
    { type: "user.message", data: { content: "Investigate the failure." } },
    { type: "assistant.message", data: { content: "I will inspect it.", toolRequests: [{ name: "bash" }] } },
    { type: "assistant.message", data: { content: "The cache key is stale.", toolRequests: [] } },
    { type: "assistant.message", agentId: "child", data: { content: "Nested answer", toolRequests: [] } },
  ].map(JSON.stringify).join("\n")

  assert.deepEqual(extractCopilotConversation(source), [
    { role: "user", text: "Investigate the failure." },
    { role: "assistant", text: "The cache key is stale." },
  ])
})

test("extracts only human Codex input and completed assistant responses", () => {
  const message = (role, text, kinds, phase) => ({
    type: "response_item",
    payload: {
      type: "message",
      role,
      ...(phase === undefined ? {} : { phase }),
      content: [{ type: role === "assistant" ? "output_text" : "input_text", text }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
    },
  })
  const source = [
    message("developer", "Runtime policy", ["host_skills.instructions"]),
    message("user", "Repository instructions", ["agents_md.instructions"]),
    message("user", "Fix the session handoff", ["user.text"]),
    message("user", "Selected skill instructions", ["skills.selected_skill_instructions"]),
    message("assistant", "Working on it", ["unknown"], "commentary"),
    message("assistant", "The handoff now works", ["unknown"], "final_answer"),
    { type: "event_msg", payload: { type: "agent_message", message: "The handoff now works" } },
  ].map(JSON.stringify).join("\n")

  assert.deepEqual(extractCodexConversation(source), [
    { role: "user", text: "Fix the session handoff" },
    { role: "assistant", text: "The handoff now works" },
  ])
})

test("extracts Claude text while excluding tool results", () => {
  const source = [
    {
      type: "user",
      message: { content: [{ type: "text", text: "Review this change" }] },
    },
    {
      type: "user",
      message: { content: [{ type: "tool_result", content: "tool output" }] },
    },
    {
      type: "assistant",
      message: { id: "answer", content: [{ type: "text", text: "Review complete" }] },
    },
    {
      type: "assistant",
      message: { id: "answer", stop_reason: "end_turn", content: [] },
    },
  ].map(JSON.stringify).join("\n")

  assert.deepEqual(extractClaudeConversation(source), [
    { role: "user", text: "Review this change" },
    { role: "assistant", text: "Review complete" },
  ])
})

test("formats the newest complete conversation excerpt within the guide limit", () => {
  const result = formatConversationIntent(
    { agent: "codex", profile: "pstack", sessionId: "session-1", cwd: "/repo" },
    [
      { role: "user", text: "Old request" },
      { role: "assistant", text: "Old answer" },
      { role: "user", text: "Current request" },
      { role: "assistant", text: "Current answer" },
    ],
    413,
  )

  assert.equal(result.messageCount, 2)
  assert.equal(result.omittedMessageCount, 2)
  assert.doesNotMatch(result.text, /Old request/u)
  assert.match(result.text, /Older history omitted: 2 messages/u)
  assert.match(result.text, /Current request/u)
  assert.match(result.text, /Repository: \/repo/u)
})

test("rejects a latest conversation message that cannot fit the guide limit", () => {
  assert.throws(
    () =>
      formatConversationIntent(
        { agent: "codex", sessionId: "session-1", cwd: "/repo" },
        [{ role: "assistant", text: "x".repeat(100) }],
        300,
      ),
    /latest conversation message exceeds/u,
  )
})

test("does not add an older-history marker when the complete conversation fits", () => {
  const result = formatConversationIntent(
    { agent: "codex", sessionId: "session-1", cwd: "/repo" },
    [
      { role: "user", text: "Current request" },
      { role: "assistant", text: "Current answer" },
    ],
  )

  assert.equal(result.omittedMessageCount, 0)
  assert.doesNotMatch(result.text, /Older history omitted/u)
})

test("uses the newest Copilot task completion summary", () => {
  const source = [
    JSON.stringify({
      type: "assistant.message",
      data: { phase: "final_answer", content: "Older final answer" },
    }),
    JSON.stringify({
      type: "session.task_complete",
      data: { summary: "Newest task completion", success: true },
    }),
  ].join("\n")

  assert.equal(extractCopilotFinalMessage(source), "Newest task completion")
})

test("uses a later Copilot assistant message after an older task completion", () => {
  const source = [
    JSON.stringify({
      type: "session.task_complete",
      data: { summary: "Older task completion", success: true },
    }),
    JSON.stringify({
      type: "assistant.message",
      data: { content: "Later assistant answer" },
    }),
  ].join("\n")

  assert.equal(extractCopilotFinalMessage(source), "Later assistant answer")
})

test("ignores nested Copilot agent final answers", () => {
  const source = [
    JSON.stringify({
      type: "session.task_complete",
      data: { summary: "Parent completion", success: true },
    }),
    JSON.stringify({
      type: "assistant.message",
      agentId: "subagent-1",
      data: {
        parentToolCallId: "tool-1",
        phase: "final_answer",
        content: "Nested agent answer",
      },
    }),
  ].join("\n")

  assert.equal(extractCopilotFinalMessage(source), "Parent completion")
})

test("uses a later Codex assistant message after an older final marker", () => {
  const source = [
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Older answer" }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Newer answer" }],
      },
    }),
  ].join("\n")

  assert.equal(extractCodexFinalMessage(source), "Newer answer")
})

test("preserves Markdown indentation inside structured message blocks", () => {
  const source = `${JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "assistant",
      phase: "final_answer",
      content: [{ type: "output_text", text: "Result:\n\n    indented code\n" }],
    },
  })}\n`
  assert.equal(extractCodexFinalMessage(source), "Result:\n\n    indented code\n")
})

test("reads Codex session metadata before a large first JSONL record is complete", () => {
  const source =
    '{"type":"session_meta","payload":{"id":"99999999-9999-4999-8999-999999999999","cwd":"/repo","base_instructions":"' +
    "x".repeat(100_000)
  assert.deepEqual(codexSessionMetadata(source), {
    id: "99999999-9999-4999-8999-999999999999",
    cwd: "/repo",
  })
})

test("extracts one exact session id only from the matching harness process", () => {
  const processInfo = {
    foreground_processes: [
      { name: "node", argv: ["node", "server.js", "--session-id", "ignored"] },
      { name: "copilot", argv: ["copilot", "--session-id", "33333333-3333-4333-8333-333333333333"] },
    ],
  }
  assert.equal(
    sessionIdFromProcessInfo("copilot", processInfo),
    "33333333-3333-4333-8333-333333333333",
  )
  assert.equal(sessionIdFromProcessInfo("codex", processInfo), undefined)
})

const writeCopilotSession = async (home, id, cwd, text, modified) => {
  const directory = path.join(home, "session-state", id)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "workspace.yaml"), `id: ${id}\ncwd: ${cwd}\n`, "utf8")
  const events = path.join(directory, "events.jsonl")
  await writeFile(events, `{"type":"assistant.message","data":{"content":${JSON.stringify(text)}}}\n`, "utf8")
  await utimes(events, modified, modified)
  return events
}

test("prefers a process session id over a newer CWD-matched Copilot session", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-copilot-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, ".copilot")
  await mkdir(home, { recursive: true })
  const exactId = "44444444-4444-4444-8444-444444444444"
  const newerId = "55555555-5555-4555-8555-555555555555"
  await writeCopilotSession(home, exactId, "/repo", "Exact answer", new Date("2026-01-01T00:00:00Z"))
  await writeCopilotSession(home, newerId, "/repo", "Newer answer", new Date("2026-01-02T00:00:00Z"))

  const result = await captureStructuredFinalMessage({
    agent: "copilot",
    cwd: "/repo",
    processInfo: {
      foreground_processes: [{ name: "copilot", argv: ["copilot", "--session-id", exactId] }],
    },
    env: { HOME: root, COPILOT_HOME: home },
  })
  assert.equal(result?.text, "Exact answer")
  assert.equal(result?.sessionId, exactId)
})

test("does not select a transcript from CWD and modification time alone", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-cwd-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, ".copilot")
  await mkdir(home, { recursive: true })
  const first = await writeCopilotSession(
    home,
    "66666666-6666-4666-8666-666666666666",
    "/repo",
    "First",
    new Date("2026-01-01T00:00:00Z"),
  )
  const second = await writeCopilotSession(
    home,
    "77777777-7777-4777-8777-777777777777",
    "/repo",
    "Second",
    new Date("2026-01-02T00:00:00Z"),
  )
  const options = { agent: "copilot", cwd: "/repo", env: { HOME: root, COPILOT_HOME: home } }
  assert.equal(await findTranscript(options), undefined)

  const sameTime = new Date("2026-01-03T00:00:00Z")
  await utimes(first, sameTime, sameTime)
  await utimes(second, sameTime, sameTime)
  assert.equal(await findTranscript(options), undefined)
})

test("uses exact Trellage Native metadata inside only the selected profile", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-native-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sessionId = "88888888-8888-4888-8888-888888888888"
  const directHome = path.join(root, ".copilot")
  const profileHome = path.join(
    root,
    ".local",
    "share",
    "trellage",
    "profiles",
    "copilot",
    "hve",
    "home",
  )
  await writeCopilotSession(directHome, sessionId, "/repo", "Wrong direct answer", new Date())
  await writeCopilotSession(profileHome, sessionId, "/repo", "Exact Native answer", new Date())

  const result = await captureStructuredFinalMessage({
    agent: "copilot",
    cwd: "/repo",
    tokens: {
      trellage_surface: "native",
      trellage_agent: "copilot",
      trellage_profile: "hve",
      trellage_session_id: sessionId,
      trellage_pgrp: "6161",
    },
    processInfo: { foreground_process_group_id: 6161 },
    env: { HOME: root },
  })

  assert.equal(result?.text, "Exact Native answer")
  assert.equal(result?.sessionId, sessionId)
  assert.equal(result?.identitySource, "trellage-native-metadata")
  assert.equal(result?.profile, "hve")
})

test("rejects conflicting Trellage Native and process session identities", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-native-conflict-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const profileHome = path.join(
    root,
    ".local",
    "share",
    "trellage",
    "profiles",
    "copilot",
    "hve",
    "home",
  )
  await mkdir(profileHome, { recursive: true })

  await assert.rejects(
    findTranscript({
      agent: "copilot",
      cwd: "/repo",
      tokens: {
        trellage_surface: "native",
        trellage_agent: "copilot",
        trellage_profile: "hve",
        trellage_session_id: "88888888-8888-4888-8888-888888888888",
        trellage_pgrp: "6262",
      },
      processInfo: {
        foreground_process_group_id: 6262,
        foreground_processes: [
          {
            name: "copilot",
            argv: ["copilot", "--session-id", "99999999-9999-4999-8999-999999999999"],
          },
        ],
      },
      env: { HOME: root },
    }),
    /Conflicting exact session identities/u,
  )
})

test("uses exact Codex and Claude path references and rejects transcript symlinks", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "herdr-guide-paths-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const codexHome = path.join(root, ".codex")
  const claudeHome = path.join(root, ".claude")
  const codexPath = path.join(codexHome, "sessions", "2026", "codex.jsonl")
  const claudePath = path.join(claudeHome, "projects", "repo", "claude.jsonl")
  await mkdir(path.dirname(codexPath), { recursive: true })
  await mkdir(path.dirname(claudePath), { recursive: true })
  await writeFile(codexPath, await fixture("codex.jsonl"))
  await writeFile(claudePath, await fixture("claude.jsonl"))

  assert.equal(
    (
      await findTranscript({
        agent: "codex",
        cwd: "/repo",
        agentSession: { agent: "codex", kind: "path", value: codexPath },
        env: { HOME: root, CODEX_HOME: codexHome },
      })
    )?.path,
    await realpath(codexPath),
  )
  assert.equal(
    (
      await findTranscript({
        agent: "claude",
        cwd: "/repo",
        agentSession: { agent: "claude", kind: "path", value: claudePath },
        env: { HOME: root, CLAUDE_CONFIG_DIR: claudeHome },
      })
    )?.path,
    await realpath(claudePath),
  )

  const symlinkHome = path.join(root, "symlink-codex")
  const isolatedHome = path.join(root, "isolated-home")
  const outsidePath = path.join(root, "outside.jsonl")
  const symlinkPath = path.join(symlinkHome, "sessions", "linked.jsonl")
  await mkdir(path.dirname(symlinkPath), { recursive: true })
  await mkdir(isolatedHome)
  await writeFile(outsidePath, await fixture("codex.jsonl"))
  await symlink(outsidePath, symlinkPath)
  assert.equal(
    await findTranscript({
      agent: "codex",
      cwd: "/repo",
      agentSession: { agent: "codex", kind: "path", value: symlinkPath },
      env: { HOME: isolatedHome, CODEX_HOME: symlinkHome },
    }),
    undefined,
  )
})
