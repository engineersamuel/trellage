import "./decisions.css"
import { answer, fetchOne, runApprovals, subscribeApprovals, type Approvals, type Decision } from "./approvals"
// Decision center shared by both UIs. Plain DOM, mounted once per page, like the extension host.
// It makes pending decisions (approvals and questions) impossible to miss and quick to answer:
//   - a pulsing inbox pill and the tab title show the count at all times
//   - a toast and a desktop notification announce each new decision
//   - the deep link <page>#decision=<id> opens the decision card directly
//   - the card shows the context, a formatted summary, and one large button per option
// Opening a decision also asks the host UI to open its conversation (window event "sf:open-thread").

const HASH = /^#decision=([\w-]+)$/
// Read-only views of the shared Effect store (shared/approvals.ts); only the store writes them.
let pending: ReadonlyArray<Decision> = []
let recent: ReadonlyArray<Decision> = []
const INBOX = /^#decisions$/
/** Minutes after which a waiting decision is shown as urgent (red). */
const URGENT_MIN = 10
const announced = new Set<string>()
let root: HTMLElement

/** Escape, then format a small safe markdown subset: headings, bullets, bold, italics, code, links. */
export const markdown = (src: string): string => {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  const out: string[] = []
  let list: "ul" | "ol" | null = null
  const close = () => list && (out.push(`</${list}>`), (list = null))
  for (const line of src.split("\n")) {
    const b = line.match(/^\s*[-*]\s+(.*)/), n = line.match(/^\s*\d+[.)]\s+(.*)/), h = line.match(/^#{1,4}\s+(.*)/)
    if (b || n) {
      const want = b ? "ul" : "ol"
      if (list !== want) (close(), out.push(`<${want}>`), (list = want))
      out.push(`<li>${inline((b ?? n)![1]!)}</li>`)
    } else {
      close()
      if (h) out.push(`<h4>${inline(h[1]!)}</h4>`)
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`)
    }
  }
  close()
  return out.join("")
}

/** Shadow mode: Jev's predicted answer, shown next to the human's choice. */
const shadowLine = (d: Decision): string => {
  if (d.shadow === undefined) return d.status === "pending" ? "Jev is predicting your answer…" : ""
  if (!d.shadow?.pick) return d.shadow === null ? "Jev prediction unavailable." : ""
  const s = d.shadow
  const verdict = d.status === "pending" ? "" : d.answer === s.pick ? " · matched your answer ✓" : " · you chose differently ✗"
  return `Shadow mode · Jev would pick “${s.pick}” (${Math.round(s.confidence * 100)}% sure; instructions cover this: ${Math.round(s.covered * 100)}%)${verdict}`
}

const ago = (t: number) => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", html = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html) e.innerHTML = html
  return e
}

const link = (d: Decision) => `${location.origin}${location.pathname}#decision=${d.id}`
const openDecision = (id: string) => (location.hash = `decision=${id}`)
const closeDecision = () => {
  // replaceState does not fire hashchange, so re-render here.
  history.replaceState(null, "", location.pathname + location.search)
  void renderCard()
}

const icon = (d: Decision) => (d.kind === "question" ? "?" : "✓")
const label = (d: Decision) => (d.kind === "question" ? "Question for you" : "Approval needed")

// ---------- pill + title ----------

/** Keep "(N) Decision needed" in the tab title, also after the host UI rewrites the title. */
const applyTitle = () => {
  const bare = document.title.replace(/^\(\d+\) Decision needed · /, "")
  const want = pending.length ? `(${pending.length}) Decision needed · ${bare}` : bare
  if (document.title !== want) document.title = want
}

/** Tab icon: a red badge with the waiting count, or the page's own icon when none waits. */
let baseIcon: string | null = null
const applyFavicon = () => {
  let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']")
  if (!link) (link = el("link")), (link.rel = "icon"), document.head.append(link)
  baseIcon ??= link.href || ""
  if (!pending.length) return void (link.href = baseIcon)
  const c = el("canvas")
  c.width = c.height = 64
  const g = c.getContext("2d")!
  g.fillStyle = Date.now() - Math.min(...pending.map((d) => d.createdAt)) > URGENT_MIN * 60_000 ? "#ef4444" : "#f59e0b"
  g.beginPath(), g.arc(32, 32, 30, 0, Math.PI * 2), g.fill()
  g.fillStyle = "#000", g.font = "bold 40px system-ui", g.textAlign = "center", g.textBaseline = "middle"
  g.fillText(pending.length > 9 ? "9+" : String(pending.length), 32, 35)
  link.href = c.toDataURL()
}

const renderPill = () => {
  const pill = root.querySelector<HTMLElement>(".sfd-pill")!
  applyTitle()
  applyFavicon()
  pill.hidden = pending.length === 0
  if (!pending.length) return
  const first = pending[0]!
  pill.innerHTML = ""
  const oldest = Math.min(...pending.map((d) => d.createdAt))
  pill.classList.toggle("sfd-urgent", Date.now() - oldest > URGENT_MIN * 60_000)
  const main = el("button", "sfd-pill-main", `<span class="sfd-dot"></span><b>${pending.length}</b> decision${pending.length > 1 ? "s" : ""} waiting · ${ago(oldest)} <span class="sfd-pill-go">Review →</span>`)
  main.title = "Open the oldest decision (Alt+D)"
  main.onclick = () => openDecision(first.id)
  const all = el("button", "sfd-pill-bell", "☰")
  all.title = "All decisions"
  all.onclick = () => (location.hash = "decisions")
  pill.append(main, all)
  if ("Notification" in window && Notification.permission === "default") {
    const bell = el("button", "sfd-pill-bell", "🔔")
    bell.title = "Enable desktop alerts for new decisions"
    bell.onclick = () => Notification.requestPermission().then(renderPill)
    pill.append(bell)
  }
}

// ---------- toast + desktop notification ----------

/** Two short soft tones, made in the browser (no audio file). Silent until the page had a user gesture. */
const chime = () => {
  try {
    const ac = new AudioContext()
    ;[880, 1320].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain()
      o.frequency.value = f
      g.gain.setValueAtTime(0.0001, ac.currentTime + i * 0.12)
      g.gain.exponentialRampToValueAtTime(0.08, ac.currentTime + i * 0.12 + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + i * 0.12 + 0.25)
      o.connect(g).connect(ac.destination)
      o.start(ac.currentTime + i * 0.12)
      o.stop(ac.currentTime + i * 0.12 + 0.3)
    })
  } catch {}
}

const announce = (d: Decision) => {
  chime()
  const toast = el("div", `sfd-toast sfd-${d.kind}`)
  toast.innerHTML = `<span class="sfd-icon">${icon(d)}</span><div><div class="sfd-toast-kind">${label(d)}</div><div class="sfd-toast-title"></div></div>`
  toast.querySelector(".sfd-toast-title")!.textContent = d.title
  const go = el("button", "sfd-btn sfd-primary", "Review now")
  go.onclick = () => (openDecision(d.id), toast.remove())
  const x = el("button", "sfd-x", "✕")
  x.onclick = () => toast.remove()
  toast.append(go, x)
  root.querySelector(".sfd-toasts")!.append(toast)
  setTimeout(() => toast.classList.add("sfd-in"), 10)
  setTimeout(() => toast.remove(), 30_000)
  if ("Notification" in window && Notification.permission === "granted" && document.visibilityState !== "visible") {
    const n = new Notification(`${label(d)}: ${d.title}`, { body: d.summary.replace(/[*`#]/g, "").slice(0, 160), tag: d.id })
    n.onclick = () => (window.focus(), openDecision(d.id), n.close())
  }
}

// ---------- decision card ----------

let renderSeq = 0
const renderCard = async () => {
  const seq = ++renderSeq
  const host = root.querySelector<HTMLElement>(".sfd-modal")!
  if (INBOX.test(location.hash)) return renderInbox(host)
  const m = location.hash.match(HASH)
  if (!m) return void (host.hidden = true)
  const res = await runApprovals(fetchOne(m[1]!)).then((d) => ({ ok: true as const, d }), () => ({ ok: false as const }))
  // A newer render started while this one waited (hash changed or answered): let it win.
  if (seq !== renderSeq) return
  host.hidden = false
  host.innerHTML = ""
  const backdrop = el("div", "sfd-backdrop")
  backdrop.onclick = closeDecision
  const card = el("div", "sfd-card")
  host.append(backdrop, card)
  if (!res.ok) {
    card.innerHTML = `<h2>Decision not found</h2><p class="sfd-muted">It may have been removed. </p>`
    return
  }
  const d = res.d
  if (d.threadId) window.dispatchEvent(new CustomEvent("sf:open-thread", { detail: d.threadId }))
  const done = d.status !== "pending"
  card.classList.add(`sfd-${d.kind}`)
  card.innerHTML = `
    <div class="sfd-head">
      <span class="sfd-icon sfd-big">${icon(d)}</span>
      <div class="sfd-headtext">
        <div class="sfd-kind">${done ? "Answered" : label(d)}</div>
        <h2 class="sfd-title"></h2>
        <div class="sfd-meta"></div>
      </div>
      <button class="sfd-x" title="Close (Esc)">✕</button>
    </div>
    <div class="sfd-summary">${markdown(d.summary)}</div>
    <div class="sfd-shadow"></div>
    <div class="sfd-answer"></div>`
  card.querySelector(".sfd-title")!.textContent = d.title
  card.querySelector(".sfd-meta")!.textContent = [d.context ?? "coordinator", ago(d.createdAt), d.threadTitle ? `conversation “${d.threadTitle}”` : ""].filter(Boolean).join(" · ")
  card.querySelector<HTMLButtonElement>(".sfd-x")!.onclick = closeDecision
  card.querySelector(".sfd-shadow")!.textContent = shadowLine(d)
  const answerBox = card.querySelector<HTMLElement>(".sfd-answer")!
  if (done) {
    answerBox.innerHTML = `<div class="sfd-done">✓ Answered: <b></b><div class="sfd-muted"></div></div>`
    answerBox.querySelector("b")!.textContent = d.answer ?? ""
    answerBox.querySelector(".sfd-done .sfd-muted")!.textContent = d.note ? `Note: ${d.note}` : ""
    return
  }
  const opts = el("div", "sfd-options")
  const text = el("textarea", "sfd-text") as HTMLTextAreaElement
  text.placeholder = d.allowText ? "Or type your own answer…" : "Optional note for the coordinator"
  const err = el("div", "sfd-error")
  const send = async (choice: string, note: string | null) => {
    card.classList.add("sfd-sending")
    // The store drops the decision from pending at once (the pill updates); the feed event confirms it.
    const failed = await runApprovals(answer(d.id, choice, note)).then(() => null, (e: { reason?: string }) => e.reason ?? String(e))
    card.classList.remove("sfd-sending")
    if (failed) return void (err.textContent = failed)
    answerBox.innerHTML = `<div class="sfd-done">✓ Sent. The coordinator continues.</div>`
    const next = pending.find((p) => p.id !== d.id)
    setTimeout(() => (next ? openDecision(next.id) : closeDecision()), 900)
  }
  d.options.forEach((o, i) => {
    const b = el("button", `sfd-option${i === 0 ? " sfd-recommended" : ""}`)
    const jev = d.shadow?.pick === o
    b.innerHTML = `<kbd>${i + 1}</kbd><span class="sfd-opt-label"></span>${i === 0 ? '<em>Recommended</em>' : ""}${jev ? `<span class="sfd-jev">Jev ${Math.round(d.shadow!.confidence * 100)}%</span>` : ""}<small></small>`
    b.querySelector(".sfd-opt-label")!.textContent = o
    b.querySelector("small")!.textContent = d.optionDetails?.[i] ? `→ ${d.optionDetails[i]}` : ""
    b.onclick = () => send(o, d.allowText ? null : text.value.trim() || null)
    opts.append(b)
  })
  answerBox.append(opts, text)
  if (d.allowText) {
    const submit = el("button", "sfd-btn sfd-primary", "Send answer")
    submit.onclick = () => text.value.trim() && send(text.value.trim(), null)
    answerBox.append(submit)
  }
  answerBox.append(err)
  const more = pending.filter((p) => p.id !== d.id).length
  if (more) answerBox.append(el("div", "sfd-muted", `${more} more decision${more > 1 ? "s" : ""} after this one.`))
  const copy = el("button", "sfd-link", "Copy link to this decision")
  copy.onclick = () => navigator.clipboard?.writeText(link(d)).then(() => (copy.textContent = "Link copied"))
  answerBox.append(copy)
  card.onkeydown = (e) => {
    if (e.target === text) return
    const i = Number(e.key) - 1
    if (d.options[i]) send(d.options[i]!, text.value.trim() || null)
  }
  card.tabIndex = -1
  card.focus()
}

// ---------- inbox ----------

const row = (d: Decision) => {
  const r = el("button", `sfd-row sfd-${d.kind}${d.status === "pending" ? " sfd-row-pending" : ""}`)
  r.innerHTML = `<span class="sfd-icon">${icon(d)}</span><span class="sfd-row-main"><b></b><span class="sfd-muted"></span></span><span class="sfd-row-state"></span>`
  r.querySelector("b")!.textContent = d.title
  r.querySelector(".sfd-row-main .sfd-muted")!.textContent = `${d.context ?? "coordinator"} · ${ago(d.createdAt)}`
  const jev = d.status !== "pending" && d.shadow?.pick ? (d.shadow.pick === d.answer ? " · Jev ✓" : ` · Jev ✗ (${d.shadow.pick})`) : ""
  r.querySelector(".sfd-row-state")!.textContent = d.status === "pending" ? "Waiting" : `✓ ${d.answer}${jev}`
  r.onclick = () => openDecision(d.id)
  return r
}

const renderInbox = (host: HTMLElement) => {
  host.hidden = false
  host.innerHTML = ""
  const backdrop = el("div", "sfd-backdrop")
  backdrop.onclick = closeDecision
  const card = el("div", "sfd-card sfd-inbox")
  card.innerHTML = `<div class="sfd-head"><span class="sfd-icon sfd-big">☰</span><div class="sfd-headtext"><div class="sfd-kind">Decision inbox</div><h2 class="sfd-title"></h2><div class="sfd-meta">Newest first. Click a row to open it.</div></div><button class="sfd-x" title="Close (Esc)">✕</button></div>`
  card.querySelector(".sfd-title")!.textContent = pending.length ? `${pending.length} waiting for you` : "Nothing waiting. You are all caught up."
  card.querySelector<HTMLButtonElement>(".sfd-x")!.onclick = closeDecision
  const list = el("div", "sfd-rows")
  for (const d of [...pending].reverse()) list.append(row(d))
  const done = recent.filter((d) => d.status !== "pending").slice(-15).reverse()
  if (done.length) list.append(el("div", "sfd-kind sfd-rows-head", "Recently answered"))
  for (const d of done) list.append(row(d))
  card.append(list)
  host.append(backdrop, card)
}

// ---------- data ----------

let loaded = false
/** Called by the store with every new approvals list. */
const onApprovals = (a: Approvals) => {
  const first = !loaded
  loaded = a.loaded
  const changed = a.all !== recent
  recent = a.all
  pending = a.pending
  for (const d of pending) {
    if (announced.has(d.id)) continue
    announced.add(d.id)
    // On first load only alert for decisions younger than a minute; the pill covers the rest.
    if (Date.now() - d.createdAt < 60_000) announce(d)
  }
  renderPill()
  // A new list (answered elsewhere, Jev's prediction, a feed gap): re-render what is open.
  if (changed && !first && (HASH.test(location.hash) || INBOX.test(location.hash))) void renderCard()
}

/** Mount once per page. */
export const startDecisionCenter = (): void => {
  if (document.querySelector(".sfd-root")) return
  root = el("div", "sfd-root")
  root.innerHTML = `<div class="sfd-pill" hidden></div><div class="sfd-toasts"></div><div class="sfd-modal" hidden></div>`
  document.body.append(root)
  new MutationObserver(applyTitle).observe(document.head, { subtree: true, childList: true, characterData: true })
  window.addEventListener("hashchange", () => void renderCard())
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && (HASH.test(location.hash) || INBOX.test(location.hash))) closeDecision()
    // Alt+D: jump to the oldest waiting decision, or the inbox when none waits.
    if (e.altKey && e.code === "KeyD") (e.preventDefault(), pending[0] ? openDecision(pending[0].id) : (location.hash = "decisions"))
  })
  setInterval(renderPill, 30_000)
  subscribeApprovals(onApprovals)
  void renderCard()
}
