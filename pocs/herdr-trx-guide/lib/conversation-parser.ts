import { createHash } from "node:crypto"
import path from "node:path"

import {
  ConversationAgent, ConversationRole, type ConversationMessage, type ConversationSource,
} from "./conversation-contract.ts"
import { conversationCapturePolicy, type ConversationCapturePolicy } from "./conversation-policy.ts"
import { ConversationSourceError, type ConversationRecord } from "./conversation-reader.ts"

type Json = Record<string, unknown>
type Agent = ConversationSource["agent"]
type Role = ConversationMessage["role"]

const object = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {}
const identifier = (value: unknown) =>
  typeof value === "string" && value.length > 0 ? value : undefined
const blocks = (value: unknown): Json[] => Array.isArray(value) ? value.map(object) : []
const text = (value: unknown) => {
  if (typeof value !== "string" || value.trim().length === 0) return undefined
  // oxlint-disable-next-line no-control-regex -- Reject transcript controls before display.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    throw new ConversationSourceError("Conversation text contains unsupported control characters.")
  }
  return value
}

const blockText = (value: unknown, accepted: ReadonlyArray<string>) => {
  if (typeof value === "string") return text(value)
  const parts = blocks(value).filter((part) => accepted.includes(String(part.type)))
    .map((part) => text(part.text)).filter((part) => part !== undefined)
  return parts.length === 0 ? undefined : parts.join("\n")
}

const nested = (entry: Json, payload: Json) =>
  entry.isSidechain === true || entry.is_sidechain === true ||
  [entry.agentId, entry.agent_id, entry.parentToolCallId, payload.agentId,
    payload.agent_id, payload.parentToolCallId, payload.parent_tool_call_id,
    entry.subagentId, entry.subagent_id, payload.subagentId, payload.subagent_id].some(
    (value) => identifier(value) !== undefined,
  )

const internal = (entry: Json, payload: Json) =>
  entry.isMeta === true || entry.isSynthetic === true || payload.isSynthetic === true ||
  ["system", "developer", "tool", "agent", "internal", "synthetic"].includes(
    String(payload.source ?? entry.source ?? payload.origin ?? entry.origin),
  )

const loneSurrogates = /[\ud800-\udfff]/u
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (key: string, item: unknown) => {
  if (loneSurrogates.test(key) || (typeof item === "string" && loneSurrogates.test(item))) {
    throw new ConversationSourceError("Conversation identities or event data contain invalid Unicode.")
  }
  return item
})).digest("hex")

interface Candidate extends ConversationMessage {
  readonly completed: boolean
}

class TranscriptHistory {
  readonly entries = new Map<string, Candidate>()
  readonly notices = new Set<string>()
  readonly seen = new Map<string, string>()
  missingHistory = false
  pending: Candidate | undefined
  presentation: { candidate: Candidate; summary: boolean } | undefined
  readonly agent: Agent
  readonly sessionId: string
  readonly cwd: string

  constructor(agent: Agent, sessionId: string, cwd: string) {
    this.agent = agent
    this.sessionId = sessionId
    this.cwd = cwd
  }

  evidence(role: Role, reference: ConversationRecord, messageId?: string): string {
    return `msg-${digest([this.agent, this.sessionId, role, messageId ?? `record:${reference.recordIndex}`])}`
  }

  candidate(role: Role, content: string, reference: ConversationRecord, messageId?: string): Candidate {
    return {
      id: this.evidence(role, reference, messageId),
      role,
      text: content,
      recordIndex: reference.recordIndex,
      completed: false,
    }
  }

  unique(reference: ConversationRecord, payload: Json): boolean {
    const entry = reference.value
    const id = identifier(entry.uuid) ?? identifier(entry.id) ?? identifier(entry.eventId)
    if (id === undefined) return true
    const key = `${String(entry.type)}:${String(payload.type ?? "")}:${id}`
    const fingerprint = digest(entry)
    const previous = this.seen.get(key)
    if (previous !== undefined && previous !== fingerprint) {
      throw new ConversationSourceError("A transcript event ID was reused with different content.")
    }
    this.seen.set(key, fingerprint)
    return previous === undefined
  }

  checkIdentity(sessionId: unknown, cwd?: unknown) {
    if (sessionId !== undefined && sessionId !== this.sessionId) {
      throw new ConversationSourceError("The transcript contains a different main session identity.")
    }
    if (cwd !== undefined && (typeof cwd !== "string" || !path.isAbsolute(cwd) ||
      path.resolve(cwd) !== path.resolve(this.cwd))) {
      throw new ConversationSourceError("The transcript working directory does not match the focused source.")
    }
  }

  omitHistory(message: string) {
    this.missingHistory = true
    this.notices.add(message)
  }

  attachments(payload: Json) {
    if ([payload.attachments, payload.images, payload.local_images].some(
      (value) => Array.isArray(value) && value.length > 0,
    ) || blocks(payload.content).some((part) => ["image", "input_image", "image_url"].includes(String(part.type)))) {
      this.omitHistory("Attachment contents are not included in this text snapshot.")
    }
  }

  newTurn() {
    this.pending = undefined
    this.presentation = undefined
  }

  user(candidate: Candidate) {
    const previous = this.entries.get(candidate.id)
    if (previous !== undefined) {
      if (previous.text !== candidate.text) {
        throw new ConversationSourceError("A human message identity has conflicting text.")
      }
      return
    }
    this.newTurn()
    this.entries.set(candidate.id, candidate)
  }

  assistant(candidate: Candidate, completed: boolean, summary = false) {
    if (!completed) {
      this.pending = candidate
      return
    }
    if (summary && this.presentation !== undefined) return
    if (!summary && this.presentation?.summary) {
      this.entries.delete(this.presentation.candidate.id)
    }
    const committed = { ...candidate, completed: true }
    const previous = this.entries.get(committed.id)
    if (previous !== undefined && previous.text !== committed.text) {
      throw new ConversationSourceError("A conversation message identity has conflicting completed text.")
    }
    if (previous === undefined) this.entries.set(committed.id, committed)
    this.pending = undefined
    this.presentation = { candidate: previous ?? committed, summary }
  }

  complete() {
    if (this.pending !== undefined && this.presentation === undefined) {
      this.assistant(this.pending, true)
    }
    this.pending = undefined
  }
}

const eventMessageId = (entry: Json, payload: Json) =>
  identifier(payload.messageId) ?? identifier(payload.message_id) ??
  identifier(payload.id) ?? identifier(entry.uuid) ?? identifier(entry.id)

const compaction = (history: TranscriptHistory, entry: Json, payload: Json) => {
  if (["compacted", "summary", "session.compaction_complete", "session.compaction.completed",
    "compact_boundary"].includes(String(entry.type)) ||
    entry.isCompactSummary === true || payload.type === "context_compacted" ||
    entry.subtype === "compact_boundary") {
    history.omitHistory("Harness compaction was recorded; earlier source history may be unavailable.")
    return true
  }
  return false
}

const copilotAssistant = (history: TranscriptHistory, reference: ConversationRecord, data: Json) => {
  const entry = reference.value
  const requests = data.toolRequests ?? entry.toolRequests
  const phase = data.phase ?? entry.phase
  if ((phase !== undefined && phase !== null && !["final_answer", "final"].includes(String(phase))) ||
    (Array.isArray(requests) && requests.length > 0)) {
    history.pending = undefined
    return
  }
  const content = text(data.content ?? entry.content)
  if (content !== undefined) {
    history.assistant(
      history.candidate(ConversationRole.Assistant, content, reference, eventMessageId(entry, data)),
      phase === "final_answer" || phase === "final",
    )
  }
}

const parseCopilotRecord = (history: TranscriptHistory, reference: ConversationRecord) => {
  const entry = reference.value
  const data = object(entry.data)
  if (nested(entry, data)) return
  history.checkIdentity(entry.sessionId ?? data.sessionId)
  if (!history.unique(reference, data) || compaction(history, entry, data)) return
  if (entry.type === "session.start") {
    history.checkIdentity(data.sessionId ?? data.session_id)
    return
  }
  if (entry.type === "user.message" && !internal(entry, data)) {
    history.attachments(data)
    const content = text(data.content ?? entry.content)
    if (content !== undefined) {
      history.user(history.candidate(ConversationRole.User, content, reference, eventMessageId(entry, data)))
    }
    return
  }
  if (entry.type === "assistant.turn_start") {
    history.newTurn()
    return
  }
  if (entry.type === "assistant.message") {
    copilotAssistant(history, reference, data)
    return
  }
  parseCopilotCompletion(history, reference, data)
}

const parseCopilotCompletion = (history: TranscriptHistory, reference: ConversationRecord, data: Json) => {
  const entry = reference.value
  if (entry.type === "session.task_complete") {
    const content = text(data.summary ?? entry.summary)
    if (content !== undefined) {
      history.assistant(
        history.candidate(ConversationRole.Assistant, content, reference, eventMessageId(entry, data)), true, true,
      )
    } else history.complete()
  } else if (["assistant.turn_end", "session.idle"].includes(String(entry.type))) {
    history.complete()
  } else if (["tool.execution_start", "tool.executionStart"].includes(String(entry.type))) {
    history.pending = undefined
  }
}

const codexHumanResponse = (payload: Json) => {
  const metadata = object(payload.internal_chat_message_metadata_passthrough)
  return Array.isArray(metadata.content_item_kinds) &&
    metadata.content_item_kinds.includes("user.text")
}

const codexHumanText = (payload: Json) => {
  const kinds = object(payload.internal_chat_message_metadata_passthrough).content_item_kinds as unknown[]
  if (kinds.every((kind) => kind === "user.text")) return blockText(payload.content, ["input_text", "text"])
  if (!Array.isArray(payload.content) || kinds.length !== payload.content.length) {
    throw new ConversationSourceError("Codex human input cannot be separated from injected instruction blocks.")
  }
  return blockText(payload.content.filter((_part, index) => kinds[index] === "user.text"), ["input_text", "text"])
}

const parseCodexMessage = (
  history: TranscriptHistory, reference: ConversationRecord, payload: Json,
) => {
  if (payload.role === "user") {
    if (!codexHumanResponse(payload) || internal(reference.value, payload)) return
    history.attachments(payload)
    const content = codexHumanText(payload)
    if (content !== undefined) {
      history.user(history.candidate(ConversationRole.User, content, reference, eventMessageId(reference.value, payload)))
    }
    return
  }
  if (payload.role !== "assistant" ||
    (payload.phase !== undefined && payload.phase !== null && payload.phase !== "final_answer") ||
    ["commentary", "analysis", "reasoning"].includes(String(payload.channel)) ||
    (payload.recipient !== undefined && payload.recipient !== "all")) return
  const content = blockText(payload.content, ["output_text", "text"])
  if (content !== undefined) {
    history.assistant(
      history.candidate(ConversationRole.Assistant, content, reference, eventMessageId(reference.value, payload)),
      payload.phase === "final_answer" || payload.channel === "final",
    )
  }
}

const completeCodexTask = (history: TranscriptHistory, reference: ConversationRecord, payload: Json) => {
  if (history.pending === undefined && history.presentation === undefined) {
    const content = text(payload.last_agent_message)
    if (content !== undefined) {
      history.pending = history.candidate(
        ConversationRole.Assistant, content, reference, eventMessageId(reference.value, payload),
      )
    }
  }
  history.complete()
}

const parseCodexEvent = (
  history: TranscriptHistory, reference: ConversationRecord, payload: Json,
) => {
  if (payload.type === "task_started") {
    history.newTurn()
  } else if (payload.type === "user_message" && !internal(reference.value, payload)) {
    history.attachments(payload)
    const content = text(payload.message)
    if (content !== undefined) {
      history.user(history.candidate(ConversationRole.User, content, reference, eventMessageId(reference.value, payload)))
    }
  } else if (payload.type === "agent_message" && !["commentary", "analysis", "reasoning"].includes(String(payload.phase))) {
    const content = text(payload.message)
    if (content !== undefined && history.presentation === undefined) {
      history.assistant(
        history.candidate(ConversationRole.Assistant, content, reference, eventMessageId(reference.value, payload)), false,
      )
    }
  } else if (payload.type === "task_complete") {
    completeCodexTask(history, reference, payload)
  }
}

const parseCodexRecord = (
  history: TranscriptHistory, reference: ConversationRecord,
) => {
  const entry = reference.value
  const payload = object(entry.payload)
  if (nested(entry, payload)) return
  if (entry.type === "session_meta") {
    if (object(payload.source).subagent !== undefined) {
      throw new ConversationSourceError("Nested Codex sessions cannot be analyzed as the focused main conversation.")
    }
    history.checkIdentity(payload.id ?? payload.session_id, payload.cwd)
    return
  }
  history.checkIdentity(payload.session_id)
  if (!history.unique(reference, payload) || compaction(history, entry, payload)) return
  if (entry.type === "response_item" && payload.type === "message") {
    parseCodexMessage(history, reference, payload)
  } else if (entry.type === "event_msg") {
    parseCodexEvent(history, reference, payload)
  } else if (entry.type === "response_item" &&
    ["function_call", "custom_tool_call", "web_search_call"].includes(String(payload.type))) {
    history.pending = undefined
  }
}

interface ClaudeMessage {
  readonly id: string
  readonly parts: Map<string, string>
  reference: ConversationRecord
  completed: boolean
  toolUse: boolean
}

// oxlint-disable-next-line no-control-regex -- Match Python whitespace without normalizing IDs.
const blankClaudeMessageId = /^[\p{White_Space}\u001c-\u001f\ufeff]*$/u

const claudeAssistant = (messages: Map<string, ClaudeMessage>, reference: ConversationRecord, message: Json) => {
  const id = identifier(message.id)
  if (id === undefined || blankClaudeMessageId.test(id)) {
    throw new ConversationSourceError("A Claude assistant message has no stable message ID.")
  }
  const current = messages.get(id) ?? {
    id, parts: new Map<string, string>(), reference, completed: false, toolUse: false,
  }
  blocks(message.content).forEach((part, index) => {
    if (part.type === "tool_use") current.toolUse = true
    if (part.type !== "text") return
    const content = text(part.text)
    if (content === undefined) return
    const key = identifier(part.id) ?? (Number.isSafeInteger(part.index)
      ? `block:${part.index}` : `record:${reference.recordIndex}:block:${index}`)
    const previous = current.parts.get(key)
    if (previous !== undefined && previous !== content) {
      throw new ConversationSourceError("A Claude text block identity has conflicting content.")
    }
    current.parts.set(key, content)
  })
  current.completed = message.stop_reason === "end_turn"
  current.reference = reference
  messages.set(id, current)
}

const claudeUser = (history: TranscriptHistory, reference: ConversationRecord, message: Json) => {
  if (internal(reference.value, message) ||
    blocks(message.content).some((part) => part.type === "tool_result")) return
  history.attachments(message)
  const content = blockText(message.content, ["text", "input_text"])
  if (content !== undefined) {
    history.user(history.candidate(
      ConversationRole.User, content, reference, identifier(reference.value.uuid) ?? identifier(message.id),
    ))
  }
}

const parseClaudeRecord = (history, assistants, reference: ConversationRecord) => {
  const entry = reference.value
  const message = object(entry.message)
  if (nested(entry, message)) return
  history.checkIdentity(entry.sessionId, entry.cwd)
  if (!history.unique(reference, message) || compaction(history, entry, message)) return
  if (internal(entry, message)) return
  if (entry.type === "assistant") claudeAssistant(assistants, reference, message)
  if (entry.type === "user") claudeUser(history, reference, message)
}

const parseClaude = (history: TranscriptHistory, records: ReadonlyArray<ConversationRecord>) => {
  const assistants = new Map<string, ClaudeMessage>()
  for (const reference of records) {
    parseClaudeRecord(history, assistants, reference)
  }
  for (const message of assistants.values()) {
    if (message.parts.size === 0 || message.toolUse) continue
    const candidate = {
      ...history.candidate(
        ConversationRole.Assistant, [...message.parts.values()].join("\n"), message.reference, message.id,
      ),
      completed: message.completed,
    }
    history.entries.set(candidate.id, candidate)
  }
}

const finishHistory = (history: TranscriptHistory, policy: ConversationCapturePolicy) => {
  const activity = [...history.entries.values(), ...(history.pending === undefined ? [] : [history.pending])]
    .sort((left, right) => left.recordIndex - right.recordIndex)
  const complete = activity.filter((entry) => entry.role === ConversationRole.Assistant && entry.completed)
  const last = complete.at(-1)
  if (last === undefined) {
    throw new ConversationSourceError("The focused conversation has no unambiguous completed assistant response yet.")
  }
  const messages = activity.filter((entry) => entry.recordIndex <= last.recordIndex &&
    (entry.role === ConversationRole.User || entry.completed)).map(({ completed: _completed, ...entry }) => entry)
  if (activity.some((entry) => Buffer.byteLength(entry.text) > policy.maximumMessageBytes)) {
    throw new ConversationSourceError("A conversation message exceeds the configured message byte limit.")
  }
  if (messages.length > policy.maximumMessages ||
    activity.reduce((size, entry) => size + Buffer.byteLength(entry.text), 0) > policy.maximumTextBytes) {
    throw new ConversationSourceError("The full filtered conversation exceeds the configured capture budget.")
  }
  if (messages[0]?.role !== ConversationRole.User) {
    history.omitHistory("The source starts without a human request; earlier conversation history may be unavailable.")
  }
  if (activity.some((entry) => entry.recordIndex > last.recordIndex)) {
    history.notices.add("Newer user-visible activity is excluded after the last completed assistant response.")
  }
  return {
    messages,
    cutoff: { messageId: last.id, recordIndex: last.recordIndex },
    revision: digest({
      activity: activity.filter((entry) => entry.role === ConversationRole.User || entry.completed),
      missingHistory: history.missingHistory,
    }),
    coverage: { complete: !history.missingHistory, notices: [...history.notices] },
  }
}

export const parseConversationRecords = (
  agent: Agent,
  records: ReadonlyArray<ConversationRecord>,
  { sessionId, cwd, policy = conversationCapturePolicy }: {
    readonly sessionId: string
    readonly cwd: string
    readonly policy?: ConversationCapturePolicy
  },
) => {
  const history = new TranscriptHistory(agent, sessionId, cwd)
  if (agent === ConversationAgent.Claude) {
    parseClaude(history, records)
  } else if (agent === ConversationAgent.Copilot) {
    records.forEach((reference) => parseCopilotRecord(history, reference))
  } else if (agent === ConversationAgent.Codex) {
    records.forEach((reference) => parseCodexRecord(history, reference))
  } else {
    throw new ConversationSourceError("The focused harness does not support conversation analysis.")
  }
  return finishHistory(history, policy)
}
