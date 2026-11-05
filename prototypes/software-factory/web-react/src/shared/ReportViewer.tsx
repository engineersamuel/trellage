// Report viewer (CopilotKit UI only): a modal for reports/*.md that workers save in a conversation worktree.
// Views: Rendered (GitHub Markdown), MDX (the report compiled as MDX with Finding cards), Source.
// Each ranked finding gets "Start in Factory": a new conversation in the same repo runs the delivery loop.
import { evaluate } from "@mdx-js/mdx"
import { Fragment, useEffect, useState, type ReactNode } from "react"
import * as runtime from "react/jsx-runtime"
import { renderToStaticMarkup } from "react-dom/server"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Effect } from "effect"
import { json } from "../../../shared/http"
import { Report as ReportSchema, StartedConversation, type Report as ReportT } from "../../../shared/schemas"
import { findings, toMdx, type Finding } from "./report-model"
import { openThread } from "../state/chat"
import "./report-viewer.css"

export type Report = ReportT
type View = "brief" | "rendered" | "mdx" | "source"

/** GET one report, decoded. Rejects with the server's message. */
const fetchReport = (ref: string, thread?: string, agent?: string): Promise<Report> => {
  const q = new URLSearchParams({ path: ref, ...(thread ? { thread } : {}), ...(agent ? { agent } : {}) })
  return Effect.runPromise(json(`/api/reports?${q}`, ReportSchema).pipe(Effect.mapError((e) => new Error(e.reason))))
}

/** Start a finding as a new conversation; resolves with its thread and branch. */
const startFinding = (report: Report, finding: Finding) =>
  Effect.runPromise(
    json("/api/reports/start", StartedConversation, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: report.path, thread: report.threadId, title: `${finding.rank}. ${finding.title}`, body: finding.body }),
    }).pipe(Effect.mapError((e) => new Error(e.reason))),
  )

function StartButton({ report, finding }: { report: Report; finding: Finding }) {
  const [state, setState] = useState<"idle" | "busy" | { branch: string | null } | { error: string }>("idle")
  const start = async () => {
    setState("busy")
    try {
      const t = await startFinding(report, finding)
      setState({ branch: t.branch })
      openThread(t.threadId)
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) })
    }
  }
  if (typeof state === "object" && "branch" in state) return <span className="rv-started">Started in Factory · {state.branch ?? "new worktree"}</span>
  return (
    <span className="rv-start-wrap">
      <button className="rv-start" disabled={state === "busy"} onClick={start} title={`New worktree of ${report.folderId}; the coordinator plans, asks you to approve, implements, and verifies`}>
        {state === "busy" ? "Starting…" : "▶ Start in Factory"}
      </button>
      {typeof state === "object" && "error" in state && <span className="rv-error">{state.error}</span>}
    </span>
  )
}

/** GitHub-flavored Markdown with a Start button on every ranked finding heading. */
function Rendered({ report, list }: { report: Report; list: Finding[] }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      components={{
        h2: ({ children }) => {
          const text = String(Array.isArray(children) ? children.join("") : children)
          const f = list.find((x) => text.startsWith(`${x.rank}.`) || text.startsWith(`${x.rank})`))
          return (
            <h2 className="rv-h2">
              <span>{children}</span>
              {f && <StartButton report={report} finding={f} />}
            </h2>
          )
        },
        a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
      }}
    >
      {report.content}
    </Markdown>
  )
}

/** The report compiled as MDX; `<Finding>` renders each ranked item as a card. */
function MdxView({ report, list }: { report: Report; list: Finding[] }) {
  const [content, setContent] = useState<ReactNode>(<p className="rv-muted">Compiling MDX…</p>)
  useEffect(() => {
    let live = true
    evaluate(toMdx(report.content), { ...(runtime as any), Fragment, remarkPlugins: [remarkGfm] })
      .then(({ default: Content }) => {
        const Finding = ({ rank, title, children }: { rank: number; title: string; children: ReactNode }) => {
          const f = list.find((x) => x.rank === rank) ?? { rank, title, body: "" }
          return (
            <section className="rv-finding">
              <header>
                <span className="rv-rank">{rank}</span>
                <b>{title}</b>
                <StartButton report={report} finding={f} />
              </header>
              <div>{children}</div>
            </section>
          )
        }
        if (live) setContent(<Content components={{ Finding }} />)
      })
      .catch((e) => live && setContent(<pre className="rv-error">MDX compile failed: {String(e?.message ?? e)}</pre>))
    return () => void (live = false)
  }, [report])
  return <>{content}</>
}

const STYLE = `body{margin:0;background:#0b0b0f;color:#e5e5e5;font:15px/1.6 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 20px}a{color:#818cf8}
code{background:#1f1f27;padding:1px 5px;border-radius:4px;font-size:.9em}pre{background:#15151b;padding:12px;border-radius:8px;overflow:auto}
pre code{background:none;padding:0}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #2a2a33;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#17171e}h1,h2{border-bottom:1px solid #26262e;padding-bottom:6px}.meta{color:#a3a3a3;font-size:13px}`

/** A standalone HTML page of the report, opened in a new tab. */
export const reportHtml = (report: Report): string => {
  const body = renderToStaticMarkup(<Markdown remarkPlugins={[remarkGfm]}>{report.content}</Markdown>)
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(report.path)}</title><style>${STYLE}</style></head><body><main><p class="meta">${esc(report.folderId)} · ${esc(report.file)}</p>${body}</main></body></html>`
}

const openBlob = (text: string, type: string, download?: string) => {
  const url = URL.createObjectURL(new Blob([text], { type }))
  if (download) {
    const a = Object.assign(document.createElement("a"), { href: url, download })
    a.click()
  } else window.open(url, "_blank", "noopener")
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export function ReportViewer({ refPath, thread, agent, onClose }: { refPath: string; thread?: string; agent?: string; onClose: () => void }) {
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<View>("rendered")
  const [brief, setBrief] = useState<Report | null>(null)
  useEffect(() => {
    fetchReport(refPath, thread, agent).then((r) => {
      setReport(r)
      // A synthesis may have a Rundown-style brief next to it: same findings, skimmable. It opens first.
      const ref = briefRef(r.path)
      if (ref) fetchReport(ref, r.threadId).then((b) => (setBrief(b), setView("brief")), () => {})
    }, (e) => setError(String(e?.message ?? e)))
    // Capture phase: the chat input stops Escape, and the panel behind must not also close.
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose())
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [refPath, thread, agent])
  const list = report ? findings(report.content) : []
  const name = report?.path.split("/").pop() ?? refPath
  return (
    <div className="rv-backdrop" onClick={onClose}>
      <div className="rv-modal" role="dialog" aria-label={`Report ${name}`} onClick={(e) => e.stopPropagation()}>
        <header className="rv-head">
          <div className="rv-title">
            <b>{report?.path ?? refPath}</b>
            {report && <span className="rv-muted" title={report.file}>{report.folderId} · {report.title}</span>}
          </div>
          <div className="rv-tabs" role="tablist">
            {((brief ? ["brief", "rendered", "mdx", "source"] : ["rendered", "mdx", "source"]) as View[]).map((v) => (
              <button key={v} role="tab" aria-selected={view === v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
                {v === "brief" ? "Brief" : v === "rendered" ? "Full" : v === "mdx" ? "Open as MDX" : "Source"}
              </button>
            ))}
          </div>
          {report && <button onClick={() => openBlob(reportHtml(report), "text/html")}>Open as HTML ↗</button>}
          {report && view === "mdx" && <button onClick={() => openBlob(toMdx(report.content), "text/markdown", name.replace(/\.md$/, ".mdx"))}>Download .mdx</button>}
          <button className="rv-x" onClick={onClose} aria-label="Close">✕</button>
        </header>
        <div className="rv-body">
          {error && <p className="rv-error">{error}</p>}
          {!report && !error && <p className="rv-muted">Loading…</p>}
          {report && list.length > 0 && view !== "source" && (
            <p className="rv-muted">{list.length} findings · each "Start in Factory" opens a new worktree of {report.folderId} and runs plan → approval → implement → verify.</p>
          )}
          {report && brief && view === "brief" && <Rendered report={{ ...report, content: briefLines(brief.content) }} list={list} />}
          {report && view === "rendered" && <Rendered report={report} list={list} />}
          {report && view === "mdx" && <MdxView report={report} list={list} />}
          {report && view === "source" && <pre className="rv-source">{report.content}</pre>}
        </div>
      </div>
    </div>
  )
}

/** A brief is one item per line; keep each line on its own even when the writer left out the "- ". */
export const briefLines = (md: string): string => {
  let fence = false
  return md
    .split("\n")
    .map((l) => {
      if (/^\s*(```|~~~)/.test(l)) return (fence = !fence), l
      return fence || !l.trim() || /^\s*([-*+]\s|\d+[.)]\s|#|\||>)/.test(l) ? l : `${l}  `
    })
    .join("\n")
}

/** The brief that sits next to a report: reports/synthesis.md → reports/synthesis.brief.md. */
export const briefRef = (p: string): string | null => (/\.brief\.md$/.test(p) || !/\.md$/.test(p) ? null : p.replace(/\.md$/, ".brief.md"))

/** A text that names a saved report: `reports/x.md`, or an absolute path ending in .md/.mdx. */
export const REPORT_REF = /^(?:\/[^\s`'"]+\/)?reports\/[\w.-]+\.mdx?$/
