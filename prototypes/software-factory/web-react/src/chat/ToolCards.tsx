// Tool calls in the coordinator chat, drawn with affectUI's Tool Call Card (src/components/ui).
// AG-UI tool messages carry no times and no failure flag; both come from the store (factory feed).
import type { ToolCallEntry } from "@copilotkit/react-core"
import { createElement, useState, type ReactNode } from "react"
import { toolGlyph } from "../../../shared/toolglyphs"
import { toolLine } from "../../../shared/transcript"
import { ToolCallCard, ToolCallGroup, type ToolCallCardProps } from "../components/ui/tool-call-card"
import type { ToolTiming } from "../state/model"
import { useApp } from "../state/store"

/** The tool's 16px glyph, shared with the plain-DOM transcript cards. */
export const ToolIcon = ({ name }: { name: string }) => (
  <svg viewBox="0 0 16 16">{toolGlyph(name).map(([tag, attrs], i) => createElement(tag, { key: i, ...attrs }))}</svg>
)

const parse = (s: string): unknown => {
  try {
    return JSON.parse(s)
  } catch {
    return s
  }
}

/** Card props for one call. Pure, so tests check the mapping without rendering. */
export const cardProps = (
  call: { id: string; name: string; args: unknown; result: string | undefined },
  timing: ToolTiming | undefined,
): ToolCallCardProps & { key: string } => {
  const done = call.result !== undefined || timing?.endedAt !== undefined
  const failed = timing?.failed === true
  const status = !done ? "running" : failed ? "error" : "success"
  const args = (typeof call.args === "object" && call.args !== null ? call.args : {}) as Record<string, unknown>
  const summary = toolLine({ kind: "tool", id: call.id, name: call.name, args, done, ok: !failed, result: call.result ?? "" }).text
  return {
    key: call.id,
    name: call.name,
    summary: summary || undefined,
    icon: <ToolIcon name={call.name} />,
    status,
    args: call.args,
    ...(status === "success" && call.result !== undefined ? { result: call.result } : {}),
    ...(status === "error" ? { error: timing?.error ?? call.result ?? "The tool call failed." } : {}),
    ...(timing ? { startedAt: timing.startedAt } : {}),
    ...(timing?.endedAt !== undefined ? { duration: timing.endedAt - timing.startedAt } : {}),
  }
}

const entryCall = (e: ToolCallEntry) => {
  const content = e.toolMessage?.content
  return {
    id: e.toolCall.id,
    name: e.toolCall.function.name,
    args: parse(e.toolCall.function.arguments),
    result: content === undefined ? undefined : typeof content === "string" ? content : JSON.stringify(content),
  }
}

/** Wildcard renderer: one call that the chat did not group. */
export function ToolCard({ name, toolCallId, args, result }: { name: string; toolCallId: string; args: unknown; result?: string }) {
  const timing = useApp((s) => s.toolTimings[toolCallId])
  const { key, ...props } = cardProps({ id: toolCallId, name, args, result }, timing)
  return <ToolCallCard key={key} {...props} />
}

/**
 * Group slot for CopilotKit's tool-call view. ToolCallGroup reads its children's props
 * (name, icon, status, duration), so the cards are built here instead of through `renderCall`.
 */
export function ToolGroup({ calls }: { calls: ToolCallEntry[]; renderCall?: (c: ToolCallEntry) => ReactNode; isActive?: boolean }) {
  const timings = useApp((s) => s.toolTimings)
  const [open, setOpen] = useState(false)
  const cards = calls.map((e) => cardProps(entryCall(e), timings[e.toolCall.id]))
  // A single call needs no group line.
  if (cards.length === 1) {
    const { key, ...props } = cards[0]!
    return <ToolCallCard key={key} {...props} />
  }
  return (
    <ToolCallGroup open={open} onOpenChange={setOpen}>
      {cards.map(({ key, ...props }) => <ToolCallCard key={key} {...props} />)}
    </ToolCallGroup>
  )
}
