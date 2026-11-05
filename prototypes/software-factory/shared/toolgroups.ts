// Runs of read-only tool calls fold into one expandable row, like "Read 9 files, searched 2 times".
// Writes, shell commands, failures and other items always keep their own row.

const KIND: Record<string, "read" | "search" | "list"> = {
  view: "read",
  read: "read",
  read_file: "read",
  glob: "search",
  grep: "search",
  rg: "search",
  search: "search",
  ls: "list",
  list_directory: "list",
}
/** Shortest run that folds; two calls in a row stay as they are. */
export const MIN_GROUP = 3

type Tool = { kind: "tool"; name: string; done: boolean; ok: boolean }
export type Group<T> = { kind: "group"; id: string; items: T[]; label: string; done: boolean }

const foldable = (i: { kind: string; name?: string; ok?: boolean }): boolean =>
  i.kind === "tool" && !!KIND[i.name ?? ""] && i.ok !== false

export const groupLabel = (items: readonly Tool[]): string => {
  const n = { read: 0, search: 0, list: 0 }
  for (const i of items) n[KIND[i.name]!]++
  const parts = [
    n.read && `Read ${n.read} file${n.read > 1 ? "s" : ""}`,
    n.search && `searched ${n.search} time${n.search > 1 ? "s" : ""}`,
    n.list && `listed ${n.list} folder${n.list > 1 ? "s" : ""}`,
  ].filter(Boolean) as string[]
  const s = parts.join(", ")
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** Replace each run of MIN_GROUP or more read-only tool calls with one group. Order is kept. */
export const groupTools = <T extends { kind: string; id?: string; name?: string; done?: boolean; ok?: boolean }>(items: readonly T[]): (T | Group<T>)[] => {
  const out: (T | Group<T>)[] = []
  let run: T[] = []
  const flush = () => {
    if (run.length >= MIN_GROUP)
      out.push({ kind: "group", id: `g:${run[0]!.id}`, items: run, label: groupLabel(run as unknown as Tool[]), done: run.every((i) => i.done) })
    else out.push(...run)
    run = []
  }
  for (const i of items) {
    if (foldable(i)) run.push(i)
    else (flush(), out.push(i))
  }
  flush()
  return out
}
