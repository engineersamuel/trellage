// File changes made by a tool call, as line diffs. Pure: no DOM, so the coordinator, both UIs and tests share it.
// Sources, best first: a unified diff in the result (Copilot SDK `detailedContent`, Claude `structuredPatch`,
// a `git diff` in bash output), a Codex `apply_patch` patch, then the edit arguments (old/new text, file content).

/** Diff looks a user can pick (setting `diffStyle`). */
export const DIFF_STYLES = ["terminal", "gutter", "split", "github"] as const
export type DiffStyle = (typeof DIFF_STYLES)[number]

export type Line = { kind: "add" | "del" | "ctx" | "gap"; text: string; old?: number; new?: number }
export type FileDiff = { path: string; op: "created" | "edited" | "deleted"; lines: Line[]; added: number; removed: number }

const file = (path: string, op: FileDiff["op"], lines: Line[]): FileDiff => ({
  path,
  op,
  lines,
  added: lines.filter((l) => l.kind === "add").length,
  removed: lines.filter((l) => l.kind === "del").length,
})

const splitLines = (s: string): string[] => {
  const out = s.split("\n")
  if (out.at(-1) === "") out.pop()
  return out
}

/** True when `text` holds a unified diff. */
export const hasUnified = (text: string): boolean => /^(diff --git |--- \S.*\n\+\+\+ \S)/m.test(text)

const stripAB = (p: string) => p.replace(/^[ab]\//, "").replace(/\t.*$/, "")

/** Parse every file of a unified diff (git or plain). Text before the first file is ignored. */
export const parseUnified = (text: string): FileDiff[] => {
  const out: FileDiff[] = []
  let cur: { path: string; op: FileDiff["op"]; lines: Line[] } | null = null
  let o = 0
  let n = 0
  let left = 0 // old + new lines still due in this hunk
  let inHunk = false
  const flush = () => cur && (cur.lines.length || cur.op !== "edited") && out.push(file(cur.path, cur.op, cur.lines))
  for (const raw of text.split("\n")) {
    const git = raw.match(/^diff --git a\/(.*) b\/(.*)$/)
    if (git) {
      flush()
      cur = { path: git[2]!, op: "edited", lines: [] }
      inHunk = false
      continue
    }
    if (!inHunk && raw.startsWith("--- ")) {
      // A plain diff (no "diff --git" line) starts at "---".
      if (cur?.lines.length) flush(), (cur = null)
      if (!cur) cur = { path: "", op: "edited", lines: [] }
      if (raw === "--- /dev/null") cur.op = "created"
      else if (!cur.path) cur.path = stripAB(raw.slice(4))
      continue
    }
    if (!cur) continue
    if (!inHunk && raw.startsWith("+++ ")) {
      if (raw === "+++ /dev/null") cur.op = "deleted"
      else cur.path = stripAB(raw.slice(4))
      continue
    }
    if (raw.startsWith("new file mode")) cur.op = "created"
    else if (raw.startsWith("deleted file mode")) cur.op = "deleted"
    const h = raw.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
    if (h) {
      if (cur.lines.length) cur.lines.push({ kind: "gap", text: "" })
      o = Number(h[1])
      n = Number(h[3])
      left = Number(h[2] ?? 1) + Number(h[4] ?? 1)
      inHunk = left > 0
      continue
    }
    if (!inHunk) continue
    const c = raw[0]
    if (c === "+") cur.lines.push({ kind: "add", text: raw.slice(1), new: n++ }), (left -= 1)
    else if (c === "-") cur.lines.push({ kind: "del", text: raw.slice(1), old: o++ }), (left -= 1)
    else if (c === " " || raw === "") cur.lines.push({ kind: "ctx", text: raw.slice(1), old: o++, new: n++ }), (left -= 2)
    else if (c !== "\\") left = 0
    inHunk = left > 0
  }
  flush()
  return out
}

/** Parse a Codex `apply_patch` patch ("*** Begin Patch" … "*** End Patch"). Line numbers are unknown. */
export const parsePatch = (text: string): FileDiff[] => {
  const out: FileDiff[] = []
  let cur: { path: string; op: FileDiff["op"]; lines: Line[] } | null = null
  const flush = () => cur && out.push(file(cur.path, cur.op, cur.lines))
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
    if (m) {
      flush()
      cur = { path: m[2]!.trim(), op: m[1] === "Add" ? "created" : m[1] === "Delete" ? "deleted" : "edited", lines: [] }
      continue
    }
    if (!cur) continue
    const move = raw.match(/^\*\*\* Move to: (.+)$/)
    if (move) cur.path = move[1]!.trim()
    else if (raw.startsWith("***")) continue
    else if (raw.startsWith("@@")) cur.lines.length && cur.lines.push({ kind: "gap", text: "" })
    else if (raw[0] === "+") cur.lines.push({ kind: "add", text: raw.slice(1), ...(cur.op === "created" ? { new: cur.lines.length + 1 } : {}) })
    else if (raw[0] === "-") cur.lines.push({ kind: "del", text: raw.slice(1) })
    else if (raw[0] === " ") cur.lines.push({ kind: "ctx", text: raw.slice(1) })
  }
  flush()
  return out
}

/** Line diff of two texts (LCS). Very large inputs fall back to "all removed, all added". */
export const lineDiff = (before: string, after: string): Line[] => {
  const a = splitLines(before)
  const b = splitLines(after)
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))]
  // lcs[i][j]: common length of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const out: Line[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) out.push({ kind: "ctx", text: a[i++]! }), j++
    else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.push({ kind: "add", text: b[j++]! })
    else out.push({ kind: "del", text: a[i++]! })
  }
  // Removed lines first inside each changed block, like git.
  for (let s = 0; s < out.length; s++) {
    if (out[s]!.kind === "ctx") continue
    let e = s
    while (e < out.length && out[e]!.kind !== "ctx") e++
    const block = out.slice(s, e)
    out.splice(s, e - s, ...block.filter((l) => l.kind === "del"), ...block.filter((l) => l.kind === "add"))
    s = e
  }
  return out
}

const created = (path: string, text: string): FileDiff => file(path, "created", splitLines(text).map((t, i) => ({ kind: "add", text: t, new: i + 1 })))

const EDIT_TOOLS = new Set(["edit", "multiedit", "str_replace_editor", "str_replace_based_edit_tool", "write", "create", "apply_patch", "notebookedit"])

/** The file changes of one tool call, or [] when it changed no file we can show. */
export const toolDiffs = (name: string, args: unknown, result: string | undefined): FileDiff[] => {
  if (result && hasUnified(result)) {
    // A read tool (Copilot `view`) reports the file it read as a diff of context lines only: that is no change.
    const d = parseUnified(result).filter((f) => f.op !== "edited" || f.added || f.removed)
    if (d.length) return d
  }
  const tool = name.toLowerCase()
  if (!EDIT_TOOLS.has(tool)) return []
  if (typeof args === "string") return parsePatch(args)
  if (typeof args !== "object" || args === null) return []
  const a = args as Record<string, unknown>
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined)
  const path = str("path") ?? str("file_path") ?? str("filePath") ?? ""
  const patch = str("input") ?? str("patch")
  if (tool === "apply_patch" && patch) return parsePatch(patch)
  const oldText = str("old_str") ?? str("old_string") ?? str("oldText")
  const newText = str("new_str") ?? str("new_string") ?? str("newText")
  if (oldText !== undefined && newText !== undefined) return [file(path, "edited", lineDiff(oldText, newText))]
  const edits = Array.isArray(a.edits) ? (a.edits as Record<string, unknown>[]) : null
  if (edits) {
    const lines = edits.flatMap((e, i) => {
      const o = e.oldText ?? e.old_string ?? e.old_str
      const nw = e.newText ?? e.new_string ?? e.new_str
      if (typeof o !== "string" || typeof nw !== "string") return []
      return [...(i ? [{ kind: "gap" as const, text: "" }] : []), ...lineDiff(o, nw)]
    })
    return lines.length ? [file(path, "edited", lines)] : []
  }
  const content = str("file_text") ?? str("content")
  if (content !== undefined && path) return [created(path, content)]
  return []
}

/** Changed character ranges of two paired lines, by word. Used to mark what changed inside a line. */
export const wordRanges = (before: string, after: string): { del: [number, number][]; add: [number, number][] } => {
  const tok = (s: string) => s.match(/\w+|\s+|[^\w\s]/g) ?? []
  const a = tok(before)
  const b = tok(after)
  if (a.length * b.length > 250_000) return { del: [[0, before.length]], add: [[0, after.length]] }
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const del: [number, number][] = []
  const add: [number, number][] = []
  const push = (r: [number, number][], from: number, len: number) => {
    const last = r.at(-1)
    if (last && last[1] === from) last[1] += len
    else r.push([from, from + len])
  }
  let i = 0
  let j = 0
  let pa = 0
  let pb = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) (pa += a[i++]!.length), (pb += b[j++]!.length)
    else if (j < b.length && (i === a.length || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) push(add, pb, b[j]!.length), (pb += b[j++]!.length)
    else push(del, pa, a[i]!.length), (pa += a[i++]!.length)
  }
  return { del, add }
}

/** Long absolute paths shortened to their last `keep` parts. */
export const shortPath = (p: string, keep = 4): string => {
  const parts = p.split("/").filter(Boolean)
  return parts.length > keep ? `…/${parts.slice(-keep).join("/")}` : p
}
