import "./toolcard.css"
// Tool Call Card and Tool Call Group, ported to plain DOM from affectUI
// (MIT, https://www.affectui.com/components/tool-call-card). Same markup, classes and behavior,
// without React: a card is built once and then patched, so its CSS animations play only when
// its state changes. One shared timer updates the live durations of running calls.

export type CardStatus = "running" | "success" | "error"

export type CardInput = {
  id: string
  name: string
  summary: string
  icon: SVGSVGElement
  status: CardStatus
  args: unknown
  /** Undefined while the call runs. */
  result?: unknown
  error?: string
  startedAt?: number
  endedAt?: number
  /** The worker or decision the call points to, shown as a link at the top of the body. */
  link?: HTMLElement
}

export type GroupInput = { id: string; label: string; cards: readonly CardInput[] }

const SVG_NS = "http://www.w3.org/2000/svg"
const CODE_CAP = 220
const OPEN_MAX = 640

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

type Shape = readonly [tag: string, attrs: Record<string, string>]
const svg = (cls: string, viewBox: string, shapes: readonly Shape[]): SVGSVGElement => {
  const s = document.createElementNS(SVG_NS, "svg")
  if (cls) s.setAttribute("class", cls)
  s.setAttribute("viewBox", viewBox)
  s.setAttribute("aria-hidden", "true")
  for (const [tag, attrs] of shapes) {
    const c = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) c.setAttribute(k, v)
    s.append(c)
  }
  return s
}
const path = (d: string, extra: Record<string, string> = {}): Shape => ["path", { d, ...extra }]

const ok = () => svg("ui-tcc__ok", "0 0 16 16", [["circle", { cx: "8", cy: "8", r: "7" }], path("M5.1 8.2 7.1 10.1 10.9 6", { pathLength: "1" })])
const errIcon = () => svg("ui-tcc__err", "0 0 16 16", [["circle", { cx: "8", cy: "8", r: "7" }], path("M8 4.9v3.5M8 10.9v.1")])
const spinner = () => svg("ui-tcc__spinner", "0 0 16 16", [["circle", { cx: "8", cy: "8", r: "6" }], path("M8 2a6 6 0 0 1 6 6")])
const chevron = () => svg("ui-tcc__chevron", "0 0 12 12", [path("M3.5 5.25 6 7.75l2.5-2.5")])

/** 16px stroke glyphs for the tool tile. */
const ICONS = {
  wrench: [path("M10.2 2.4a3.5 3.5 0 0 0-4.3 4.6L2.6 10.3a1.4 1.4 0 0 0 2 2L7.9 9a3.5 3.5 0 0 0 4.6-4.3l-2 2-1.6-.4-.4-1.6 1.7-2.3Z")],
  search: [["circle", { cx: "7", cy: "7", r: "4.5" }], path("M10.5 10.5 14 14")],
  file: [path("M9 1.75H4.5A1.25 1.25 0 0 0 3.25 3v10a1.25 1.25 0 0 0 1.25 1.25h7A1.25 1.25 0 0 0 12.75 13V5.5L9 1.75Z"), path("M9 1.75V5.5h3.75"), path("M5.75 8.5h4.5M5.75 11h4.5")],
  folder: [path("M2 4.25A1.25 1.25 0 0 1 3.25 3h3l1.5 1.75h5A1.25 1.25 0 0 1 14 6v5.75A1.25 1.25 0 0 1 12.75 13h-9.5A1.25 1.25 0 0 1 2 11.75Z")],
  terminal: [path("M2.75 3h10.5a.75.75 0 0 1 .75.75v8.5a.75.75 0 0 1-.75.75H2.75a.75.75 0 0 1-.75-.75v-8.5A.75.75 0 0 1 2.75 3Z"), path("M4.75 6.25 6.5 8l-1.75 1.75M8 10h3")],
  pencil: [path("M10.75 2.75l2.5 2.5L6 12.5l-3.25.75.75-3.25Z")],
  worker: [["circle", { cx: "8", cy: "5.5", r: "2.5" }], path("M3 13.5a5 5 0 0 1 10 0")],
  mail: [path("M2.5 4h11v8h-11Z"), path("M2.5 4.5 8 8.75l5.5-4.25")],
  ask: [["circle", { cx: "8", cy: "8", r: "6" }], path("M6.4 6.2a1.7 1.7 0 0 1 3.2.8c0 1.2-1.6 1.5-1.6 2.5M8 11.4v.1")],
  globe: [["circle", { cx: "8", cy: "8", r: "6" }], path("M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6s-.8 4.3-2.6 6c-1.8-1.7-2.6-3.7-2.6-6S6.2 3.7 8 2Z")],
} satisfies Record<string, readonly Shape[]>

const ICON_OF: Record<string, keyof typeof ICONS> = {
  read: "file", view: "file", read_file: "file",
  grep: "search", glob: "search", rg: "search", search: "search",
  ls: "folder", list_directory: "folder",
  bash: "terminal", read_bash: "terminal", stop_bash: "terminal", shell: "terminal",
  edit: "pencil", write: "pencil", create: "pencil", apply_patch: "pencil", str_replace_editor: "pencil",
  spawn_worker: "worker", read_worker: "worker", stop_worker: "worker", list_workers: "worker", agent: "worker", task: "worker",
  message_worker: "mail", message_conversation: "mail", report_up: "mail",
  request_approval: "ask", ask_user: "ask",
  web_fetch: "globe", fetch: "globe", web_search: "globe",
}

/** The glyph for a tool; unknown tools get a wrench, like affectUI. */
export const toolIcon = (name: string): SVGSVGElement => svg("", "0 0 16 16", ICONS[ICON_OF[name.toLowerCase()] ?? "wrench"])

/** 0.4s, 12.3s, 2m 05s, 3h 12m, 2d 4h – the live timer always shows tenths below a minute */
export const formatMs = (ms: number, live: boolean): string => {
  if (!live && ms < 1000) return `${Math.max(1, Math.round(ms))}ms`
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`
  const s = Math.floor(ms / 1000)
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`
  const h = Math.floor(s / 3600)
  if (h < 24) return `${h}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** Objects are pretty-printed, JSON strings parsed, other text shown as is. */
export const toText = (value: unknown): { text: string; json: boolean } => {
  if (typeof value === "string") {
    const t = value.trim()
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return { text: JSON.stringify(JSON.parse(t), null, 2), json: true }
      } catch {
        /* not JSON – shown as plain text */
      }
    }
    return { text: value, json: false }
  }
  try {
    const s = JSON.stringify(value, null, 2)
    return s === undefined ? { text: String(value), json: false } : { text: s, json: true }
  } catch {
    return { text: String(value), json: false }
  }
}

// Strings (keys when followed by a colon), literals and numbers – everything else stays punctuation
const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g

/** JSON text as text nodes and token spans. */
export const highlight = (text: string): Node[] => {
  const out: Node[] = []
  const re = new RegExp(TOKEN.source, "g")
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(document.createTextNode(text.slice(last, m.index)))
    if (m[1] && m[2]) out.push(el("span", "ui-tcc__t-key", m[1]), document.createTextNode(m[2]))
    else out.push(el("span", `ui-tcc__t-${m[1] ? "str" : /^[tfn]/.test(m[0]) ? "lit" : "num"}`, m[0]))
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(document.createTextNode(text.slice(last)))
  return out
}

const copyText = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Older browsers and non-secure contexts
    const area = el("textarea")
    area.value = text
    area.style.cssText = "position:fixed;opacity:0"
    document.body.appendChild(area)
    area.select()
    const done = document.execCommand("copy")
    area.remove()
    return done
  }
}

const copyButton = (text: string, label: string): HTMLButtonElement => {
  const b = el("button", "ui-tcc__copy")
  b.type = "button"
  const idle = () => {
    delete b.dataset.copied
    b.ariaLabel = b.title = `Copy ${label}`
  }
  idle()
  b.append(
    svg("ui-tcc__copy-icon", "0 0 16 16", [["rect", { x: "5.5", y: "5.5", width: "8.5", height: "8.5", rx: "2" }], path("M10.5 3.75v-.25A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h.25")]),
    svg("ui-tcc__copy-done", "0 0 16 16", [path("M3.5 8.4 6.6 11.3 12.5 4.9", { pathLength: "1" })]),
  )
  let timer = 0
  b.onclick = () =>
    void copyText(text).then((done) => {
      if (!done) return
      b.dataset.copied = ""
      b.ariaLabel = b.title = "Copied"
      clearTimeout(timer)
      timer = window.setTimeout(idle, 1400)
    })
  return b
}

/** "Arguments" or "Result": a label, a copy button and the code, capped with a fade and "Show all". */
const codeSection = (label: string, value: unknown): HTMLElement => {
  const { text, json } = toText(value)
  const section = el("div", "ui-tcc__section")
  const head = el("div", "ui-tcc__section-head")
  head.append(el("span", "ui-tcc__label", label), copyButton(text, label.toLowerCase()))
  const pre = el("pre", "ui-tcc__code")
  const code = el("code")
  code.append(...(json ? highlight(text) : [document.createTextNode(text)]))
  pre.append(code)
  const more = el("button", "ui-tcc__more")
  more.type = "button"
  section.append(head, pre)
  let full = false
  let height = 0
  const apply = () => {
    const capped = height > CODE_CAP + 24
    pre.toggleAttribute("data-capped", capped && !full)
    pre.toggleAttribute("data-scroll", capped && full && height > OPEN_MAX)
    pre.style.maxHeight = capped ? `${full ? Math.min(height, OPEN_MAX) : CODE_CAP}px` : ""
    more.textContent = full ? "Show less" : "Show all"
    more.ariaExpanded = String(full)
    if (capped) section.append(more)
    else more.remove()
  }
  more.onclick = () => ((full = !full), apply())
  // Natural height of the block decides whether it needs the cap and how far "Show all" opens.
  new ResizeObserver(() => {
    if (pre.scrollHeight === height) return
    height = pre.scrollHeight
    apply()
  }).observe(code)
  return section
}

let uid = 0

/** One tool call. Build once with `create`, then call `update` with each new state. */
export class ToolCard {
  readonly el = el("div", "ui-tcc")
  private readonly head = el("button", "ui-tcc__head")
  private readonly iconBox = el("span", "ui-tcc__icon")
  private readonly nameEl = el("code", "ui-tcc__name")
  private readonly summaryEl = el("span", "ui-tcc__summary")
  private readonly announce = el("span", "ui-tcc-sr")
  private readonly sections = el("div", "ui-tcc__sections")
  private readonly body = el("div", "ui-tcc__body")
  private statusEl: HTMLElement | null = null
  private timeEl: HTMLElement | null = null
  private bodyKey = ""
  private autoOpened = false
  card!: CardInput

  constructor(card: CardInput, private readonly opts: { isOpen: (id: string) => boolean; setOpen: (id: string, open: boolean) => void; touched: Set<string> }) {
    const id = `ui-tcc-${++uid}`
    this.announce.role = "status"
    this.announce.ariaLive = "polite"
    this.head.type = "button"
    this.head.setAttribute("aria-controls", `${id}-body`)
    this.summaryEl.dir = "auto"
    const main = el("span", "ui-tcc__main")
    main.append(this.nameEl, this.summaryEl)
    this.iconBox.ariaHidden = "true"
    this.head.append(this.iconBox, main, chevron())
    this.head.onclick = () => {
      this.autoOpened = false
      this.opts.touched.add(this.card.id)
      this.setOpen(!this.isOpen())
    }
    this.body.id = `${id}-body`
    const clip = el("div", "ui-tcc__clip")
    clip.append(this.sections)
    this.body.append(clip)
    this.el.append(this.announce, this.head, this.body)
    this.update(card)
  }

  private isOpen = () => this.opts.isOpen(this.card.id)
  private setOpen(open: boolean) {
    this.opts.setOpen(this.card.id, open)
    this.el.toggleAttribute("data-open", open)
    this.head.ariaExpanded = String(open)
    this.body.inert = !open
  }

  update(card: CardInput): void {
    const prev = this.card
    this.card = card
    const { status, name } = card
    if (prev?.icon !== card.icon) this.iconBox.replaceChildren(card.icon.cloneNode(true))
    this.nameEl.textContent = this.nameEl.title = name
    this.summaryEl.textContent = this.summaryEl.title = card.summary
    this.summaryEl.hidden = !card.summary
    this.el.dataset.status = status
    this.announce.textContent = status === "running" ? `${name} running` : status === "success" ? `${name} finished` : `${name} failed${card.error ? `: ${card.error}` : ""}`
    if (prev?.status !== status) {
      // A new status element per status, so its entrance animation plays again.
      const s = el("span", "ui-tcc__status")
      this.timeEl = el("span", "ui-tcc__time")
      s.append(status === "running" ? spinner() : status === "success" ? ok() : errIcon(), this.timeEl)
      if (this.statusEl) this.statusEl.replaceWith(s)
      else this.head.insertBefore(s, this.head.lastChild)
      this.statusEl = s
      // Open on failure, close again on the next run – only while nobody has toggled it by hand.
      if (!this.opts.touched.has(card.id)) {
        if (status === "error" && !this.isOpen()) {
          this.autoOpened = true
          this.opts.setOpen(card.id, true)
        } else if (prev?.status === "error" && this.autoOpened) {
          this.autoOpened = false
          this.opts.setOpen(card.id, false)
        }
      }
    }
    this.tick()
    this.setOpen(this.isOpen())
    const key = JSON.stringify([status, card.error, card.args, card.result, !!card.link])
    if (key === this.bodyKey) return
    this.bodyKey = key
    this.renderBody()
  }

  /** Elapsed ms: live while running, final once done. Undefined when the start is unknown. */
  ms(now = Date.now()): number | undefined {
    const { startedAt, endedAt, status } = this.card
    if (startedAt === undefined) return undefined
    return Math.max(0, (status === "running" ? now : (endedAt ?? now)) - startedAt)
  }

  tick(now = Date.now()): void {
    const { status } = this.card
    const ms = this.ms(now)
    if (this.timeEl) this.timeEl.textContent = status === "error" ? "Failed" : ms === undefined ? "" : formatMs(ms, status === "running")
  }

  private renderBody(): void {
    const { status, error, args, result, link } = this.card
    const parts: HTMLElement[] = []
    if (link) parts.push(link)
    if (status === "error") {
      const box = el("div", "ui-tcc__error")
      box.append(errIcon(), el("p", "ui-tcc__error-text", error || "The tool call failed."))
      box.lastElementChild!.setAttribute("dir", "auto")
      parts.push(box)
    }
    if (args !== undefined) parts.push(codeSection("Arguments", args))
    if (result !== undefined) parts.push(codeSection("Result", result))
    else if (status === "running") {
      const s = el("div", "ui-tcc__section")
      const h = el("div", "ui-tcc__section-head")
      h.append(el("span", "ui-tcc__label", "Result"))
      s.append(h, el("p", "ui-tcc__pending", "Waiting for result…"))
      parts.push(s)
    }
    if (args === undefined && result === undefined && status === "success") parts.push(el("p", "ui-tcc__pending", "No arguments or result."))
    this.sections.replaceChildren(...parts)
  }
}

/** Several calls folded into one quiet line: stacked icons, a label and the total time. */
export class ToolGroup {
  readonly el = el("div", "ui-tcc-group")
  private readonly head = el("button", "ui-tcc-group__head")
  private readonly stack = el("span", "ui-tcc-group__stack")
  private readonly announce = el("span", "ui-tcc-sr")
  readonly list = el("div", "ui-tcc-group__list")
  private readonly body = el("div", "ui-tcc__body")
  private titleEl: HTMLElement | null = null
  private timeEl: HTMLElement | null = null
  private titleKey = ""
  private stackKey = ""
  private group!: GroupInput
  private cards: readonly ToolCard[] = []

  constructor(group: GroupInput, private readonly opts: { isOpen: (id: string) => boolean; setOpen: (id: string, open: boolean) => void }) {
    const id = `ui-tcc-${++uid}`
    this.announce.role = "status"
    this.announce.ariaLive = "polite"
    this.head.type = "button"
    this.head.setAttribute("aria-controls", `${id}-list`)
    this.stack.ariaHidden = "true"
    this.head.append(this.stack, chevron())
    this.head.onclick = () => this.setOpen(!this.opts.isOpen(this.group.id))
    this.body.id = `${id}-list`
    const clip = el("div", "ui-tcc__clip")
    clip.append(this.list)
    this.body.append(clip)
    this.el.append(this.announce, this.head, this.body)
    this.group = group
  }

  private setOpen(open: boolean) {
    this.opts.setOpen(this.group.id, open)
    this.el.toggleAttribute("data-open", open)
    this.head.ariaExpanded = String(open)
    this.body.inert = !open
  }

  private running = () => this.group.cards.some((c) => c.status === "running")

  update(group: GroupInput, cards: readonly ToolCard[]): void {
    this.group = group
    this.cards = cards
    const running = this.running()
    this.el.toggleAttribute("data-running", running)
    const n = group.cards.length
    const failed = group.cards.filter((c) => c.status === "error").length
    const count = `Used ${n.toLocaleString("en-US")} ${n === 1 ? "tool" : "tools"}`
    this.announce.textContent = running ? "Using tools…" : `${count}${failed ? `, ${failed} failed` : ""}`
    const icons = cards.slice(-3)
    const stackKey = `${n}:${icons.map((c) => c.card.name).join()}`
    if (stackKey !== this.stackKey) {
      // Keyed by position from the end, like affectUI: only a new icon pops in.
      this.stackKey = stackKey
      this.stack.replaceChildren(
        ...icons.map((c) => {
          const tile = el("span", "ui-tcc__icon")
          tile.append(c.card.icon.cloneNode(true))
          return tile
        }),
      )
    }
    const title = running ? "Using tools…" : group.label
    const titleKey = JSON.stringify([running, title, failed])
    if (titleKey !== this.titleKey) {
      this.titleKey = titleKey
      const t = el("span", "ui-tcc-group__title")
      const label = el("span", running ? "ui-tcc-group__label ui-tcc__shine" : "ui-tcc-group__label", title)
      label.dataset.text = title
      t.append(label)
      if (!running && failed > 0) t.append(el("span", "ui-tcc-group__failed", `· ${failed} failed`))
      this.timeEl = el("span", "ui-tcc-group__time")
      t.append(this.timeEl)
      if (this.titleEl) this.titleEl.replaceWith(t)
      else this.head.insertBefore(t, this.head.lastChild)
      this.titleEl = t
    }
    this.tick()
    this.setOpen(this.opts.isOpen(group.id))
  }

  /** Total time: the sum of the cards' durations, the running one counted live. */
  tick(now = Date.now()): void {
    if (!this.timeEl) return
    const times = this.cards.map((c) => c.ms(now))
    const known = times.filter((t): t is number => t !== undefined)
    this.timeEl.textContent = known.length ? `· ${formatMs(known.reduce((a, b) => a + b, 0), this.running())}` : ""
    this.timeEl.hidden = !known.length
  }
}

/** Put `nodes` into `parent` in order, moving only nodes that are out of place, so kept nodes keep their animations. */
export const reconcile = (parent: HTMLElement, nodes: readonly Node[]): void => {
  const keep = new Set(nodes)
  // A copy: removing from the live childNodes list while iterating it would skip nodes.
  for (const c of Array.from(parent.childNodes)) if (!keep.has(c)) c.remove()
  nodes.forEach((n, i) => {
    const at = parent.childNodes[i]
    if (at !== n) parent.insertBefore(n, at ?? null)
  })
}
