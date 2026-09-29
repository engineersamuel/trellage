import React from "react"
import { Box, Text, useInput, usePaste, type Key } from "ink"
import {
  customerFieldMaximum,
  customerQuestions,
  customerUnknown,
  renderCustomerContext,
  reviewedCustomerContext,
  type GuideCustomerPanelAction,
  type GuideCustomerPanelState,
} from "./guide-customer-context.ts"
import { MarkdownTextViewport } from "./guide-markdown.tsx"

const customerEditorAction = (input: string, key: Key): GuideCustomerPanelAction | undefined => {
  if (key.ctrl && input === "b") return { type: "previous" }
  if (key.return) return { type: "next" }
  if (key.backspace || key.delete) return { type: "backspace" }
  if (key.ctrl || key.meta || key.super || key.hyper || !input) return undefined
  return { type: "append", text: input }
}

export const GuideCustomerPanel = ({
  state,
  source,
  rows,
  columns,
  onAction,
  onApprove,
  onDiscard,
  onPark,
}: {
  readonly state: GuideCustomerPanelState
  readonly source: string
  readonly rows: number
  readonly columns: number
  readonly onAction: (action: GuideCustomerPanelAction) => void
  readonly onApprove: () => void
  readonly onDiscard: () => void
  readonly onPark: () => void
}) => {
  usePaste((value) => {
    if (!state.reviewing) onAction({ type: "append", text: value })
  })
  useInput((input, key) => {
    if (key.escape) return onPark()
    if (key.ctrl && input === "c") return
    if (state.reviewing) {
      if (input === "a") onApprove()
      else if (input === "e") onAction({ type: "edit" })
      else if (input === "x") onDiscard()
      return
    }
    const action = customerEditorAction(input, key)
    if (action !== undefined) onAction(action)
  })
  const question = customerQuestions[state.index]
  const title = state.reviewing ? "Review customer context" : (question?.title ?? "Customer context")
  const content = state.reviewing
    ? `## Current request\n\n${source}\n\n${renderCustomerContext(reviewedCustomerContext(state))}`
    : `${question?.question ?? ""}\n\n### Your answer\n\n${state.draft || customerUnknown}`
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      <Text>
        {state.reviewing
          ? "Apply only sanitized content that you may share with Guide models, its local cache, and the selected agent."
          : `Local preparation only. No model or file access. Answer ${state.index + 1} of ${customerQuestions.length}.`}
      </Text>
      {state.error === undefined ? null : <Text color="red">{state.error}</Text>}
      <MarkdownTextViewport
        value={content}
        width={Math.max(1, columns - 2)}
        height={Math.max(1, rows - 10)}
        resetKey={`${state.reviewing}-${state.index}`}
      />
      <Text dimColor>
        {state.reviewing
          ? "a apply and allow Guide use | e edit answers | x discard brief | Esc pause"
          : `Enter save (blank = unknown) | Ctrl+B previous | Esc pause | ${[...state.draft].length}/${customerFieldMaximum}`}
      </Text>
      <Text dimColor>PgUp/PgDn scroll. This is context approval, not customer signoff.</Text>
    </Box>
  )
}
