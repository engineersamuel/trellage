// "Since you last looked": pinned at the top of the Chief of Staff detail. The newest report of each conversation
// since the last visit, and how many rule actions ran. A row opens its conversation. The CoS chat hides these events.
import { Schema } from "effect"
import { onFeed, RESYNC } from "../feed"
import { json, runOr } from "../http"
import { StoredEvent } from "../schemas"
import { el, subscribe, type State } from "./core"

const SEEN_KEY = "sf_cos_seen"
const LedgerAt = Schema.Array(Schema.Struct({ at: Schema.Number }))
type Report = { threadId: string; at: number; status: string; summary: string }

const readSeen = (): number => {
  try {
    return Number(localStorage.getItem(SEEN_KEY)) || 0
  } catch {
    return 0
  }
}
const writeSeen = (at: number) => {
  try {
    localStorage.setItem(SEEN_KEY, String(at))
  } catch {}
}
const ago = (t: number) => {
  const m = Math.max(0, Math.round((Date.now() - t) / 60000))
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`
}

/** Mount the digest in `box`. `open` shows a conversation by thread id. Leaving it marks everything as seen. */
export const mountDigest = (box: HTMLElement, open: (threadId: string) => void): (() => void) => {
  box.dataset.testid = "cos-digest"
  let since = readSeen()
  let reports: Report[] = []
  let rules = 0
  let s: State | null = null
  const details = el("details", "p3-pin p3-digest")
  details.open = true
  box.replaceChildren(details)
  const render = () => {
    const title = (id: string) => s?.threads.find((t) => t.id === id)
    // The newest report of each conversation, newest first.
    const latest = [...new Map(reports.map((r) => [r.threadId, r])).values()].sort((a, b) => b.at - a.at)
    const head = since ? `since ${ago(since)} ago` : "so far"
    const counts = [`${latest.length} ${latest.length === 1 ? "report" : "reports"}`, `${rules} rule actions`]
    const rows = latest.map((r) => {
      const t = title(r.threadId)
      const row = el("button", `p3-digest-row s-${r.status}`)
      row.append(
        el("b", "", r.status),
        el("span", "p3-ell", `${t?.title ?? r.threadId.slice(0, 8)} · ${r.summary}`),
        el("span", "p3-n", ago(r.at)),
      )
      row.title = r.summary
      row.onclick = () => open(r.threadId)
      return row
    })
    const mark = el("button", "p3-digest-mark", "✓ Mark read")
    mark.onclick = () => (writeSeen((since = Date.now())), (reports = []), (rules = 0), render())
    const summary = el("summary", "p3-ell", `🗞 Since you last looked · ${head} · ${counts.join(" · ")}`)
    const list = el("div", "p3-digest-list")
    list.append(...(rows.length ? rows : [el("div", "p3-sub", "No new reports.")]))
    details.replaceChildren(summary, list, ...(rows.length || rules ? [mark] : []))
  }
  let gen = 0
  const load = () => {
    const mine = ++gen
    const from = since
    void Promise.all([
      runOr(json("/api/events?types=factory.report_up&perWorker=20", Schema.Array(StoredEvent)), []),
      runOr(json("/api/cos/ledger", LedgerAt), []),
    ]).then(([evs, ledger]) => {
      if (mine !== gen) return
      reports = evs.flatMap((e) => {
        const at = Date.parse(e.timestamp)
        const d = e.data as { threadId?: unknown; report?: { status?: unknown; summary?: unknown } } | null
        return at > from && typeof d?.threadId === "string"
          ? [
              {
                threadId: d.threadId,
                at,
                status: String(d.report?.status ?? ""),
                summary: String(d.report?.summary ?? ""),
              },
            ]
          : []
      })
      rules = ledger.filter((e) => e.at > from).length
      render()
    })
  }
  let timer: ReturnType<typeof setTimeout> | null = null
  const soon = () => (timer ??= setTimeout(() => ((timer = null), load()), 400))
  const offFeed = onFeed((ev) => (ev.type === RESYNC || ev.type === "factory.report_up") && soon())
  const offState = subscribe((st) => ((s = st), render()))
  load()
  // Leaving the CoS counts as a look: next time the digest starts from now.
  return () => (offFeed(), offState(), timer && clearTimeout(timer), (gen = -1), writeSeen(Date.now()))
}
