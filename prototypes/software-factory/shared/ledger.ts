// The Chief of Staff rule ledger (ADR 0008): every action a rule took or refused, newest first.
import { Schema } from "effect"
import { json, runOr } from "./http"

const Entry = Schema.Struct({
  seq: Schema.Number,
  at: Schema.Number,
  rule: Schema.String,
  threadId: Schema.NullOr(Schema.String),
  action: Schema.String,
  result: Schema.String,
  detail: Schema.String,
})
const Entries = Schema.Array(Entry)

const FRESH_MS = 10_000

/** Mount the ledger table; refreshes every 10 s. `open` opens a conversation by thread id. */
export const mountLedger = (box: HTMLElement, open: (threadId: string) => void): (() => void) => {
  const draw = async () => {
    const rows = await runOr(json("/api/cos/ledger", Entries), null)
    if (!rows) return void box.replaceChildren("No ledger data.")
    if (!rows.length) return void box.replaceChildren("No rule has acted yet.")
    const t = document.createElement("table")
    t.className = "sf-cost sf-ledger"
    const head = document.createElement("tr")
    for (const h of ["Time", "Rule", "Action", "Result", "Detail"])
      head.append(Object.assign(document.createElement("th"), { textContent: h }))
    t.append(
      head,
      ...rows.map((e) => {
        const r = document.createElement("tr")
        r.className = `sf-ledger-${e.result}`
        const cells = [new Date(e.at).toLocaleString(), e.rule, e.action, e.result, e.detail]
        for (const c of cells) r.append(Object.assign(document.createElement("td"), { textContent: c }))
        if (e.threadId) {
          const id = e.threadId
          r.style.cursor = "pointer"
          r.title = "Open this conversation"
          r.onclick = () => open(id)
        }
        return r
      }),
    )
    box.replaceChildren(t)
  }
  void draw()
  const timer = setInterval(() => void draw(), FRESH_MS)
  return () => clearInterval(timer)
}
