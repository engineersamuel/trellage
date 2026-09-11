import React from "react"
import { Box, Text, useInput, usePaste, useWindowSize, type Key } from "ink"
import stringWidth from "string-width"

import {
  guideGoalAnswerMaximumLength,
  recommendedGuideGoalAnswer,
  validateGuideGoalAnswer,
  type GuideGoalRequest,
  type GuideGoalResponse,
} from "./guide-goal-augment.js"
import { MarkdownLine, markdownPromptLines, type MarkdownDisplayLine } from "./guide-markdown.js"

type PanelView = "choices" | "answer" | "review" | "feedback"

export interface GuideGoalPanelState {
  readonly request: GuideGoalRequest
  readonly view: PanelView
  readonly choiceIndex: number
  readonly reviewIndex: number
  readonly draft: string
  readonly contentScroll: number | "selection"
  readonly editorScroll: number | "end"
  readonly discardScroll: number
  readonly discardOpen: boolean
  readonly discardIndex: number
  readonly error: string | null
}

export type GuideGoalPanelAction =
  | { readonly type: "move"; readonly delta: -1 | 1 }
  | { readonly type: "edit" }
  | { readonly type: "back" }
  | { readonly type: "append"; readonly text: string }
  | { readonly type: "paste"; readonly text: string }
  | { readonly type: "backspace" }
  | { readonly type: "scroll"; readonly offset: number }
  | { readonly type: "confirm-discard" }
  | { readonly type: "error"; readonly message: string }

const isEditor = (state: GuideGoalPanelState): boolean =>
  !state.discardOpen && (state.view === "answer" || state.view === "feedback")

const choiceLabels = (request: GuideGoalRequest): ReadonlyArray<string> =>
  request.kind === "question"
    ? [...request.question.choices, ...(request.question.allowFreeform ? ["Type your own"] : [])]
    : []

export const createGuideGoalPanelState = (request: GuideGoalRequest): GuideGoalPanelState => ({
  request,
  view: request.kind === "review" ? "review" : request.question.choices.length > 0 ? "choices" : "answer",
  choiceIndex: 0,
  reviewIndex: 0,
  draft: "",
  contentScroll: 0,
  editorScroll: request.kind === "question" && request.question.choices.length === 0 ? 0 : "end",
  discardScroll: 0,
  discardOpen: false,
  discardIndex: 0,
  error: null,
})

const characterCount = (value: string): number => [...value].length
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" })
const invalidControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u

const withError = (state: GuideGoalPanelState, message: string): GuideGoalPanelState => ({
  ...state,
  error: message,
  ...(state.discardOpen ? { discardScroll: 0 } : isEditor(state) ? { editorScroll: 0 } : { contentScroll: 0 }),
})

const appendText = (state: GuideGoalPanelState, text: string): GuideGoalPanelState => {
  if (!isEditor(state)) return state
  const normalized = text.replace(/\r\n?/gu, "\n")
  if (invalidControls.test(normalized)) {
    return withError(state, "Text contains unsupported control characters. Nothing was added.")
  }
  if (characterCount(state.draft) + characterCount(normalized) > guideGoalAnswerMaximumLength) {
    return withError(state, "Text exceeds 8,000 characters. Nothing was added. Shorten the text and try again.")
  }
  return normalized.length === 0
    ? state
    : { ...state, draft: state.draft + normalized, editorScroll: "end", error: null }
}

const moveSelection = (state: GuideGoalPanelState, delta: -1 | 1): GuideGoalPanelState => {
  if (state.discardOpen) return { ...state, discardIndex: (state.discardIndex + delta + 2) % 2 }
  if (state.view === "review") return { ...state, reviewIndex: (state.reviewIndex + delta + 3) % 3, error: null }
  if (state.view !== "choices") return state
  const count = choiceLabels(state.request).length
  return count === 0 ? state : {
    ...state,
    choiceIndex: (state.choiceIndex + delta + count) % count,
    contentScroll: "selection",
    error: null,
  }
}

const leaveEditor = (state: GuideGoalPanelState): GuideGoalPanelState => {
  if (state.discardOpen) return { ...state, discardOpen: false }
  if (state.view === "feedback") return { ...state, view: "review", error: null }
  if (state.view === "answer" && state.request.kind === "question" && state.request.question.choices.length > 0) {
    return { ...state, view: "choices", error: null }
  }
  return state
}

const openEditor = (state: GuideGoalPanelState): GuideGoalPanelState => {
  if (state.discardOpen) return state
  if (state.request.kind === "review") return { ...state, view: "feedback", error: null }
  if (!state.request.question.allowFreeform) {
    return withError(state, "Choose one of the supplied answers. This question does not allow a typed answer.")
  }
  return { ...state, view: "answer", error: null }
}

const removeCharacter = (state: GuideGoalPanelState): GuideGoalPanelState => {
  if (!isEditor(state) || state.draft.length === 0) return state
  const last = [...graphemes.segment(state.draft)].at(-1)
  return { ...state, draft: state.draft.slice(0, last?.index ?? 0), editorScroll: "end", error: null }
}

const scrollPanel = (state: GuideGoalPanelState, requestedOffset: number): GuideGoalPanelState => {
  if (!Number.isFinite(requestedOffset)) return state
  const offset = Math.max(0, Math.floor(requestedOffset))
  if (state.discardOpen) return { ...state, discardScroll: offset }
  return isEditor(state) ? { ...state, editorScroll: offset } : { ...state, contentScroll: offset }
}

export const guideGoalPanelReducer = (
  state: GuideGoalPanelState,
  action: GuideGoalPanelAction,
): GuideGoalPanelState => {
  switch (action.type) {
    case "error":
      return withError(state, action.message)
    case "confirm-discard":
      return { ...state, discardOpen: true, discardIndex: 0, discardScroll: 0 }
    case "back":
      return leaveEditor(state)
    case "move":
      return moveSelection(state, action.delta)
    case "edit":
      return openEditor(state)
    case "append":
    case "paste":
      return appendText(state, action.text)
    case "backspace":
      return removeCharacter(state)
    case "scroll":
      return scrollPanel(state, action.offset)
  }
}

interface DisplayLine {
  readonly text: string
  readonly markdown?: MarkdownDisplayLine
  readonly selected?: boolean
  readonly error?: boolean
  readonly cursor?: boolean
}

const goalSectionHeadings = new Set([
  "TASK:",
  "SUCCESS CRITERIA (be strict):",
  "SCOREBOARD (overwrite this block after every VERIFY; do not append):",
  "LEARNINGS (at most 8 bullets; replace stale ones; no narrative):",
  "LOOP PROTOCOL, repeat every turn:",
  "RULES:",
])

const wrapText = (text: string, width: number): ReadonlyArray<string> =>
  text
    .replace(/\r\n?/gu, "\n")
    .replaceAll("\t", "    ")
    .split("\n")
    .flatMap((source) => {
      const lines: string[] = []
      let line = ""
      let length = 0
      for (const { segment } of graphemes.segment(source)) {
        const size = stringWidth(segment)
        if (line.length > 0 && length + size > width) {
          lines.push(line)
          line = ""
          length = 0
        }
        line += segment
        length += size
      }
      lines.push(line)
      return lines
    })

const editorLines = (state: GuideGoalPanelState, width: number): ReadonlyArray<DisplayLine> => {
  const label = state.view === "feedback" ? "Revision feedback:" : "Your answer:"
  const lines: DisplayLine[] = [
    { text: "" },
    ...wrapText(label, width).map((text) => ({ text })),
    ...wrapText(state.draft, width).map((text) => ({ text })),
  ]
  const last = lines.at(-1)
  if (last !== undefined && stringWidth(last.text) < width) {
    lines[lines.length - 1] = { ...last, cursor: true }
  } else {
    lines.push({ text: "", cursor: true })
  }
  return lines
}

const optionLines = (label: string, selected: boolean, width: number): ReadonlyArray<DisplayLine> =>
  wrapText(label, Math.max(1, width - 2)).map((text, lineIndex) => ({
    text: `${selected && lineIndex === 0 ? "❯ " : "  "}${text}`,
    selected,
  }))

const questionChoices = (
  state: GuideGoalPanelState,
  width: number,
): { readonly lines: ReadonlyArray<DisplayLine>; readonly selectedLine: number } => {
  const lines: DisplayLine[] = [{ text: "" }]
  let selectedLine = 0
  for (const [index, label] of choiceLabels(state.request).entries()) {
    const selected = index === state.choiceIndex
    if (selected) selectedLine = lines.length
    lines.push(...optionLines(label, selected, width))
  }
  return { lines, selectedLine }
}

const documentLines = (
  state: GuideGoalPanelState,
  width: number,
  autoAcceptRecommended: boolean,
): { readonly lines: ReadonlyArray<DisplayLine>; readonly selectedLine: number } => {
  const lines: DisplayLine[] = []
  if (state.error !== null) {
    lines.push(...wrapText(`Error: ${state.error}`, width).map((text) => ({ text, error: true })), { text: "" })
  }
  if (state.discardOpen) {
    lines.push(...wrapText(
      "Discard this interview?\nThis discards its answers and goal draft.\nThe original prompt stays unchanged.\nKeep interview returns to your saved draft.",
      width,
    ).map((text) => ({ text })))
    return { lines, selectedLine: 0 }
  }
  if (state.request.kind === "question") {
    lines.push(...wrapText(state.request.question.question, width).map((text) => ({ text })))
    if (autoAcceptRecommended && recommendedGuideGoalAnswer(state.request.question) === undefined) {
      lines.push({ text: "" }, ...wrapText(
        "Automatic answers on. This question has no single recommended choice; answer it manually.",
        width,
      ).map((text) => ({ text })))
    }
  } else {
    lines.push(...markdownPromptLines(state.request.proposal.prompt, width, goalSectionHeadings)
      .map((markdown) => ({ text: markdown.text, markdown })))
  }
  if (isEditor(state)) {
    lines.push(...editorLines(state, width))
    return { lines, selectedLine: 0 }
  }
  if (state.view === "choices") {
    const choices = questionChoices(state, width)
    return { lines: [...lines, ...choices.lines], selectedLine: lines.length + choices.selectedLine }
  }
  return { lines, selectedLine: 0 }
}

const reviewLabels = ["Use goal", "Revise", "Cancel"] as const
const discardLabels = ["Keep interview", "Discard interview"] as const

const actionLines = (labels: ReadonlyArray<string>, index: number, width: number): ReadonlyArray<DisplayLine> => {
  const joined = labels.map((label, item) => `${item === index ? "❯ " : "  "}${label}`).join("   ")
  return stringWidth(joined) <= width
    ? [{ text: joined, selected: true }]
    : labels.flatMap((label, item) =>
      wrapText(`${item === index ? "❯ " : "  "}${label}`, width).map((text) => ({ text, selected: item === index })),
    )
}

const panelActions = (state: GuideGoalPanelState, width: number): ReadonlyArray<DisplayLine> => {
  if (state.discardOpen) return actionLines(discardLabels, state.discardIndex, width)
  if (state.view === "review") return actionLines(reviewLabels, state.reviewIndex, width)
  if (isEditor(state)) {
    return [{ text: `${state.view === "feedback" ? "Feedback" : "Answer"} · ${characterCount(state.draft)}/8,000 characters` }]
  }
  const labels = choiceLabels(state.request)
  const label = labels[state.choiceIndex]?.replace(/\s+/gu, " ") ?? "No allowed answer"
  return [{ text: `❯ ${state.choiceIndex + 1}/${labels.length} ${label}`, selected: true }]
}

const editorBackLabel = (state: GuideGoalPanelState): string | null => {
  if (state.view === "feedback") return "review"
  return state.request.kind === "question" && state.request.question.choices.length > 0 ? "choices" : null
}

const editorHelp = (state: GuideGoalPanelState, compact: boolean): string => {
  const back = editorBackLabel(state)
  const backHint = back === null ? "" : compact ? "^B back · " : `Ctrl+B ${back} · `
  return [
    compact ? "Enter send · Alt/Shift+Enter newline" : "Enter submit · Alt/Shift+Enter newline",
    `${backHint}${compact ? "^X" : "Ctrl+X"} discard · Esc park`,
  ].join("\n")
}

export const goalAutoAcceptHelp = (enabled: boolean, compact = false): string =>
  enabled
    ? compact ? "a stop auto answers" : "a stop automatic answers"
    : compact ? "a accept recommended" : "a accept all recommended answers"

const canToggleAutomaticAnswers = (state: GuideGoalPanelState, enabled: boolean): boolean =>
  !state.discardOpen && (state.view === "choices" || (state.view === "review" && enabled))

const panelHelp = (state: GuideGoalPanelState, compact: boolean, autoAcceptRecommended: boolean): string => {
  if (state.discardOpen) return "↑/↓ select · Enter confirm\nCtrl+B keep interview · Esc park"
  if (isEditor(state)) return editorHelp(state, compact)
  return [
    `↑/↓ select · Enter ${state.view === "review" ? "confirm" : "answer"}`,
    ...(canToggleAutomaticAnswers(state, autoAcceptRecommended) ? [goalAutoAcceptHelp(autoAcceptRecommended, compact)] : []),
    "Ctrl+X discard · Esc park",
  ].join("\n")
}

const panelLayout = (state: GuideGoalPanelState, rows: number, columns: number, autoAcceptRecommended: boolean) => {
  const padding = columns > 3 ? 1 : 0
  const width = Math.max(1, columns - padding * 2)
  const height = Math.max(1, rows - 1)
  const actions = panelActions(state, width)
  const fullHelp = panelHelp(state, false, autoAcceptRecommended)
  let help = wrapText(fullHelp, width)
  const errorRows = state.error === null ? 0 : 1
  if (fullHelp.split("\n").some((line) => stringWidth(line) > width) ||
    height - actions.length - help.length - errorRows - 2 < 1) {
    help = wrapText(panelHelp(state, true, autoAcceptRecommended), width)
  }
  const showPosition = height - actions.length - help.length - errorRows - 2 >= 1
  const showHeading = height - actions.length - help.length - errorRows - Number(showPosition) - 1 >= 1
  const bodyHeight = Math.max(1, height - actions.length - help.length - errorRows - Number(showPosition) - Number(showHeading))
  const document = documentLines(state, width, autoAcceptRecommended)
  const maximumStart = Math.max(0, document.lines.length - bodyHeight)
  const scroll = state.discardOpen ? state.discardScroll : isEditor(state) ? state.editorScroll : state.contentScroll
  const requestedStart = scroll === "selection" ? document.selectedLine : scroll === "end" ? maximumStart : scroll
  const start = Math.max(0, Math.min(requestedStart, maximumStart))
  return {
    padding,
    width,
    actions,
    help,
    showPosition,
    showHeading,
    bodyHeight,
    maximumStart,
    start,
    lineCount: document.lines.length,
    lines: document.lines.slice(start, start + bodyHeight),
  }
}

const responseForPanel = (state: GuideGoalPanelState): GuideGoalResponse => {
  if (state.request.kind === "question") {
    const answer = state.view === "answer"
      ? { answer: state.draft, wasFreeform: true }
      : { answer: state.request.question.choices[state.choiceIndex] ?? "", wasFreeform: false }
    if (answer.answer.trim().length === 0) throw new Error("Enter an answer before you submit.")
    return { kind: "answer", answer: validateGuideGoalAnswer(state.request.question, answer) }
  }
  if (state.view === "feedback") {
    if (state.draft.trim().length === 0) throw new Error("Enter revision feedback before you submit.")
    validateGuideGoalAnswer(
      { question: "Revision feedback", choices: [], allowFreeform: true },
      { answer: state.draft, wasFreeform: true },
    )
    return { kind: "review", review: { decision: "revise", feedback: state.draft } }
  }
  if (state.view === "review" && state.reviewIndex === 0) return { kind: "review", review: { decision: "use" } }
  throw new Error("Select Use goal to approve, or Revise to give feedback.")
}

interface GuideGoalPanelProps {
  readonly state: GuideGoalPanelState
  readonly autoAcceptRecommended: boolean
  readonly onSetAutoAcceptRecommended: (enabled: boolean) => void
  readonly onAction: (action: GuideGoalPanelAction) => void
  readonly onSubmit: (response: GuideGoalResponse) => void
  readonly onPark: () => void
  readonly onDiscard: () => void
  /** Available stage dimensions after the parent subtracts persistent chrome. */
  readonly rows?: number
  readonly columns?: number
}

const handlePanelShortcut = (props: GuideGoalPanelProps, input: string, key: Key): boolean => {
  if (key.escape && !key.meta) {
    props.onPark()
    return true
  }
  if (!key.ctrl) return false
  if (input.toLowerCase() === "x") {
    props.onAction({ type: "confirm-discard" })
    return true
  }
  if (input.toLowerCase() === "b") {
    props.onAction({ type: "back" })
    return true
  }
  return false
}

const scrollOffset = (key: Key, layout: ReturnType<typeof panelLayout>): number => {
  if (key.home) return 0
  if (key.end) return layout.maximumStart
  const page = Math.max(1, layout.bodyHeight - 1)
  if (key.pageUp) return layout.start - page
  if (key.pageDown) return layout.start + page
  return layout.start + (key.upArrow ? -1 : 1)
}

const handlePanelScroll = (
  props: GuideGoalPanelProps,
  layout: ReturnType<typeof panelLayout>,
  key: Key,
): boolean => {
  const editorArrow = isEditor(props.state) && (key.upArrow || key.downArrow)
  if (!key.pageUp && !key.pageDown && !key.home && !key.end && !editorArrow) return false
  const offset = Math.max(0, Math.min(layout.maximumStart, scrollOffset(key, layout)))
  props.onAction({ type: "scroll", offset })
  return true
}

const selectsEditor = (state: GuideGoalPanelState): boolean => {
  if (state.view === "review") return state.reviewIndex === 1
  return state.view === "choices" && state.request.kind === "question" &&
    state.choiceIndex === state.request.question.choices.length
}

const submitPanel = ({ state, onAction, onSubmit, onDiscard }: GuideGoalPanelProps): void => {
  if (state.discardOpen) {
    if (state.discardIndex === 1) onDiscard()
    else onAction({ type: "back" })
  } else if (selectsEditor(state)) {
    onAction({ type: "edit" })
  } else if (state.view === "review" && state.reviewIndex === 2) {
    onAction({ type: "confirm-discard" })
  } else {
    try {
      onSubmit(responseForPanel(state))
    } catch (error) {
      onAction({ type: "error", message: error instanceof Error ? error.message : "Could not submit. Try again or press Esc to park." })
    }
  }
}

const handleEditorKey = ({ onAction }: GuideGoalPanelProps, input: string, key: Key): void => {
  if (key.backspace || key.delete) onAction({ type: "backspace" })
  else if (input.length > 0 && !key.tab) onAction({ type: "append", text: input })
}

const handleSelectionKey = ({ onAction }: GuideGoalPanelProps, key: Key): void => {
  if (key.upArrow || key.leftArrow) onAction({ type: "move", delta: -1 })
  else if (key.downArrow || key.rightArrow) onAction({ type: "move", delta: 1 })
}

const isParentInput = (input: string, key: Key): boolean =>
  key.eventType === "release" || (key.ctrl && input.toLowerCase() === "c") || input === "\u0003"

const isModifiedInput = (key: Key): boolean => key.ctrl || key.meta || key.super || key.hyper

const handlePanelInput = (
  props: GuideGoalPanelProps,
  layout: ReturnType<typeof panelLayout>,
  input: string,
  key: Key,
): void => {
  if (isParentInput(input, key) || handlePanelShortcut(props, input, key) || handlePanelScroll(props, layout, key)) return
  const submit = key.return || input === "\r" || input === "\n"
  if (isEditor(props.state) && submit && (key.shift || key.meta)) {
    props.onAction({ type: "append", text: "\n" })
    return
  }
  if (isModifiedInput(key)) return
  if (input === "a" && canToggleAutomaticAnswers(props.state, props.autoAcceptRecommended)) {
    props.onSetAutoAcceptRecommended(!props.autoAcceptRecommended)
    return
  }
  if (submit) submitPanel(props)
  else if (isEditor(props.state)) handleEditorKey(props, input, key)
  else handleSelectionKey(props, key)
}

const panelHeading = (state: GuideGoalPanelState): string => {
  if (state.discardOpen) return "Goal me · Discard interview?"
  switch (state.view) {
    case "choices": return "Goal me · Question"
    case "answer": return "Goal me · Type your answer"
    case "review": return "Goal me · Review goal"
    case "feedback": return "Goal me · Revise goal"
  }
}

export const GuideGoalPanel = (props: GuideGoalPanelProps) => {
  const terminal = useWindowSize()
  const { state, onAction } = props
  const layout = panelLayout(state, props.rows ?? terminal.rows, props.columns ?? terminal.columns, props.autoAcceptRecommended)
  useInput((input, key) => handlePanelInput(props, layout, input, key))
  usePaste((text) => onAction({ type: "paste", text }))

  return (
    <Box flexDirection="column" paddingX={layout.padding}>
      {layout.showHeading ? <Text bold color="cyan" wrap="truncate-end">{panelHeading(state)}</Text> : null}
      <Box flexDirection="column" height={layout.bodyHeight} overflowY="hidden">
        {layout.lines.map((line, index) => line.markdown === undefined ? (
          <Text key={index} bold={line.selected === true} {...(line.error ? { color: "red" } : line.selected ? { color: "green" } : {})} wrap="truncate-end">
            {line.text}{line.cursor ? <Text color="yellow">█</Text> : null}
          </Text>
        ) : (
          <MarkdownLine key={index} line={line.markdown} />
        ))}
      </Box>
      {layout.showPosition ? (
        <Text dimColor wrap="truncate-end">
          {layout.start + 1}–{Math.min(layout.lineCount, layout.start + layout.bodyHeight)}/{layout.lineCount} · PgUp/PgDn scroll
        </Text>
      ) : null}
      {state.error === null ? null : <Text color="red" wrap="truncate-end">Error: {state.error}</Text>}
      {layout.actions.map((line, index) => (
        <Text key={index} bold={line.selected === true} {...(line.selected ? { color: "green" } : {})} wrap="truncate-end">{line.text}</Text>
      ))}
      {layout.help.map((line, index) => <Text key={index} dimColor wrap="truncate-end">{line}</Text>)}
    </Box>
  )
}
