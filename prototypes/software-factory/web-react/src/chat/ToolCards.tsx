// Tool calls in the coordinator chat, drawn with affectUI's Tool Call Card (src/components/ui).
// AG-UI tool messages carry no times and no failure flag; both come from the store (factory feed).
import { useAgent, UseAgentUpdate, type ToolCallEntry } from "@copilotkit/react-core"
import { createElement, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { toolDiffs, type FileDiff } from "../../../shared/diff"
import { renderDiffs } from "../../../shared/diffview"
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
  call: { id: string; name: string; args: unknown; result: string | undefined; error?: string },
  timing: ToolTiming | undefined,
): ToolCallCardProps & { key: string } => {
  const done = call.result !== undefined || timing?.endedAt !== undefined
  // The AG-UI tool message says whether it failed; the feed is the fallback for older saved threads.
  const failed = call.error !== undefined || timing?.failed === true
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
    ...(status === "error" ? { error: call.error || timing?.error || call.result || "The tool call failed." } : {}),
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
    ...(e.toolMessage?.error !== undefined ? { error: e.toolMessage.error } : {}),
  }
}

/** Files the calls changed, drawn by the shared plain-DOM diff view (same look as the worker transcripts). */
export function Diffs({ files }: { files: readonly FileDiff[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => void (ref.current && renderDiffs(ref.current, files)), [files])
  return files.length ? <div ref={ref} className="sf-chat-diffs" /> : null
}

const callDiffs = (c: { name: string; args: unknown; result: string | undefined; error?: string }): FileDiff[] =>
  c.error === undefined ? toolDiffs(c.name, c.args, c.result) : []

/** The `error` of a call's AG-UI tool message. Render props carry only the result text, so it is read from the agent. */
const useToolError = (toolCallId: string): string | undefined => {
  const { agent } = useAgent({ agentId: "coordinator", updates: [UseAgentUpdate.OnMessagesChanged] })
  const m = agent.messages.find((x) => x.role === "tool" && x.toolCallId === toolCallId)
  return m?.role === "tool" ? m.error : undefined
}

/** Wildcard renderer: one call that the chat did not group. */
export function ToolCard({ name, toolCallId, args, result }: { name: string; toolCallId: string; args: unknown; result?: string | undefined }) {
  const timing = useApp((s) => s.toolTimings[toolCallId])
  const error = useToolError(toolCallId)
  const { key, ...props } = cardProps({ id: toolCallId, name, args, result, ...(error !== undefined ? { error } : {}) }, timing)
  const diffs = useMemo(() => callDiffs({ name, args, result, ...(error !== undefined ? { error } : {}) }), [name, args, result, error])
  return (
    <>
      <ToolCallCard key={key} {...props} />
      <Diffs files={diffs} />
    </>
  )
}

/**
 * Group slot for CopilotKit's tool-call view. ToolCallGroup reads its children's props
 * (name, icon, status, duration), so the cards are built here instead of through `renderCall`.
 */
export function ToolGroup({ calls }: { calls: ToolCallEntry[]; renderCall?: (c: ToolCallEntry) => ReactNode; isActive?: boolean }) {
  const timings = useApp((s) => s.toolTimings)
  const [open, setOpen] = useState(false)
  const entries = calls.map(entryCall)
  const cards = entries.map((c) => cardProps(c, timings[c.id]))
  // ToolCallGroup reads its children's props, so the diffs of all calls go after the group, not inside it.
  const diffKey = entries.map((c) => `${c.id}:${c.result?.length ?? -1}:${c.error ?? ""}`).join()
  const diffs = useMemo(() => entries.flatMap(callDiffs), [diffKey])
  // A single call needs no group line.
  if (cards.length === 1) {
    const { key, ...props } = cards[0]!
    return (
      <>
        <ToolCallCard key={key} {...props} />
        <Diffs files={diffs} />
      </>
    )
  }
  return (
    <>
      <ToolCallGroup open={open} onOpenChange={setOpen}>
        {cards.map(({ key, ...props }) => <ToolCallCard key={key} {...props} />)}
      </ToolCallGroup>
      <Diffs files={diffs} />
    </>
  )
}
