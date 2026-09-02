/**
 * Pure filter/sort/view-state selectors over `AdminProfileEntry[]` for the
 * Admin table screen. None of these functions perform I/O or call
 * `CommandRunner` — search/filter/sort must never re-run discovery or
 * doctor commands (see plan Functional Requirements).
 */
import type { AdminProfileEntry } from "./admin-model.js"

export type AdminSortKey = "name" | "launcher" | "surface" | "health" | "install"
export type AdminSortDirection = "asc" | "desc"

export type AdminViewState = "discovering" | "empty-no-profiles" | "empty-no-match" | "ready"

const normalize = (value: string): string => value.toLocaleLowerCase("en")

/** Case-insensitive substring match against name, description, launcher, and harness. */
export const filterAdminProfiles = (
  entries: ReadonlyArray<AdminProfileEntry>,
  query: string,
): ReadonlyArray<AdminProfileEntry> => {
  const trimmed = query.trim()
  if (trimmed.length === 0) return entries
  const needle = normalize(trimmed)
  return entries.filter((entry) =>
    [entry.name, entry.description, entry.launcher ?? "", entry.harness ?? "", entry.surface].some((field) =>
      normalize(field).includes(needle),
    ),
  )
}

const compareBy = (key: AdminSortKey) => (a: AdminProfileEntry, b: AdminProfileEntry): number => {
  const left = key === "launcher" ? (a.launcher ?? a.surface) : a[key]
  const right = key === "launcher" ? (b.launcher ?? b.surface) : b[key]
  return normalize(String(left)).localeCompare(normalize(String(right)))
}

/** Stable sort: ties preserve the input's relative order. Reversible by direction. */
export const sortAdminProfiles = (
  entries: ReadonlyArray<AdminProfileEntry>,
  sortKey: AdminSortKey,
  direction: AdminSortDirection,
): ReadonlyArray<AdminProfileEntry> => {
  const indexed = entries.map((entry, index) => ({ entry, index }))
  const compare = compareBy(sortKey)
  indexed.sort((left, right) => {
    const primary = compare(left.entry, right.entry)
    const oriented = direction === "asc" ? primary : -primary
    return oriented !== 0 ? oriented : left.index - right.index
  })
  return indexed.map(({ entry }) => entry)
}

/**
 * Resolves one of four distinguishable states: still discovering, no
 * profiles were discovered at all, profiles exist but none match the
 * current filter, or a normal ready table.
 */
export const resolveAdminViewState = (
  entries: ReadonlyArray<AdminProfileEntry>,
  filtered: ReadonlyArray<AdminProfileEntry>,
  loading: boolean,
): AdminViewState => {
  if (loading) return "discovering"
  if (entries.length === 0) return "empty-no-profiles"
  if (filtered.length === 0) return "empty-no-match"
  return "ready"
}
