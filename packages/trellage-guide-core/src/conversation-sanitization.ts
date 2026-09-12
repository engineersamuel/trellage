import type { ConversationSnapshot } from "./conversation.ts"

export interface ConversationTextSanitization {
  readonly text: string
  readonly credentialsRedacted: boolean
  readonly controlsRemoved: boolean
}

const CSI = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/gu
const OSC = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|$)/gu
const UNSUPPORTED_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu
const TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{24,})\b/gu
const PRIVATE_KEY = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----|-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*$/gu
const ASSIGNED_DOUBLE_QUOTED = /["']?\b(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\b["']?\s*(?:[:=]\s*)"((?:\\[\s\S]|[^"\\\r\n]){12,})"/giu
const ASSIGNED_SINGLE_QUOTED = /["']?\b(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\b["']?\s*(?:[:=]\s*)'((?:\\[\s\S]|[^'\\\r\n]){12,})'/giu
const ASSIGNED_UNQUOTED = /["']?\b(?:api[_-]?key|access[_-]?token|password|client[_-]?secret)\b["']?\s*(?:[:=]\s*)(?!["'])([^\s,;}\]"']{12,})/giu

const CREDENTIAL_NOTICE = "Conversation credentials were redacted."
const CONTROL_NOTICE = "Terminal control sequences were removed."

type Span = readonly [start: number, end: number, replacement: string]

const stripControls = (text: string): { text: string; removed: boolean } => {
  const withoutSequences = text.replace(CSI, "").replace(OSC, "")
  const cleaned = withoutSequences.replace(UNSUPPORTED_CONTROLS, "")
  return { text: cleaned, removed: cleaned !== text }
}

const normalizedProjection = (text: string): { text: string; sourceStart?: number[]; sourceEnd?: number[] } => {
  if (text.normalize("NFKC") === text) return { text }
  let projection = ""
  const sourceStart: number[] = []
  const sourceEnd: number[] = []
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index)!
    const sourceEndIndex = index + (codePoint > 0xffff ? 2 : 1)
    const normalized = String.fromCodePoint(codePoint).normalize("NFKC")
    projection += normalized
    for (let offset = 0; offset < normalized.length; offset += 1) {
      sourceStart.push(index)
      sourceEnd.push(sourceEndIndex)
    }
    index = sourceEndIndex
  }
  return { text: projection, sourceStart, sourceEnd }
}

const redact = (text: string): { text: string; redacted: boolean } => {
  const projection = normalizedProjection(text)
  const spans: Span[] = []
  const addMatches = (pattern: RegExp, replacement: string, valueCapture = 0): void => {
    pattern.lastIndex = 0
    for (const match of projection.text.matchAll(pattern)) {
      const value = valueCapture > 0 ? match[valueCapture] : match[0]
      if (value === undefined) continue
      const valueOffset = valueCapture > 0 ? match[0].lastIndexOf(value) : 0
      const normalizedStart = match.index! + valueOffset
      const normalizedEnd = normalizedStart + value.length
      const start = projection.sourceStart?.[normalizedStart] ?? normalizedStart
      const end = projection.sourceEnd?.[normalizedEnd - 1] ?? normalizedEnd
      if (start !== undefined && end !== undefined) spans.push([start, end, replacement])
    }
  }
  addMatches(PRIVATE_KEY, "[REDACTED private key]")
  addMatches(TOKEN, "[REDACTED credential]")
  addMatches(ASSIGNED_DOUBLE_QUOTED, "[REDACTED credential]", 1)
  addMatches(ASSIGNED_SINGLE_QUOTED, "[REDACTED credential]", 1)
  addMatches(ASSIGNED_UNQUOTED, "[REDACTED credential]", 1)
  spans.sort(([left], [right]) => left - right)
  const merged: Span[] = []
  for (const span of spans) {
    const previous = merged.at(-1)
    if (previous !== undefined && span[0] < previous[1]) {
      merged[merged.length - 1] = [previous[0], Math.max(previous[1], span[1]), previous[2]]
    } else {
      merged.push(span)
    }
  }
  const parts: string[] = []
  let offset = 0
  for (const [start, end, replacement] of merged) {
    parts.push(text.slice(offset, start), replacement)
    offset = end
  }
  parts.push(text.slice(offset))
  return { text: parts.join(""), redacted: merged.length > 0 }
}

export const sanitizeConversationText = (text: string): ConversationTextSanitization => {
  const controls = stripControls(text)
  const credentials = redact(controls.text)
  return { text: credentials.text, credentialsRedacted: credentials.redacted, controlsRemoved: controls.removed }
}

export const sanitizeConversationSnapshot = (snapshot: ConversationSnapshot): ConversationSnapshot => {
  let credentialsRedacted = false
  let controlsRemoved = false
  const messages = snapshot.messages.map((message) => {
    const sanitized = sanitizeConversationText(message.text)
    credentialsRedacted ||= sanitized.credentialsRedacted
    controlsRemoved ||= sanitized.controlsRemoved
    return sanitized.text === message.text ? message : { ...message, text: sanitized.text }
  })
  if (!credentialsRedacted && !controlsRemoved) return snapshot
  const notices = [...snapshot.coverage.notices]
  for (const notice of [credentialsRedacted ? CREDENTIAL_NOTICE : undefined, controlsRemoved ? CONTROL_NOTICE : undefined]) {
    if (notice !== undefined && !notices.includes(notice)) notices.push(notice)
  }
  return {
    ...snapshot,
    messages,
    coverage: { complete: false, notices },
  }
}
