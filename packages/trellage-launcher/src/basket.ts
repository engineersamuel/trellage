/**
 * The composer's pure layer. It holds no fixtures and renders nothing, so both
 * the fixture preview and the real guide queue can measure and summarize a
 * block of held text the same way.
 */

/** `3 lines`, but `1 line`. */
export const countLabel = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`

export const countTextLines = (text: string): number => (text.length === 0 ? 0 : text.split("\n").length)

/** How many source lines of each block a list shows before it truncates. */
export const previewBlockLines = 2

export interface BasketBlockPreview {
  readonly lines: ReadonlyArray<string>
  readonly truncated: boolean
}

/** Cuts one line to the list width, marking the cut with an ellipsis. */
const clipLine = (line: string, width: number): string => {
  const limit = Math.max(1, width)
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`
}

/**
 * Summarizes a held block with its first few non-blank source lines, each cut
 * to the list width. The summary never wraps: wrapping breaks a word in half
 * and destroys the column alignment of a pasted table, and the whole block is
 * one keystroke away in the viewer.
 */
export const basketBlockPreview = (
  text: string,
  width: number,
  limit: number = previewBlockLines,
): BasketBlockPreview => {
  const source = text.split("\n").filter((line) => line.trim().length > 0)
  const kept = source.slice(0, Math.max(1, limit))
  return {
    lines: kept.map((line) => clipLine(line, width)),
    truncated: source.length > kept.length || kept.some((line) => line.length > Math.max(1, width)),
  }
}

/**
 * Picks the run of blocks to show so the selected one is always on screen.
 * The list scrolls by whole blocks, so a block never appears half-drawn.
 */
export const basketVisibleRange = (
  heights: ReadonlyArray<number>,
  cursor: number,
  capacity: number,
): { readonly start: number; readonly end: number } => {
  if (heights.length === 0) return { start: 0, end: 0 }
  const index = Math.max(0, Math.min(cursor, heights.length - 1))
  let start = index
  let end = index + 1
  let used = heights[index] ?? 0
  while (start > 0 && used + (heights[start - 1] ?? 0) <= capacity) {
    start -= 1
    used += heights[start] ?? 0
  }
  while (end < heights.length && used + (heights[end] ?? 0) <= capacity) {
    used += heights[end] ?? 0
    end += 1
  }
  return { start, end }
}
