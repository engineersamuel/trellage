const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

const meaningfulText = (value) => (typeof value === "string" && value.trim().length > 0 ? value : undefined)
const identifierText = (value) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined

const recordsFromJsonl = (source) => {
  const records = []
  for (const line of source.split("\n")) {
    if (line.trim().length === 0) continue
    try {
      const value = JSON.parse(line)
      if (isRecord(value)) records.push(value)
    } catch {
      // A bounded tail can begin with one partial JSONL record.
    }
  }
  return records
}

export type ConversationRole = "user" | "assistant"

export interface ConversationMessage {
  readonly role: ConversationRole
  readonly text: string
}

const appendConversationMessage = (messages, message) => {
  if (message === undefined) return
  const previous = messages.at(-1)
  if (previous?.role === message.role && previous.text === message.text) return
  messages.push(message)
}

const messageBlockText = (content, acceptedTypes) => {
  if (typeof content === "string") return meaningfulText(content)
  if (!Array.isArray(content)) return undefined
  const parts = content
    .filter(isRecord)
    .filter((part) => acceptedTypes.has(part.type))
    .map((part) => meaningfulText(part.text))
    .filter((part) => part !== undefined)
  return parts.length === 0 ? undefined : parts.join("\n")
}

const copilotConversationMessage = (event) => {
  const data = isRecord(event.data) ? event.data : undefined
  if (isNestedCopilotEvent(event, data)) return undefined
  if (event.type === "user.message") {
    const text = meaningfulText(data?.content) ?? meaningfulText(event.content)
    return text === undefined ? undefined : { role: "user", text }
  }
  if (event.type !== "assistant.message") return undefined
  const toolRequests = data?.toolRequests ?? event.toolRequests
  if (Array.isArray(toolRequests) && toolRequests.length > 0) return undefined
  const text = meaningfulText(data?.content) ?? meaningfulText(event.content)
  return text === undefined ? undefined : { role: "assistant", text }
}

export const extractCopilotConversation = (source) => {
  const messages = []
  for (const event of recordsFromJsonl(source)) {
    appendConversationMessage(messages, copilotConversationMessage(event))
  }
  return messages
}

const isNestedCopilotEvent = (event, data) =>
  identifierText(event.agentId) !== undefined || identifierText(data?.parentToolCallId) !== undefined

const copilotTaskCompletion = (event, data) =>
  event.type === "session.task_complete" && !isNestedCopilotEvent(event, data)
    ? (meaningfulText(data?.summary) ?? meaningfulText(event.summary))
    : undefined

const copilotAssistantMessage = (event, data) => {
  if (event.type !== "assistant.message" || isNestedCopilotEvent(event, data)) return undefined
  const content = meaningfulText(data?.content) ?? meaningfulText(event.content)
  if (content === undefined) return undefined
  const final = data?.phase === "final_answer" || event.phase === "final_answer"
  return { content, final }
}

export const extractCopilotFinalMessage = (source) => {
  let latest
  for (const event of recordsFromJsonl(source)) {
    const data = isRecord(event.data) ? event.data : undefined
    const taskCompletion = copilotTaskCompletion(event, data)
    if (taskCompletion !== undefined) {
      latest = taskCompletion
      continue
    }
    const assistantMessage = copilotAssistantMessage(event, data)
    if (assistantMessage === undefined) continue
    latest = assistantMessage.content
  }
  return latest
}

const codexMessageText = (payload) => {
  if (!isRecord(payload) || !Array.isArray(payload.content)) return undefined
  const parts = payload.content
    .filter(isRecord)
    .filter((part) => part.type === "output_text" || part.type === "text")
    .map((part) => meaningfulText(part.text))
    .filter((part) => part !== undefined)
  return parts.length === 0 ? undefined : parts.join("\n")
}

const codexUserText = (payload) => {
  const metadata = isRecord(payload.internal_chat_message_metadata_passthrough)
    ? payload.internal_chat_message_metadata_passthrough
    : undefined
  const kinds = Array.isArray(metadata?.content_item_kinds) ? metadata.content_item_kinds : []
  if (!kinds.includes("user.text")) return undefined
  return messageBlockText(payload.content, new Set(["input_text", "text"]))
}

const codexConversationMessage = (entry) => {
  const payload = isRecord(entry.payload) ? entry.payload : undefined
  if (entry.type !== "response_item" || payload?.type !== "message") return undefined
  if (payload.role === "user") {
    const text = codexUserText(payload)
    return text === undefined ? undefined : { role: "user", text }
  }
  if (payload.role !== "assistant" || payload.phase === "commentary") return undefined
  const text = codexMessageText(payload)
  return text === undefined ? undefined : { role: "assistant", text }
}

export const extractCodexConversation = (source) => {
  const messages = []
  for (const entry of recordsFromJsonl(source)) {
    appendConversationMessage(messages, codexConversationMessage(entry))
  }
  return messages
}

const codexResponseMessage = (entry) => {
  const payload = isRecord(entry.payload) ? entry.payload : undefined
  if (entry.type !== "response_item" || payload?.type !== "message" || payload.role !== "assistant") return undefined
  const text = codexMessageText(payload)
  return text === undefined ? undefined : { text, final: payload.phase === "final_answer" }
}

const codexEventMessage = (entry) => {
  const payload = isRecord(entry.payload) ? entry.payload : undefined
  return entry.type === "event_msg" && payload?.type === "agent_message"
    ? meaningfulText(payload.message)
    : undefined
}

export const extractCodexFinalMessage = (source) => {
  let latest
  let index = 0
  for (const entry of recordsFromJsonl(source)) {
    index += 1
    const response = codexResponseMessage(entry)
    if (response !== undefined) latest = { text: response.text, index }
    const event = codexEventMessage(entry)
    if (event !== undefined) latest = { text: event, index }
  }
  return latest?.text
}

const appendClaudeRecord = (messages, entry, index) => {
  if (entry.type !== "assistant" || !isRecord(entry.message)) return
  const messageId = identifierText(entry.message.id)
  if (messageId === undefined) return
  const current = messages.get(messageId) ?? {
    texts: [],
    textSet: new Set(),
    endTurn: false,
    lastIndex: index,
  }
  const content = Array.isArray(entry.message.content) ? entry.message.content : []
  for (const part of content) {
    if (!isRecord(part) || part.type !== "text") continue
    const text = meaningfulText(part.text)
    if (text === undefined || current.textSet.has(text)) continue
    current.textSet.add(text)
    current.texts.push(text)
  }
  if (entry.message.stop_reason === "end_turn") current.endTurn = true
  current.lastIndex = index
  messages.set(messageId, current)
}

const claudeUserMessage = (entry, index) => {
  if (entry.type !== "user" || !isRecord(entry.message)) return undefined
  const text = messageBlockText(entry.message.content, new Set(["text", "input_text"]))
  return text === undefined ? undefined : { role: "user", text, index }
}

export const extractClaudeConversation = (source) => {
  const assistantMessages = new Map()
  const messages = []
  let index = 0
  for (const entry of recordsFromJsonl(source)) {
    index += 1
    const user = claudeUserMessage(entry, index)
    if (user !== undefined) messages.push(user)
    appendClaudeRecord(assistantMessages, entry, index)
  }
  for (const message of assistantMessages.values()) {
    if (message.endTurn && message.texts.length > 0) {
      messages.push({ role: "assistant", text: message.texts.join("\n"), index: message.lastIndex })
    }
  }
  return messages
    .sort((left, right) => left.index - right.index)
    .map(({ role, text }) => ({ role, text }))
}

export const extractClaudeFinalMessage = (source) => {
  const messages = new Map()
  let index = 0
  for (const entry of recordsFromJsonl(source)) {
    index += 1
    appendClaudeRecord(messages, entry, index)
  }
  return [...messages.values()]
    .filter((message) => message.endTurn && message.texts.length > 0)
    .sort((left, right) => right.lastIndex - left.lastIndex)[0]
    ?.texts.join("\n")
}

export const extractTranscriptFinalMessage = (agent, source) => {
  if (agent === "copilot") return extractCopilotFinalMessage(source)
  if (agent === "codex") return extractCodexFinalMessage(source)
  if (agent === "claude") return extractClaudeFinalMessage(source)
  return undefined
}

export const extractTranscriptConversation = (agent, source) => {
  if (agent === "copilot") return extractCopilotConversation(source)
  if (agent === "codex") return extractCodexConversation(source)
  if (agent === "claude") return extractClaudeConversation(source)
  return []
}

export const copilotWorkspaceCwd = (source) => {
  const line = source.split("\n").find((candidate) => candidate.startsWith("cwd: "))
  if (line === undefined) return undefined
  const value = line.slice(5).trim()
  if (
    value.length >= 2 &&
    ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))
  ) {
    return value.slice(1, -1)
  }
  return value || undefined
}

export const codexSessionMetadata = (source) => {
  for (const entry of recordsFromJsonl(source)) {
    if (entry.type !== "session_meta" || !isRecord(entry.payload)) continue
    const id = identifierText(entry.payload.id) ?? identifierText(entry.payload.session_id)
    const cwd = identifierText(entry.payload.cwd)
    if (id !== undefined && cwd !== undefined) return { id, cwd }
  }
  if (!/"type"\s*:\s*"session_meta"/u.test(source)) return undefined
  const stringField = (name) => {
    const match = source.match(new RegExp(`"${name}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, "u"))
    if (match?.[1] === undefined) return undefined
    try {
      return identifierText(JSON.parse(match[1]))
    } catch {
      return undefined
    }
  }
  const id = stringField("id") ?? stringField("session_id")
  const cwd = stringField("cwd")
  return id === undefined || cwd === undefined ? undefined : { id, cwd }
}

export const claudeSessionMetadata = (source) => {
  for (const entry of recordsFromJsonl(source)) {
    const id = identifierText(entry.sessionId)
    const cwd = identifierText(entry.cwd)
    if (id !== undefined && cwd !== undefined) return { id, cwd }
  }
  return undefined
}
