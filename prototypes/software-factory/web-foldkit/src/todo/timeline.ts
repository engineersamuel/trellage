// Pure helpers for the Todo timeline: creation time, newest-first order, search, and date groups.
import type { Task, TodoList } from "./domain"

/** A TickTick id is a Mongo ObjectId: its first 8 hex digits are the creation time in seconds. */
export const createdAt = (id: string): number => {
  const seconds = Number.parseInt(id.slice(0, 8), 16)
  return Number.isFinite(seconds) ? seconds * 1000 : 0
}

/** Title text without markdown images; a link shows as its text. */
export const plain = (s: string): string =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()

/** A list name's leading emoji and the rest ("🇺🇸Microsoft" → ["🇺🇸", "Microsoft"]). */
export const splitEmoji = (name: string): readonly [string, string] => {
  const m = name.match(
    /^((?:[\u{1F1E6}-\u{1F1FF}]{2}|\p{Extended_Pictographic})(?:️|‍\p{Extended_Pictographic}|\p{Emoji_Modifier}|♂|♀)*)\s*(.*)$/u,
  )
  return m ? [m[1]!, m[2]!] : ["", name]
}

export type Row = {
  readonly task: Task
  readonly list: TodoList
  readonly title: string
  readonly hits: readonly number[]
}

/** The query split into its `@list` part and its words. */
export const parseQuery = (query: string): { readonly at: string; readonly words: readonly string[] } => {
  const at = /@(\S+)/.exec(query)?.[1]?.toLowerCase() ?? ""
  const words = query.replace(/@\S*/g, "").toLowerCase().split(/\s+/).filter(Boolean)
  return { at, words }
}

/** The list a `@name` in the query picks (first whose name contains it), if any. */
export const atList = (lists: readonly TodoList[], query: string): TodoList | undefined => {
  const { at } = parseQuery(query)
  return at ? lists.find((l) => l.name.toLowerCase().includes(at)) : undefined
}

/** Every word must appear in the title, in any order; returns the matched character positions. */
export const match = (title: string, words: readonly string[]): readonly number[] | undefined => {
  const lower = title.toLowerCase()
  const hits: number[] = []
  for (const w of words) {
    const k = lower.indexOf(w)
    if (k < 0) return undefined
    for (let i = 0; i < w.length; i++) hits.push(k + i)
  }
  return hits
}

/** Tasks in scope (one list, or all when `scope` is ""), matching the query, newest first. */
export const rows = (
  lists: readonly TodoList[],
  tasks: Readonly<Record<string, readonly Task[]>>,
  scope: string,
  query: string,
): readonly Row[] => {
  const picked = atList(lists, query)
  const inScope = picked ? [picked] : scope ? lists.filter((l) => l.id === scope) : lists
  const { words } = parseQuery(query)
  const out: Row[] = []
  for (const list of inScope)
    for (const task of tasks[list.id] ?? []) {
      const title = plain(task.title)
      const hits = match(title, words)
      if (hits) out.push({ task, list, title, hits })
    }
  return out.sort((a, b) => createdAt(b.task.id) - createdAt(a.task.id))
}

const DAY = 86_400_000

/** The timeline group of a creation time, relative to `now` (local midnight). */
export const bucket = (ms: number, now: number): string => {
  const today = new Date(now).setHours(0, 0, 0, 0)
  if (ms >= today) return "Today"
  if (ms >= today - DAY) return "Yesterday"
  if (ms >= today - 6 * DAY) return "This week"
  if (ms >= today - 30 * DAY) return "This month"
  return new Date(ms).toLocaleDateString("en-US", { month: "long", year: "numeric" })
}

/** Groups that always show every task. */
export const OPEN_GROUPS = ["Today", "Yesterday", "This week"]
export const GROUP_LIMIT = 10

/** Rows in timeline groups, newest group first. */
export const groups = (all: readonly Row[], now: number): readonly (readonly [string, readonly Row[]])[] => {
  const out = new Map<string, Row[]>()
  for (const r of all) {
    const name = bucket(createdAt(r.task.id), now)
    out.set(name, [...(out.get(name) ?? []), r])
  }
  return [...out]
}

/** Short age: 7m, 5h, 3d, 2mo, 1.4y. */
export const ago = (ms: number, now: number): string => {
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < DAY / 1000) return `${Math.round(s / 3600)}h`
  if (s < (30 * DAY) / 1000) return `${Math.round(s / 86400)}d`
  if (s < (365 * DAY) / 1000) return `${Math.round(s / 86400 / 30)}mo`
  return `${(s / 86400 / 365).toFixed(1)}y`
}

export const dateLabel = (ms: number): string =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })

export const PRIORITY: Readonly<Record<number, string>> = { 1: "low", 3: "medium", 5: "high" }
