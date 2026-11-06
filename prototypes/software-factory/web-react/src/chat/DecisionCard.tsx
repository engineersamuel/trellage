// request_approval / ask_user in the chat: the decision card with its options, answered in place.
// The tool is a backend tool, so this is a renderer (useRenderTool), not useHumanInTheLoop. When the last run
// ended with this decision as an AG-UI interrupt, the answer resumes that run (`resume`); otherwise it goes
// through the approvals API and comes back to the coordinator as an "[approval … answered]" turn.
import { useCopilotKit } from "@copilotkit/react-core"
import { useState } from "react"
import { answer, runApprovals } from "../../../shared/approvals"
import { answerInterrupt } from "../state/chat"
import { useApp } from "../state/store"
import { ToolCard } from "./ToolCards"
import "./DecisionCard.css"

/** The decision id from the tool result (`{ id, status: "pending" }`), if the call succeeded. */
export const decisionIdOf = (result: string | undefined): string | null => {
  if (!result) return null
  try {
    const r = JSON.parse(result) as { id?: unknown }
    return typeof r.id === "string" ? r.id : null
  } catch {
    return null
  }
}

type Props = { name: string; toolCallId: string; args: unknown; result?: string | undefined }

export function DecisionCard(props: Props) {
  const id = decisionIdOf(props.result)
  const d = useApp((s) => (id ? s.decisions.find((x) => x.id === id) : undefined))
  const [note, setNote] = useState("")
  const [sending, setSending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { copilotkit } = useCopilotKit()
  // Still running, failed, or not loaded yet: the plain tool card.
  if (!d) return <ToolCard {...props} />
  const send = (choice: string) => {
    setSending(choice)
    setError(null)
    const n = note.trim() || null
    const resumed = answerInterrupt(copilotkit, d.id, choice, n)
    ;(resumed === false ? runApprovals(answer(d.id, choice, n)) : resumed).then(
      () => setSending(null),
      (e: { reason?: string }) => (setSending(null), setError(e.reason ?? String(e))),
    )
  }
  const done = d.status === "answered"
  return (
    <section className={`sfc-decision sfc-${d.kind}`} aria-label={d.kind === "question" ? "Question" : "Approval"}>
      <header>
        <span className="sfc-kind">{done ? "Answered" : d.kind === "question" ? "Question for you" : "Approval needed"}</span>
        <b>{d.title}</b>
      </header>
      {d.summary && <p className="sfc-summary">{d.summary}</p>}
      {done ? (
        <p className="sfc-done">
          ✓ {d.answer}
          {d.note ? <span> · {d.note}</span> : null}
        </p>
      ) : (
        <>
          <div className="sfc-options">
            {d.options.map((o, i) => (
              <button key={o} disabled={sending !== null} className={i === 0 ? "sfc-primary" : ""} onClick={() => send(o)} title={d.optionDetails[i] ?? ""}>
                {sending === o ? "Sending…" : o}
              </button>
            ))}
          </div>
          {/* A question without options takes a free answer; otherwise the text is an optional note. */}
          {d.options.length === 0 ? (
            <form onSubmit={(e) => (e.preventDefault(), note.trim() && send(note.trim()))}>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Type your answer…" />
            </form>
          ) : (
            <input className="sfc-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional note for the coordinator" />
          )}
          {error && <p className="sfc-error">{error}</p>}
        </>
      )}
    </section>
  )
}
