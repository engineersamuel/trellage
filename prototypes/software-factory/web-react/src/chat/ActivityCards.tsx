// AG-UI activity messages in the coordinator chat (rule 10: known layout, so CopilotKit draws it).
// The coordinator sends one card per subagent it delegates to and one per worker the run starts.
// The worker card reads the live worker from the store; the message content is the fallback for old threads.
import type { ReactActivityMessageRenderer } from "@copilotkit/react-core"
import { z } from "zod"
import { agentLabel } from "../../../shared/tree"
import { patchSettings, useApp } from "../state/store"
import "./ActivityCards.css"

const SubagentContent = z.object({
  name: z.string(),
  description: z.string().optional(),
  status: z.string(),
  model: z.string().optional(),
  toolCalls: z.number().optional(),
  durationMs: z.number().optional(),
  totalTokens: z.number().optional(),
  error: z.string().optional(),
})
export type SubagentContent = z.infer<typeof SubagentContent>

const WorkerContent = z.object({
  id: z.string(),
  name: z.string().optional(),
  status: z.string(),
  harness: z.string().optional(),
  model: z.string().optional(),
  task: z.string().optional(),
  lastMessage: z.string().optional(),
})
export type WorkerContent = z.infer<typeof WorkerContent>

/** Pure: the subagent card's one-line detail. */
export const subagentLine = (c: SubagentContent): string =>
  [
    c.model,
    c.toolCalls !== undefined ? `${c.toolCalls} tool call${c.toolCalls === 1 ? "" : "s"}` : undefined,
    c.durationMs !== undefined ? `${(c.durationMs / 1000).toFixed(1)} s` : undefined,
    c.totalTokens !== undefined ? `${Math.round(c.totalTokens / 1000)}k tokens` : undefined,
  ]
    .filter(Boolean)
    .join(" · ")

const Status = ({ status }: { status: string }) => <span className={`sfa-status sfa-${status}`}>{status}</span>

function SubagentCard({ content }: { content: SubagentContent }) {
  return (
    <section className="sfa-card" aria-label="Subagent">
      <header>
        <span className="sfa-kind">Subagent</span>
        <b>{content.name}</b>
        <Status status={content.status} />
      </header>
      {content.description && <p className="sfa-text">{content.description}</p>}
      {subagentLine(content) && <p className="sfa-meta">{subagentLine(content)}</p>}
      {content.error && <p className="sfa-error">{content.error}</p>}
    </section>
  )
}

function WorkerCard({ content }: { content: WorkerContent }) {
  const live = useApp((s) => s.workers[content.id])
  const w = { ...content, ...(live ?? {}) }
  const label = live ? agentLabel(live) : { name: content.name ?? content.id, tag: content.harness ?? "worker" }
  return (
    <section className="sfa-card sfa-clickable" aria-label="Worker" onClick={() => patchSettings({ focus: content.id })} title="Show this agent in the panel">
      <header>
        <span className="sfa-kind">{label.tag && label.tag !== "worker" ? `Worker · ${label.tag}` : "Worker"}</span>
        <b>{label.name}</b>
        <Status status={live ? live.status : content.status} />
      </header>
      {w.task && <p className="sfa-text">{w.task.slice(0, 200)}</p>}
      {w.lastMessage && w.lastMessage !== w.task && <p className="sfa-meta">{w.lastMessage.slice(0, 200)}</p>}
      {w.model && <p className="sfa-meta">{w.model}</p>}
    </section>
  )
}

export const activityRenderers: ReactActivityMessageRenderer<any>[] = [
  { activityType: "subagent", agentId: "coordinator", content: SubagentContent, render: SubagentCard },
  { activityType: "worker", agentId: "coordinator", content: WorkerContent, render: WorkerCard },
]
