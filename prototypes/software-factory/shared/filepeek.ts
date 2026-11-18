// Quick look for local paths in cards: an inline code span whose text is an absolute (or ~/) path gets a 👁 button
// when the coordinator confirms the path exists in a folder it may show (/api/files/peek). The button opens the file
// (markdown rendered, code highlighted, images shown) or the folder listing in a modal. Plain DOM, both UIs.
import { Schema } from "effect"
import { fileHtml, openModal } from "./diffview"
import { json, runOr } from "./http"
import { imageUrl } from "./toolcard"

const Peek = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literals(["image", "text", "binary", "dir"]),
  size: Schema.optional(Schema.Number),
  text: Schema.optional(Schema.String),
  entries: Schema.optional(Schema.Array(Schema.String)),
  truncated: Schema.optional(Schema.Boolean),
})
type Peek = typeof Peek.Type

/** A local path as an agent writes it: absolute or ~/, no spaces, an optional :line[:col] end. */
const PATH = /^(?:~\/|\/)[^\s`'"<>|*?]+$/
export const looksLikePath = (text: string): boolean => PATH.test(text) && text.length > 2 && !text.startsWith("//")

const peekUrl = (file: string, content: boolean) =>
  `/api/files/peek?path=${encodeURIComponent(file)}${content ? "&content=1" : ""}`
const peek = (file: string, content: boolean): Promise<Peek | null> => runOr(json(peekUrl(file, content), Peek), null)

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const kb = (n = 0) => (n < 1024 ? `${n} B` : `${Math.round(n / 1024)} kB`)

export const openPeek = async (file: string): Promise<void> => {
  const p = await peek(file, true)
  if (!p) return
  const name = p.path.split("/").filter(Boolean).pop() ?? p.path
  if (p.kind === "dir")
    return openModal(
      `${name}/`,
      p.truncated ? "First 200 entries" : null,
      `<pre>${esc((p.entries ?? []).join("\n"))}</pre>`,
      p.path,
    )
  if (p.kind === "image")
    return openModal(name, kb(p.size), `<img src="${esc(imageUrl(p.path))}" alt="${esc(name)}">`, p.path)
  if (p.kind === "binary") return openModal(name, kb(p.size), "<p>Binary file: no preview.</p>", p.path)
  return openModal(
    name,
    p.truncated ? `First 256 kB of ${kb(p.size)}` : kb(p.size),
    fileHtml(p.path, p.text ?? ""),
    p.path,
  )
}

/** Existence per path, asked once per page. */
const known = new Map<string, Promise<boolean>>()
const exists = (file: string) => {
  let r = known.get(file)
  if (!r) known.set(file, (r = peek(file, false).then((p) => p !== null)))
  return r
}

const decorate = async (code: HTMLElement) => {
  if (code.dataset.sfPeek || code.closest("pre, .dv, .dv-preview")) return
  const file = code.textContent?.trim() ?? ""
  code.dataset.sfPeek = "checked"
  if (!looksLikePath(file) || !(await exists(file))) return
  if (code.nextElementSibling?.classList.contains("sf-peek")) return
  const b = document.createElement("button")
  b.type = "button"
  b.className = "sf-peek"
  b.textContent = "👁"
  b.title = `Quick look: ${file}`
  b.setAttribute("aria-label", `Quick look at ${file}`)
  b.onclick = (e) => (e.preventDefault(), e.stopPropagation(), void openPeek(file))
  code.after(b)
}

/** Watch the page: each inline code span added or changed is checked once. */
export const startFilePeek = (): void => {
  const codesIn = (node: Node): HTMLElement[] =>
    node instanceof HTMLElement
      ? [...(node.matches("code") ? [node] : []), ...node.querySelectorAll<HTMLElement>("code")]
      : node.parentElement?.closest("code")
        ? [node.parentElement.closest("code") as HTMLElement]
        : []
  new MutationObserver((records) => {
    for (const r of records) {
      // Streaming text changes a span after it was checked: check it again.
      if (r.type === "characterData") codesIn(r.target).forEach((c) => (delete c.dataset.sfPeek, void decorate(c)))
      else r.addedNodes.forEach((n) => codesIn(n).forEach((c) => void decorate(c)))
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true })
  document.querySelectorAll<HTMLElement>("code").forEach((c) => void decorate(c))
}
