import "./diffview.css"
import { parseUnified, shortPath, toolDiffs, wordRanges, type DiffStyle, type FileDiff, type Line } from "./diff"
import { fire, send } from "./http"
// Colored file diffs for tool calls, shared by both UIs (plain DOM). Four styles. The setting `diffStyle` picks one
// (default terminal); the picker in any diff header and the settings drawer change it, and every diff redraws.
// `?diff=<style>` in the address overrides it for this page.

export const STYLES: Record<DiffStyle, string> = {
  terminal: "Terminal",
  gutter: "Gutter",
  split: "Split",
  github: "Review",
}
const isStyle = (s: string | null | undefined): s is DiffStyle => !!s && s in STYLES

let chosen: DiffStyle = "terminal"

export const currentStyle = (): DiffStyle => {
  const q = new URLSearchParams(location.search).get("diff")
  return isStyle(q) ? q : chosen
}

const live = new Map<HTMLElement, () => void>()

/** Hosts call this with `settings.diffStyle` whenever settings load or change. */
export const setDiffStyle = (s: DiffStyle): void => {
  if (s === chosen) return
  chosen = s
  for (const [host, draw] of live) {
    if (host.isConnected) draw()
    else live.delete(host)
  }
}

/** The user picked a style: redraw now, then save it as the setting (every open UI follows). */
export const pickDiffStyle = (s: DiffStyle): void => {
  setDiffStyle(s)
  fire(send("/api/settings", "PATCH", { diffStyle: s }))
}

/** Code to highlighted HTML. The host registers one (React: highlight.js); without it, lines are plain text. */
type Highlighter = (code: string, language: string) => string | null
let highlighter: Highlighter | null = null
export const setDiffHighlighter = (h: Highlighter): void => {
  highlighter = h
}

const LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  ini: "ini",
  md: "markdown",
  css: "css",
  scss: "scss",
  html: "xml",
  xml: "xml",
  svg: "xml",
  sql: "sql",
  lua: "lua",
}
const langOf = (path: string) => LANG[path.split(".").pop()?.toLowerCase() ?? ""] ?? ""

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** One code line: syntax colors, or word marks over plain text when `marks` is given (marks win, they carry the change). */
const code = (text: string, lang: string, marks?: [number, number][]): HTMLElement => {
  const c = el("span", "dv-code")
  if (marks?.length && marks.some(([a, b]) => b - a < text.length)) {
    let at = 0
    for (const [a, b] of marks) {
      if (a > at) c.append(text.slice(at, a))
      c.append(el("mark", "", text.slice(a, b)))
      at = b
    }
    if (at < text.length) c.append(text.slice(at))
    return c
  }
  const html = lang && highlighter ? highlighter(text, lang) : null
  if (html !== null) c.innerHTML = html
  else c.textContent = text
  if (!text) c.textContent = " "
  return c
}

/** Word marks for each del/add pair inside a changed block (n-th removed line pairs with n-th added line). */
const pairMarks = (lines: readonly Line[]): Map<Line, [number, number][]> => {
  const out = new Map<Line, [number, number][]>()
  for (let s = 0; s < lines.length;) {
    if (lines[s]!.kind !== "del") {
      s++
      continue
    }
    let m = s
    while (m < lines.length && lines[m]!.kind === "del") m++
    let e = m
    while (e < lines.length && lines[e]!.kind === "add") e++
    for (let k = 0; k < Math.min(m - s, e - m); k++) {
      const d = lines[s + k]!
      const a = lines[m + k]!
      const r = wordRanges(d.text, a.text)
      out.set(d, r.del)
      out.set(a, r.add)
    }
    s = e
  }
  return out
}

const SIGN = { add: "+", del: "-", ctx: " ", gap: "" } as const
const VERB = { created: "Created", edited: "Edited", deleted: "Deleted" } as const
/** Lines shown before "show all". */
const CAP = 24

const picker = (): HTMLElement => {
  const s = el("select", "dv-pick")
  s.title = "Diff style (prototype)"
  for (const [k, label] of Object.entries(STYLES)) {
    const o = el("option", "", label)
    o.value = k
    s.append(o)
  }
  s.value = currentStyle()
  s.onchange = () => pickDiffStyle(s.value as DiffStyle)
  s.onclick = (e) => e.stopPropagation()
  return s
}

const stats = (f: FileDiff, blocks: boolean): HTMLElement => {
  const s = el("span", "dv-stats")
  s.append(el("span", "dv-plus", `+${f.added}`), el("span", "dv-minus", `-${f.removed}`))
  if (blocks) {
    // Five squares split by the share of added and removed lines, like a GitHub file header.
    const total = f.added + f.removed || 1
    const g = Math.round((f.added / total) * 5)
    const r = Math.min(5 - g, Math.round((f.removed / total) * 5))
    const bar = el("span", "dv-bar")
    for (let i = 0; i < 5; i++) bar.append(el("i", i < g ? "add" : i < g + r ? "del" : ""))
    s.append(bar)
  }
  return s
}

const header = (f: FileDiff, style: DiffStyle, toggle?: () => void): HTMLElement => {
  const h = el("div", "dv-head")
  if (toggle) {
    const b = el("button", "dv-fold", "▾")
    b.type = "button"
    b.onclick = toggle
    h.append(b)
  }
  const name = el("span", "dv-path", style === "github" ? shortPath(f.path, 6) : shortPath(f.path))
  name.title = f.path
  h.append(el("span", `dv-verb dv-${f.op}`, VERB[f.op]), name, stats(f, style === "github"), picker())
  return h
}

/** Unified rows (terminal, gutter, github). */
const unifiedRows = (f: FileDiff, style: DiffStyle, lines: readonly Line[]): HTMLElement => {
  const lang = langOf(f.path)
  const marks = style === "terminal" ? new Map() : pairMarks(f.lines)
  const body = el("div", "dv-rows")
  for (const l of lines) {
    const r = el("div", `dv-row ${l.kind}`)
    if (l.kind === "gap") {
      r.append(el("span", "dv-gap", "⋯"))
      body.append(r)
      continue
    }
    if (style === "github")
      r.append(el("span", "dv-num", l.old?.toString() ?? ""), el("span", "dv-num", l.new?.toString() ?? ""))
    else r.append(el("span", "dv-num", (l.kind === "del" ? l.old : (l.new ?? l.old))?.toString() ?? ""))
    r.append(el("span", "dv-sign", SIGN[l.kind]), code(l.text, lang, marks.get(l)))
    body.append(r)
  }
  return body
}

/** Side-by-side rows: removed lines on the left, added on the right, paired inside each changed block. */
const splitRows = (f: FileDiff, lines: readonly Line[]): HTMLElement => {
  const lang = langOf(f.path)
  const marks = pairMarks(f.lines)
  const body = el("div", "dv-rows dv-splitrows")
  const cell = (l: Line | undefined, side: "old" | "new") => {
    const c = el("div", `dv-cell ${l?.kind ?? "empty"}`)
    if (!l) return c
    c.append(el("span", "dv-num", (side === "old" ? l.old : l.new)?.toString() ?? ""), code(l.text, lang, marks.get(l)))
    return c
  }
  for (let i = 0; i < lines.length;) {
    const l = lines[i]!
    if (l.kind === "gap") {
      const g = el("div", "dv-row gap")
      g.append(el("span", "dv-gap", "⋯"))
      body.append(g)
      i++
    } else if (l.kind === "ctx") {
      body.append(cell(l, "old"), cell(l, "new"))
      i++
    } else {
      const dels: Line[] = []
      const adds: Line[] = []
      while (i < lines.length && lines[i]!.kind === "del") dels.push(lines[i++]!)
      while (i < lines.length && lines[i]!.kind === "add") adds.push(lines[i++]!)
      for (let k = 0; k < Math.max(dels.length, adds.length); k++)
        body.append(cell(dels[k], "old"), cell(adds[k], "new"))
    }
  }
  return body
}

const fileView = (f: FileDiff, style: DiffStyle, cap = CAP): HTMLElement => {
  const box = el("div", `dv-file dv-${style}`)
  let all = false
  let folded = false
  const draw = () => {
    const shown = all ? f.lines : f.lines.slice(0, cap)
    const parts: HTMLElement[] = [header(f, style, style === "github" ? () => ((folded = !folded), draw()) : undefined)]
    if (!folded && f.lines.length) {
      parts.push(style === "split" ? splitRows(f, shown) : unifiedRows(f, style, shown))
      if (f.lines.length > cap) {
        const more = el("button", "dv-more", all ? "Show less" : `… +${f.lines.length - cap} lines (show all)`)
        more.type = "button"
        more.onclick = () => ((all = !all), draw())
        parts.push(more)
      }
    }
    box.toggleAttribute("data-folded", folded)
    box.replaceChildren(...parts)
  }
  draw()
  return box
}

/** Fill `host` with the diffs and keep it in step with the chosen style. `cap`: lines shown before "show all". */
export const renderDiffs = (
  host: HTMLElement,
  files: readonly FileDiff[],
  { cap = CAP }: { cap?: number } = {},
): void => {
  const draw = () => {
    const style = currentStyle()
    host.className = `dv dv-style-${style}`
    host.replaceChildren(...files.map((f) => fileView(f, style, cap)))
  }
  draw()
  live.set(host, draw)
}

/** A new element showing `files`. */
export const diffView = (files: readonly FileDiff[]): HTMLElement => {
  const host = el("div")
  renderDiffs(host, files)
  return host
}

/** A small edit with removed, added and unchanged lines, shown in the settings drawer next to the style choice. */
const SAMPLE = `--- a/src/greet.ts
+++ b/src/greet.ts
@@ -1,9 +1,10 @@
 import { log } from "./log"

-export function greet(name) {
-  const text = "Hello " + name
+export function greet(name: string, excited = false): string {
+  const text = \`Hello \${name}\${excited ? "!" : "."}\`
   log(text)
-  return undefined
+  return text
 }

-greet("world")
+greet("world", true)
`

/** A new element with the sample diff in the current style. */
export const diffPreview = (): HTMLElement => diffView(parseUnified(SAMPLE))

const parseArgs = (raw: string): unknown => {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/**
 * Fill every `[data-sf-tool]` slot on the page with the file diffs of its tool call, now and as slots come and go.
 * The slot holds `{name, args, result}` as JSON (args: the raw argument string). Used by the Foldkit chat, whose
 * patched agent-interface timeline renders the slots (web-foldkit/patches).
 */
export const startToolDiffs = (): void => {
  const drawn = new WeakMap<HTMLElement, string>()
  const fill = (slot: HTMLElement) => {
    const raw = slot.dataset.sfTool ?? ""
    if (drawn.get(slot) === raw) return
    drawn.set(slot, raw)
    let files: FileDiff[] = []
    try {
      const t = JSON.parse(raw) as { name: string; args: string; result: string }
      files = toolDiffs(t.name, parseArgs(t.args), t.result)
    } catch {}
    // Draw into a child: Foldkit owns the slot's own attributes.
    slot.replaceChildren(...(files.length ? [diffView(files)] : []))
  }
  /** Slots in or under one node. */
  const slotsIn = (node: Node): HTMLElement[] =>
    node instanceof HTMLElement
      ? [...(node.matches("[data-sf-tool]") ? [node] : []), ...node.querySelectorAll<HTMLElement>("[data-sf-tool]")]
      : []
  // Only the changed nodes are checked: a scan of the whole page on every DOM change cost each chat render.
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "attributes" && r.target instanceof HTMLElement) fill(r.target)
      else r.addedNodes.forEach((n) => slotsIn(n).forEach(fill))
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-sf-tool"] })
  document.querySelectorAll<HTMLElement>("[data-sf-tool]").forEach(fill)
}
