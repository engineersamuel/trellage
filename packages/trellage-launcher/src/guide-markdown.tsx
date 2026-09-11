import React, { useEffect, useState } from "react"
import { Box, Text, useInput } from "ink"
import stringWidth from "string-width"

const guideTextSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" })

const wrapGuideTextLine = (sourceLine: string, lineWidth: number): ReadonlyArray<string> => {
  if (sourceLine.length === 0) return [""]
  const lines: Array<string> = []
  let line = ""
  let displayWidth = 0
  let continuation = false
  for (const { segment } of guideTextSegmenter.segment(sourceLine)) {
    const segmentWidth = stringWidth(segment)
    if (line.length > 0 && displayWidth + segmentWidth > lineWidth) {
      lines.push(line)
      line = ""
      displayWidth = 0
      continuation = true
    }
    if (continuation && line.length === 0 && segment === " ") continue
    line += segment
    displayWidth += segmentWidth
    continuation = false
  }
  if (line.length > 0) lines.push(line)
  return lines
}

export const wrapGuideText = (value: string, width: number): ReadonlyArray<string> => {
  const lineWidth = Math.max(1, width)
  return value
    .replaceAll("\t", "    ")
    .split("\n")
    .flatMap((sourceLine) => wrapGuideTextLine(sourceLine, lineWidth))
}

type MarkdownDisplayKind = "body" | "heading" | "list" | "quote" | "code" | "rule"
type MarkdownInlineKind = "text" | "bold" | "italic" | "code" | "strikethrough" | "link"

export interface MarkdownInlineSegment {
  readonly text: string
  readonly kind: MarkdownInlineKind
}

interface MarkdownWrappedLine {
  readonly text: string
  readonly segments?: ReadonlyArray<MarkdownInlineSegment>
}

export interface MarkdownDisplayLine extends MarkdownWrappedLine {
  readonly kind: MarkdownDisplayKind
}

const markdownInlineTokenPattern =
  /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|\[[^\]\n]+\]\([^\s)\n]+\))/u

interface MarkdownInlineSourcePart {
  readonly value: string
  readonly token: boolean
}

const markdownInlineSourceParts = (value: string): ReadonlyArray<MarkdownInlineSourcePart> => {
  const parts: Array<MarkdownInlineSourcePart> = []
  let remaining = value
  while (remaining.length > 0) {
    const match = markdownInlineTokenPattern.exec(remaining)
    if (match?.index === undefined || match[0] === undefined) {
      parts.push({ value: remaining, token: false })
      break
    }
    if (match.index > 0) parts.push({ value: remaining.slice(0, match.index), token: false })
    parts.push({ value: match[0], token: true })
    remaining = remaining.slice(match.index + match[0].length)
  }
  return parts
}

export const markdownInlineSegments = (value: string): ReadonlyArray<MarkdownInlineSegment> => {
  const segments: Array<MarkdownInlineSegment> = []
  for (const part of markdownInlineSourceParts(value)) {
    if (!part.token) {
      segments.push({ text: part.value, kind: "text" })
      continue
    }
    const matched = part.value
    if (matched.startsWith("`")) segments.push({ text: matched.slice(1, -1), kind: "code" })
    else if (matched.startsWith("**") || matched.startsWith("__")) {
      segments.push({ text: matched.slice(2, -2), kind: "bold" })
    } else if (matched.startsWith("~~")) {
      segments.push({ text: matched.slice(2, -2), kind: "strikethrough" })
    } else if (matched.startsWith("[")) {
      const labelEnd = matched.indexOf("](")
      segments.push({
        text: `${matched.slice(1, labelEnd)} (${matched.slice(labelEnd + 2, -1)})`,
        kind: "link",
      })
    } else {
      segments.push({ text: matched.slice(1, -1), kind: "italic" })
    }
  }
  return segments
}

interface MarkdownWrapState {
  segments: Array<MarkdownInlineSegment>
  displayWidth: number
}

const pushMarkdownWrapLine = (lines: Array<MarkdownWrappedLine>, state: MarkdownWrapState): void => {
  const text = state.segments.map((segment) => segment.text).join("")
  const styled = state.segments.some((segment) => segment.kind !== "text")
  lines.push(styled ? { text, segments: state.segments } : { text })
  state.segments = []
  state.displayWidth = 0
}

const appendMarkdownSegment = (state: MarkdownWrapState, kind: MarkdownInlineKind, text: string): void => {
  const last = state.segments.at(-1)
  if (last?.kind === kind) state.segments[state.segments.length - 1] = { kind, text: last.text + text }
  else state.segments.push({ kind, text })
  state.displayWidth += stringWidth(text)
}

const wrapMarkdownSegment = (
  lines: Array<MarkdownWrappedLine>,
  state: MarkdownWrapState,
  { text, kind }: MarkdownInlineSegment,
  lineWidth: number,
): void => {
  if (kind !== "text" && state.segments.length > 0 && state.displayWidth + stringWidth(text) > lineWidth) {
    pushMarkdownWrapLine(lines, state)
  }
  for (const { segment } of guideTextSegmenter.segment(text)) {
    if (state.segments.length > 0 && state.displayWidth + stringWidth(segment) > lineWidth) {
      pushMarkdownWrapLine(lines, state)
    }
    if (kind === "text" && lines.length > 0 && state.segments.length === 0 && segment === " ") continue
    appendMarkdownSegment(state, kind, segment)
  }
}

const wrapMarkdownTextLine = (sourceLine: string, lineWidth: number): ReadonlyArray<MarkdownWrappedLine> => {
  if (sourceLine.length === 0) return [{ text: "" }]
  const lines: Array<MarkdownWrappedLine> = []
  const state: MarkdownWrapState = { segments: [], displayWidth: 0 }
  // Parse before wrapping so a long command or link keeps its text and style on every line.
  for (const segment of markdownInlineSegments(sourceLine)) {
    wrapMarkdownSegment(lines, state, segment, lineWidth)
  }
  if (state.segments.length > 0) pushMarkdownWrapLine(lines, state)
  return lines
}

const classifyMarkdownListLine = (source: string): string | undefined => {
  const taskItem = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/u.exec(source)
  if (taskItem?.[1] !== undefined && taskItem[2] !== undefined) {
    return `${taskItem[1] === " " ? "☐" : "☒"} ${taskItem[2]}`
  }
  const unorderedItem = /^(\s*)[-*+](?:\s+(.*))?$/u.exec(source)
  if (unorderedItem !== null) return `${unorderedItem[1] ?? ""}•${unorderedItem[2] ? ` ${unorderedItem[2]}` : ""}`
  const orderedItem = /^(\s*)(\d+[.)])\s+(.+)$/u.exec(source)
  if (orderedItem?.[3] !== undefined) return `${orderedItem[1] ?? ""}${orderedItem[2]} ${orderedItem[3]}`
  return undefined
}

const classifyMarkdownLine = (
  source: string,
  inCode: boolean,
  sectionHeadings?: ReadonlySet<string>,
): { readonly text: string; readonly kind: MarkdownDisplayKind; readonly inCode: boolean } => {
  if (/^\s*```/u.test(source)) return { text: source.trim(), kind: "code", inCode: !inCode }
  if (inCode) return { text: source, kind: "code", inCode }
  const heading = /^\s*#{1,6}\s+(.+)$/u.exec(source)
  if (heading?.[1] !== undefined) return { text: heading[1], kind: "heading", inCode }
  if (sectionHeadings?.has(source)) return { text: source, kind: "heading", inCode }
  const listLine = classifyMarkdownListLine(source)
  if (listLine !== undefined) return { text: listLine, kind: "list", inCode }
  const quote = /^\s*>\s?(.*)$/u.exec(source)
  if (quote?.[1] !== undefined) return { text: `│ ${quote[1]}`, kind: "quote", inCode }
  if (/^\s*(?:---+|\*\*\*+|___+)\s*$/u.test(source)) return { text: "─".repeat(24), kind: "rule", inCode }
  return { text: source, kind: "body", inCode }
}

export const markdownPromptLines = (
  value: string,
  width: number,
  sectionHeadings?: ReadonlySet<string>,
): ReadonlyArray<MarkdownDisplayLine> => {
  const lines: Array<MarkdownDisplayLine> = []
  let inCode = false
  for (const source of value.replace(/\r\n?/gu, "\n").replaceAll("\t", "    ").split("\n")) {
    const classified = classifyMarkdownLine(source, inCode, sectionHeadings)
    inCode = classified.inCode
    const previous = lines.at(-1)
    if (classified.kind === "heading" && previous !== undefined && previous.text.length > 0) {
      lines.push({ text: "", kind: "body" })
    }
    const wrapped =
      classified.kind === "code"
        ? wrapGuideTextLine(classified.text, Math.max(1, width)).map((text) => ({ text }))
        : wrapMarkdownTextLine(classified.text, Math.max(1, width))
    for (const line of wrapped) {
      if (line.text.length > 0 || lines.at(-1)?.text.length !== 0) lines.push({ ...line, kind: classified.kind })
    }
    if (classified.kind === "heading") lines.push({ text: "", kind: "body" })
  }
  return lines
}

const MarkdownInline = ({ segments }: { readonly segments: ReadonlyArray<MarkdownInlineSegment> }) => (
  <>
    {segments.map((segment, index) => {
      const key = `${index}:${segment.kind}:${segment.text}`
      switch (segment.kind) {
        case "bold":
          return (
            <Text key={key} bold>
              {segment.text}
            </Text>
          )
        case "italic":
          return (
            <Text key={key} italic>
              {segment.text}
            </Text>
          )
        case "code":
          return (
            <Text key={key} color="yellow">
              {segment.text}
            </Text>
          )
        case "strikethrough":
          return (
            <Text key={key} strikethrough>
              {segment.text}
            </Text>
          )
        case "link":
          return (
            <Text key={key} color="blue" underline>
              {segment.text}
            </Text>
          )
        case "text":
          return segment.text
      }
    })}
  </>
)

export const MarkdownLine = ({ line }: { readonly line: MarkdownDisplayLine }) => {
  if (line.text.length === 0) return <Text> </Text>
  const content = <MarkdownInline segments={line.segments ?? [{ text: line.text, kind: "text" }]} />
  switch (line.kind) {
    case "heading":
      return <Text bold color="cyan" wrap="truncate-end">{content}</Text>
    case "list":
      return <Text color="green" wrap="truncate-end">{content}</Text>
    case "quote":
      return <Text italic dimColor wrap="truncate-end">{content}</Text>
    case "code":
      return <Text color="yellow" wrap="truncate-end">{line.text}</Text>
    case "rule":
      return <Text dimColor>{line.text}</Text>
    case "body":
      return <Text wrap="truncate-end">{content}</Text>
  }
}

export const MarkdownTextViewport = ({
  value,
  width,
  height,
  resetKey,
  startLine: controlledStartLine,
  onStartLineChange,
}: {
  readonly value: string
  readonly width: number
  readonly height: number
  readonly resetKey?: string
  readonly startLine?: number
  readonly onStartLineChange?: (startLine: number) => void
}) => {
  const [requestedStartLine, setRequestedStartLine] = useState(0)
  const lines = markdownPromptLines(value, width)
  const viewportHeight = Math.max(1, height)
  const maximumStartLine = Math.max(0, lines.length - viewportHeight)
  const startLine = Math.min(maximumStartLine, Math.max(0, controlledStartLine ?? requestedStartLine))
  const pageSize = Math.max(1, viewportHeight - 1)
  useEffect(() => {
    setRequestedStartLine(0)
  }, [resetKey])
  useInput((_input, key) => {
    if (key.pageUp) {
      const next = Math.max(0, startLine - pageSize)
      setRequestedStartLine(next)
      onStartLineChange?.(next)
    } else if (key.pageDown) {
      const next = Math.min(maximumStartLine, startLine + pageSize)
      setRequestedStartLine(next)
      onStartLineChange?.(next)
    }
  })
  return (
    <Box flexDirection="column" height={viewportHeight} overflowY="hidden">
      {lines.slice(startLine, startLine + viewportHeight).map((line, index) => (
        <MarkdownLine key={`${startLine + index}:${line.kind}:${line.text}`} line={line} />
      ))}
    </Box>
  )
}
