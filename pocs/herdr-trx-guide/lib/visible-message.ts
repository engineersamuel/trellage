export type VisibleMessageRole = "harness" | "system"

export interface VisiblePaneMessage {
  readonly paneId: string
  readonly role: VisibleMessageRole
  readonly text: string
  readonly capturedAt: string
  readonly source: "visible"
}

export interface VisiblePaneSnapshot {
  readonly paneId: string
  readonly agent?: string
  readonly text: string
  readonly capturedAt?: string
  readonly truncated?: boolean
}

export class VisibleMessageSelectionError extends Error {
  readonly code: "missing" | "ambiguous" | "truncated"

  constructor(code: "missing" | "ambiguous" | "truncated", message: string) {
    super(message)
    this.name = "VisibleMessageSelectionError"
    this.code = code
  }
}

const ansi = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/gu
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu
const messageMarker = /^\s*(?:●|•|⏺)\s+(.*)$/u
const explicitMarker = /^ {0,1}(assistant|harness|system)\s*:\s*(.*)$/iu
const toolMarker = /^(?:Interacted with\s|Explored \d+ (?:files?|searches?|lists?)\b)/u
const claudeToolMarker = /^(?:Bash|Read|Edit|Write|Grep|Glob|Task|WebFetch|WebSearch|NotebookEdit)\s*\(/iu
const userMarker = /^\s*[›❯]\s*/u
const transcriptPlaceholder = /^\s*…\s*\+\d+ lines?\b/iu
const statusMarker = /^(?:Working|Thinking|Waiting|Compacting|Running)\b.*(?:esc to interrupt|ctrl \+ t|\b\d{1,2}:\d{2}\b)/iu
const claudeStatus = /^(?:✻|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏)\s*(?:Churning|Working|Thinking|Compacting)\b/iu
const codexStatus = /^\d{1,3}%\s+context\s+left\b.*(?:shortcuts|esc)/iu

const normalizeText = (value: string): string => value
  .replace(ansi, "")
  .replace(/\r\n?/gu, "\n")
  .replace(controls, "")

const isChrome = (line: string): boolean => {
  const value = line.trim()
  return value.length === 0 ||
    transcriptPlaceholder.test(value) ||
    /\(ctrl \+ t to view transcript\)$/iu.test(value) ||
    /^(?:gpt-[\w.-]+|claude(?: code)?|copilot)\b.*(?:·|model|mode)/iu.test(value) ||
    /^(?:[╭╰│─]{2,}|╭─|╰─)$/u.test(value) ||
    claudeStatus.test(value) ||
    codexStatus.test(value) ||
    userMarker.test(value)
}

const visibleLine = (line: string): string => {
  return line.replace(/^└\s?/u, "").replace(/^│\s?/u, "").trimEnd()
}

const markerGlyph = (line: string): string | undefined => line.match(/^\s*(●|•|⏺)\s+/u)?.[1]

const isHarnessMarker = (line: string, agent: string | undefined): boolean => {
  const glyph = markerGlyph(line)
  if (glyph === undefined) return false
  const normalized = agent?.toLowerCase()
  if (normalized?.includes("claude")) return glyph === "⏺"
  if (normalized?.includes("copilot")) return glyph === "●"
  if (normalized?.includes("codex")) return glyph === "•"
  return true
}

interface Segment {
  readonly role: VisibleMessageRole
  readonly lines: string[]
  readonly margin: number
}

const flushSegment = (segments: Segment[], current: Segment | undefined): Segment | undefined => {
  if (current !== undefined && current.lines.some((line) => line.trim().length > 0)) segments.push(current)
  return undefined
}

const segmentText = (segment: Segment): string => {
  let fence: { marker: string; width: number; indentation: number } | undefined
  return segment.lines.map((raw, index) => {
    const line = index > 0 && raw.startsWith(" ".repeat(segment.margin)) ? raw.slice(segment.margin) : raw
    const opening = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/u)
    if (fence !== undefined) {
      const result = line.replace(new RegExp(`^ {0,${fence.indentation}}`, "u"), "")
      if (opening !== null && opening[2]![0] === fence.marker && opening[2]!.length >= fence.width && opening[3]!.trim() === "") fence = undefined
      return result
    }
    if (opening !== null) {
      fence = { marker: opening[2]![0]!, width: opening[2]!.length, indentation: opening[1]!.length }
      return line.slice(fence.indentation)
    }
    return line
  }).join("\n").trim()
}

const segmentVisibleText = (snapshot: VisiblePaneSnapshot): Segment[] => {
  const segments: Segment[] = []
  let current: Segment | undefined
  let ignoredTool = false
  let ignoredUser = false
  let fence: { marker: string; width: number } | undefined
  let userSeparator = false
  const lines = normalizeText(snapshot.text).split("\n")
  for (const [lineIndex, rawLine] of lines.entries()) {
    if (current !== undefined && !ignoredTool && !ignoredUser) {
      const content = rawLine.startsWith(" ".repeat(current.margin)) ? rawLine.slice(current.margin) : rawLine
      const delimiter = content.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u)
      if (fence !== undefined) {
        current.lines.push(visibleLine(rawLine))
        if (delimiter !== null && delimiter[1]![0] === fence.marker && delimiter[1]!.length >= fence.width && delimiter[2]!.trim() === "") fence = undefined
        continue
      }
      if (delimiter !== null) {
        fence = { marker: delimiter[1]![0]!, width: delimiter[1]!.length }
        current.lines.push(visibleLine(rawLine))
        continue
      }
    }
    if (userMarker.test(rawLine)) {
      current = flushSegment(segments, current)
      ignoredTool = false
      ignoredUser = true
      userSeparator = false
      continue
    }
    const explicit = rawLine.match(explicitMarker)
    if (explicit !== null) {
      // Tool output can contain prose such as "assistant:" or "system:".
      // Once a tool marker has opened a block, treat those lines as output
      // until the next real harness marker.
      if (ignoredTool || ignoredUser) continue
      current = flushSegment(segments, current)
      ignoredTool = false
      current = {
        role: explicit[1]!.toLowerCase() === "system" ? "system" : "harness",
        margin: 0,
        lines: explicit[2]!.trim().length === 0 ? [] : [explicit[2]!],
      }
      continue
    }
    const marked = rawLine.match(messageMarker)
    if (marked !== null) {
      const value = marked[1]!.trim()
      if (statusMarker.test(value)) {
        current = flushSegment(segments, current)
        ignoredTool = false
        ignoredUser = false
        continue
      }
      if (!isHarnessMarker(rawLine, snapshot.agent)) {
        if (!ignoredTool && !ignoredUser && current !== undefined) current.lines.push(visibleLine(rawLine))
        continue
      }
      // Indented bullets are Markdown content, not a new harness turn.
      const indentation = rawLine.length - rawLine.trimStart().length
      if (indentation > 1) {
        if (!ignoredTool && !ignoredUser && current !== undefined) current.lines.push(visibleLine(rawLine))
        continue
      }
      if (ignoredUser && !userSeparator) {
        throw new VisibleMessageSelectionError("ambiguous", "The visible message boundary overlaps user input; scroll to the answer and try again.")
      }
      current = flushSegment(segments, current)
      const nextContent = lines.slice(lineIndex + 1).find((line) => line.trim().length > 0) ?? ""
      ignoredTool = toolMarker.test(value) || claudeToolMarker.test(value) || (/^Ran\s/u.test(value) && /^\s*[└│]/u.test(nextContent))
      ignoredUser = false
      current = ignoredTool ? undefined : { role: "harness", margin: indentation + 2, lines: value.length === 0 ? [] : [value] }
      const delimiter = value.match(/^(`{3,}|~{3,})/u)
      fence = !ignoredTool && delimiter !== null ? { marker: delimiter[1]![0]!, width: delimiter[1]!.length } : undefined
      continue
    }
    if (ignoredUser || ignoredTool) {
      if (ignoredUser && rawLine.trim().length === 0) userSeparator = true
      continue
    }
    if (rawLine.trim().length === 0) {
      if (current !== undefined) current.lines.push("")
      continue
    }
    if (isChrome(rawLine)) {
      // Blank lines separate paragraphs, not messages. Other chrome (prompt
      // lines, transcript placeholders, and model labels) ends the current
      // visible turn.
      if (rawLine.trim().length > 0) current = flushSegment(segments, current)
      ignoredTool = false
      continue
    }
    if (current !== undefined) {
      current.lines.push(rawLine.trim().length === 0 ? "" : visibleLine(rawLine))
    }
  }
  flushSegment(segments, current)
  return segments
}

export const selectLatestVisibleMessage = (snapshot: VisiblePaneSnapshot): VisiblePaneMessage => {
  if (snapshot.truncated === true) {
    throw new VisibleMessageSelectionError("truncated", "The active pane's visible output is truncated.")
  }
  if (typeof snapshot.paneId !== "string" || snapshot.paneId.length === 0) {
    throw new VisibleMessageSelectionError("missing", "The active Herdr pane is unavailable.")
  }
  const segments = segmentVisibleText(snapshot)
  const candidates = segments
    .map((segment) => ({ ...segment, text: segmentText(segment) }))
    .filter((segment) => segment.text.length > 0)
  if (candidates.length === 0) {
    const lines = normalizeText(snapshot.text).split("\n")
    const hasBoundary = lines.some((line) => messageMarker.test(line) || explicitMarker.test(line) || userMarker.test(line))
    const ambiguous = !hasBoundary && lines.some((line) => !isChrome(line))
    throw new VisibleMessageSelectionError(
      ambiguous ? "ambiguous" : "missing",
      ambiguous
        ? "The active pane viewport starts inside a message; scroll to its beginning and try again."
        : "No visible harness or system message is available in the active pane.",
    )
  }
  const latest = candidates.at(-1)!
  return {
    paneId: snapshot.paneId,
    role: latest.role,
    text: latest.text,
    capturedAt: snapshot.capturedAt ?? new Date().toISOString(),
    source: "visible",
  }
}
