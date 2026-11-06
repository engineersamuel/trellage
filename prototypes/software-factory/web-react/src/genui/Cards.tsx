// Typed chat cards (rule 13): our layouts, drawn with OpenUI's React components. Each card reads live data from the
// store and falls back to the tool result (the snapshot at call time). View models are pure and tested.
import { Button, Callout, Card, CardHeader, MetricIndicatorInline, Steps, StepsItem, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tag } from "@openuidev/react-ui"
import { useMemo, useState } from "react"
import { answer, runApprovals, type Decision } from "../../../shared/approvals"
import { Effect } from "effect"
import { json } from "../../../shared/http"
import { Report as ReportSchema, StartedConversation, type SecurityReview, type StepDecision } from "../../../shared/schemas"
import { openThread } from "../state/chat"
import { Action } from "../state/model"
import { dispatch, useApp } from "../state/store"
import { OpenUiTheme } from "./OpenUi"

type TagVariant = "neutral" | "info" | "success" | "warning" | "danger"

const parse = <T,>(result: string | undefined): T | null => {
  try {
    return result ? (JSON.parse(result) as T) : null
  } catch {
    return null
  }
}

function Frame({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <OpenUiTheme>
      <Card variant="card" width="full" className="sf-board">
        <CardHeader title={title} {...(subtitle ? { subtitle } : {})} />
        {children}
      </Card>
    </OpenUiTheme>
  )
}

const Waiting = ({ what }: { what: string }) => <p className="sf-board-wait">Loading {what}…</p>

// ---------- Security review ----------

const SEVERITY: Record<string, TagVariant> = { critical: "danger", high: "danger", medium: "warning", low: "info" }

export type ReviewView = { status: string; statusVariant: TagVariant; kept: number; discarded: number; rows: { title: string; severity: string; variant: TagVariant; file: string; verdict: string; reason: string }[] }

/** Pure: review → what the card shows. Kept findings first, then by severity. */
export const toReview = (r: SecurityReview): ReviewView => {
  const order = ["critical", "high", "medium", "low"]
  const rows = r.findings
    .map((f) => ({ title: f.title, severity: f.severity || "unknown", variant: SEVERITY[f.severity.toLowerCase()] ?? "neutral", file: f.file, verdict: f.verdict || "pending", reason: f.reason }))
    .sort((a, b) => Number(b.verdict === "keep") - Number(a.verdict === "keep") || order.indexOf(a.severity.toLowerCase()) - order.indexOf(b.severity.toLowerCase()))
  return {
    status: r.status,
    statusVariant: r.status === "done" ? "success" : r.status === "failed" ? "danger" : "info",
    kept: r.findings.filter((f) => f.verdict === "keep").length,
    discarded: r.findings.filter((f) => f.verdict && f.verdict !== "keep").length,
    rows,
  }
}

export function SecurityReviewCard({ result }: { result: string | undefined }) {
  const snap = parse<{ reviewId: string | null; note?: string }>(result)
  const review = useApp((s) => (snap?.reviewId ? s.securityReviews.find((r) => r.id === snap.reviewId) : undefined))
  if (result === undefined) return <Waiting what="security review" />
  if (!snap?.reviewId) return <Frame title="Security review"><Callout variant="neutral" description={snap?.note ?? "No security review yet."} /></Frame>
  if (!review) return <Frame title="Security review" subtitle={snap.reviewId}><Callout variant="info" description="Review data is loading or no longer kept." /></Frame>
  const v = toReview(review)
  return (
    <Frame title="Security review" subtitle={review.model || "routing model"}>
      <div className="sf-board-metrics">
        <Tag text={v.status} variant={v.statusVariant} size="sm" />
        <MetricIndicatorInline value={String(review.findings.length)} subtext="findings" />
        <MetricIndicatorInline value={String(v.kept)} subtext="kept (fixed)" />
        <MetricIndicatorInline value={String(v.discarded)} subtext="discarded" />
      </div>
      {review.error && <Callout variant="danger" title="Review failed" description={review.error} />}
      {v.rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Finding</TableHead>
              <TableHead>Severity</TableHead>
              <TableHead>Verdict</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {v.rows.map((r, i) => (
              <TableRow key={i} title={r.reason}>
                <TableCell>
                  {r.title} <small>{r.file}</small>
                </TableCell>
                <TableCell>
                  <Tag text={r.severity} variant={r.variant} size="sm" />
                </TableCell>
                <TableCell>
                  {r.verdict} {r.reason && <small>{r.reason}</small>}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Frame>
  )
}

// ---------- Delivery run ----------

export type RunView = { branch: string | null; moreWork: number | null; steps: { step: string; confidence: number; request: string }[] }

/** Pure: snapshot + live Jev decisions → run view. Live decisions win; fan-out decisions (no step) are skipped. */
export const toRun = (branch: string | null, decisions: readonly StepDecision[]): RunView => {
  const steps = decisions.filter((d) => d.step).slice(-6).map((d) => ({ step: d.step!, confidence: d.confidence ?? 0, request: d.request }))
  const last = [...decisions].reverse().find((d) => d.moreWork !== undefined)
  return { branch, moreWork: last?.moreWork ?? null, steps }
}

/** Pure: only the decisions of one coordinator. Untagged (older) ones belong to the Factory desk. */
export const ownSteps = (all: readonly StepDecision[], scopeId: string | undefined): StepDecision[] =>
  scopeId === undefined ? [...all] : all.filter((d) => (d.scopeId ?? "coordinator") === scopeId)

export function DeliveryRunCard({ result }: { result: string | undefined }) {
  const snap = parse<{ scopeId?: string; branch: string | null; decisions?: StepDecision[]; note?: string }>(result)
  const all = useApp((s) => s.stepDecisions)
  const live = useMemo(() => ownSteps(all, snap?.scopeId), [all, snap?.scopeId])
  if (result === undefined) return <Waiting what="delivery run" />
  const v = toRun(snap?.branch ?? null, live.length ? live : (snap?.decisions ?? []))
  if (v.steps.length === 0) return <Frame title="Delivery run"><Callout variant="neutral" description={snap?.note ?? "No delivery run in this conversation yet."} /></Frame>
  const pct = v.moreWork === null ? null : Math.round((1 - v.moreWork) * 100)
  return (
    <Frame title="Delivery run" {...(v.branch ? { subtitle: `⎇ ${v.branch}` } : {})}>
      <div className="sf-board-metrics">
        <MetricIndicatorInline value={pct === null ? "–" : `${pct}%`} subtext="done (Jev)" />
        <MetricIndicatorInline value={v.steps.at(-1)?.step ?? "–"} subtext="current step" />
      </div>
      {pct !== null && (
        <div className="sf-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <span style={{ width: `${pct}%` }} />
        </div>
      )}
      {v.steps.length === 0 ? (
        <Callout variant="neutral" description="No Jev decision yet." />
      ) : (
        <Steps>
          {v.steps.map((s, i) => (
            <StepsItem key={i} number={i + 1} title={`${s.step} · ${Math.round(s.confidence * 100)}%`} details={s.request.slice(0, 160)} />
          ))}
        </Steps>
      )}
    </Frame>
  )
}

// ---------- Diff summary ----------

type Diff = { base: string; files: { path: string; added: number; removed: number; binary: boolean }[]; added: number; removed: number; truncated: boolean; error?: string }

export function DiffSummaryCard({ result }: { result: string | undefined }) {
  const d = parse<Diff>(result)
  if (result === undefined) return <Waiting what="diff" />
  if (!d || d.error) return <Frame title="Changes"><Callout variant="warning" description={d?.error ?? "No diff."} /></Frame>
  return (
    <Frame title="Changes" subtitle={`against ${d.base.slice(0, 8)}`}>
      <div className="sf-board-metrics">
        <MetricIndicatorInline value={String(d.files.length) + (d.truncated ? "+" : "")} subtext="files" />
        <MetricIndicatorInline value={`+${d.added}`} subtext="added" />
        <MetricIndicatorInline value={`−${d.removed}`} subtext="removed" />
      </div>
      {d.files.length === 0 ? (
        <Callout variant="neutral" description="No changes yet." />
      ) : (
        <Table>
          <TableBody>
            {d.files.map((f) => (
              <TableRow key={f.path}>
                <TableCell>
                  <code>{f.path}</code>
                </TableCell>
                <TableCell align="right">{f.binary ? <small>binary</small> : <span className="sf-diff-add">+{f.added}</span>}</TableCell>
                <TableCell align="right">{f.binary ? null : <span className="sf-diff-del">−{f.removed}</span>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Frame>
  )
}

// ---------- Report findings ----------

type Findings = { path: string; findings: { rank: number; title: string; body: string }[]; error?: string; note?: string }

const startFinding = (path: string, rank: number, title: string, body: string) =>
  Effect.runPromise(
    json(`/api/reports?${new URLSearchParams({ path })}`, ReportSchema).pipe(
      Effect.flatMap((r) =>
        json("/api/reports/start", StartedConversation, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: r.path, thread: r.threadId, title: `${rank}. ${title}`, body }),
        }),
      ),
      Effect.mapError((e) => new Error(e.reason)),
    ),
  )

function StartFinding({ path, rank, title, body }: { path: string; rank: number; title: string; body: string }) {
  const [state, setState] = useState<"idle" | "busy" | "done" | string>("idle")
  if (state === "done") return <small>Started</small>
  return (
    <>
      <Button
        size="extra-small"
        variant="secondary"
        disabled={state === "busy"}
        onClick={() => {
          setState("busy")
          startFinding(path, rank, title, body).then(
            (t) => (setState("done"), openThread(t.threadId)),
            (e: Error) => setState(e.message),
          )
        }}
      >
        {state === "busy" ? "Starting…" : "▶ Start"}
      </Button>
      {state !== "idle" && state !== "busy" && <small className="sf-err">{state}</small>}
    </>
  )
}

export function ReportFindingsCard({ result }: { result: string | undefined }) {
  const d = parse<Findings>(result)
  if (result === undefined) return <Waiting what="report" />
  if (!d) return <Frame title="Report"><Callout variant="warning" description="No report data." /></Frame>
  return (
    <Frame title="Report findings" subtitle={d.path}>
      {d.error && <Callout variant="warning" description={d.error} />}
      {d.findings.length === 0 && !d.error && <Callout variant="neutral" description="No ranked findings in this report." />}
      {d.findings.length > 0 && (
        <Table>
          <TableBody>
            {d.findings.map((f) => (
              <TableRow key={f.rank} title={f.body}>
                <TableCell>
                  <b>{f.rank}.</b> {f.title}
                </TableCell>
                <TableCell align="right">
                  <StartFinding path={d.path} rank={f.rank} title={f.title} body={f.body} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      <Button size="small" variant="tertiary" onClick={() => dispatch(Action.ReportOpened({ ref: d.path }))}>
        Open full report
      </Button>
    </Frame>
  )
}

// ---------- Confirm (human in the loop) ----------

type ConfirmArgs = { title: string; detail?: string; confirmLabel?: string }

/** A yes/no the run waits for (useHumanInTheLoop). `respond` resumes the agent with the answer. */
export function ConfirmCard({ args, respond, result }: { args: Partial<ConfirmArgs>; respond?: (r: unknown) => Promise<void>; result?: unknown }) {
  const [sent, setSent] = useState<string | null>(null)
  const done = sent ?? (typeof result === "string" ? result : null)
  return (
    <Frame title={args.title ?? "Confirm"} subtitle="The coordinator waits for your answer">
      {args.detail && <p className="sf-board-text">{args.detail}</p>}
      {done ? (
        <Tag text={done} variant={done === "confirmed" ? "success" : "neutral"} size="sm" />
      ) : (
        <div className="sf-board-actions">
          {/* respond exists only while the call is parked (executing); until then the buttons wait. */}
          <Button size="small" variant="primary" disabled={!respond} onClick={() => respond && (setSent("confirmed"), void respond("confirmed"))}>
            {args.confirmLabel ?? "Confirm"}
          </Button>
          <Button size="small" variant="secondary" disabled={!respond} onClick={() => respond && (setSent("declined"), void respond("declined"))}>
            Cancel
          </Button>
        </div>
      )}
    </Frame>
  )
}

// ---------- Decision queue ----------

/** Pending decisions, oldest first, each answerable with its options. Used by the show_decisions card. */
export function DecisionQueueCard() {
  // Select the stable list, derive outside the selector: a new array from a selector re-renders forever.
  const decisions = useApp((s) => s.decisions)
  const pending = useMemo(() => decisions.filter((d) => d.status === "pending").sort((a, b) => a.createdAt - b.createdAt), [decisions])
  return (
    <Frame title="Waiting for you" subtitle={`${pending.length} decision${pending.length === 1 ? "" : "s"}`}>
      {pending.length === 0 ? <Callout variant="success" description="Nothing is waiting." /> : pending.map((d) => <QueueRow key={d.id} d={d} />)}
    </Frame>
  )
}

function QueueRow({ d }: { d: Decision }) {
  const [state, setState] = useState<string | null>(null)
  return (
    <div className="sf-queue-row">
      <div>
        <Tag text={d.kind === "question" ? "question" : "approval"} variant={d.kind === "question" ? "warning" : "info"} size="sm" /> <b>{d.title}</b> <small>{d.context}</small>
      </div>
      <div className="sf-board-actions">
        {d.options.map((o, i) => (
          <Button
            key={o}
            size="extra-small"
            variant={i === 0 ? "primary" : "secondary"}
            disabled={state !== null}
            onClick={() => (setState(o), runApprovals(answer(d.id, o, null)).catch((e: { reason?: string }) => setState(`failed: ${e.reason ?? e}`)))}
          >
            {o}
          </Button>
        ))}
        {d.options.length === 0 && (
          <Button size="extra-small" variant="secondary" onClick={() => (location.hash = `decision=${d.id}`)}>
            Answer…
          </Button>
        )}
        {state?.startsWith("failed") && <small className="sf-err">{state}</small>}
      </div>
    </div>
  )
}
