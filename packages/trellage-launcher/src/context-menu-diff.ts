import { diffLines, type Change } from "diff"
import stringWidth from "string-width"

export type ContextMenuView = "original" | "rewritten" | "diff"
export interface ContextMenuDiffRow {
  readonly original: string
  readonly rewritten: string
  readonly kind: "same" | "added" | "removed" | "changed"
}
const lines = (value: string): string[] => value.length === 0 ? [] : value.replace(/\n$/u, "").split("\n")
export const unifiedMarkdownDiff = (original: string, rewritten: string, budget = 200_000): ReadonlyArray<Change> => {
  const fallback: Change[] = [{ value: original, count: lines(original).length, removed: true, added: false }, { value: rewritten, count: lines(rewritten).length, removed: false, added: true }]
  if (original.length + rewritten.length > budget) return fallback
  return diffLines(original, rewritten, { maxEditLength: 2000, timeout: 40, ignoreNewlineAtEof: true }) ?? fallback
}
export const markdownDiffRows = (original: string, rewritten: string, budget = 200_000): ReadonlyArray<ContextMenuDiffRow> => {
  const rows: ContextMenuDiffRow[] = []
  let removed: string[] = []
  const flush = (added: string[]) => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      rows.push({ original: removed[i] ?? "", rewritten: added[i] ?? "", kind: i >= removed.length ? "added" : i >= added.length ? "removed" : "changed" })
    }
    removed = []
  }
  for (const change of unifiedMarkdownDiff(original, rewritten, budget)) {
    if (change.removed) removed.push(...lines(change.value))
    else if (change.added) flush(lines(change.value))
    else { flush([]); rows.push(...lines(change.value).map(line => ({ original: line, rewritten: line, kind: "same" as const }))) }
  }
  flush([])
  if (original.endsWith("\n") !== rewritten.endsWith("\n")) rows.push({ original: original.endsWith("\n") ? "" : "\\ No newline at end of file", rewritten: rewritten.endsWith("\n") ? "" : "\\ No newline at end of file", kind: "changed" })
  return rows
}
// Wrap raw Markdown by terminal cells before slicing the viewport. A single long
// source line can span many scrollable rows without breaking column alignment.
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const wrap = (value: string, width: number): string[] => {
  const result: string[] = []
  let line = "", used = 0
  for (const { segment } of segmenter.segment(value.replaceAll("\t", "    "))) {
    const size = stringWidth(segment)
    if (used + size > width && line.length > 0) { result.push(line); line = ""; used = 0 }
    line += segment; used += size
  }
  result.push(line)
  return result
}
export interface DiffDisplayLine { readonly left: string; readonly right?: string; readonly removed: boolean; readonly added: boolean }
export const diffColumnWidth = (width: number): number => Math.max(2, Math.floor((width - 3) / 2))
export const diffDisplayLines = (rows: ReadonlyArray<ContextMenuDiffRow>, width: number, sideBySide: boolean): ReadonlyArray<DiffDisplayLine> => {
  const output: DiffDisplayLine[] = []
  const column = diffColumnWidth(width)
  for (const row of rows) {
    const removed = row.kind === "removed" || row.kind === "changed"
    const added = row.kind === "added" || row.kind === "changed"
    if (sideBySide) {
      const left = row.kind === "added" ? [] : wrap(row.original, column - 2)
      const right = row.kind === "removed" ? [] : wrap(row.rewritten, column - 2)
      for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const cell = left[i] === undefined ? "" : `${removed ? "- " : "  "}${left[i]}`
        output.push({ left: cell + " ".repeat(Math.max(0, column - stringWidth(cell))), right: right[i] === undefined ? "" : `${added ? "+ " : "  "}${right[i]}`, removed, added })
      }
    } else {
      if (row.kind !== "added") for (const part of wrap(row.original, Math.max(1, width - 2))) output.push({ left: `${removed ? "- " : "  "}${part}`, removed, added: false })
      if (added) for (const part of wrap(row.rewritten, Math.max(1, width - 2))) output.push({ left: `+ ${part}`, removed: false, added: true })
    }
  }
  return output
}
