/**
 * Pure filter/sort/view-state selectors over `AdminProfileEntry[]` for the
 * Admin table screen. None of these functions perform I/O or call
 * `CommandRunner` — search/filter/sort must never re-run discovery or
 * doctor commands (see plan Functional Requirements).
 */
import type { AdminVersionColumns } from "./admin-version-check.ts"
import type { AdminProfileEntry } from "./admin-model.ts"
import type { AdminStatus } from "./admin-status.ts"
import { statusLabel } from "./admin-status.ts"

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

/** The user-facing profile "Type" column value: every profile is either an isolated container (Sandbox) or a native host process. */
export type AdminProfileType = "Native" | "Container"

export const adminProfileType = (entry: AdminProfileEntry): AdminProfileType =>
  entry.surface === "native" ? "Native" : "Container"

export interface AdminTableColumnWidths {
  readonly harness: number
  readonly name: number
  readonly type: number
  readonly status: number
  readonly version: number
  readonly latestVersion: number
}

const longest = (values: ReadonlyArray<string>, heading: string): number =>
  Math.max(heading.length, ...values.map((value) => value.length))

const bounded = (value: number, minimum: number, maximum: number): number => Math.max(minimum, Math.min(value, maximum))

/**
 * Computes fixed column widths for the `Harness | Profile Name | Type |
 * Status` table, bounded to the terminal width using the same
 * longest-value-plus-heading, percentage-capped approach as the
 * single-profile picker's `table-layout.ts:tableColumns` (kept separate
 * since the Admin table has a different, fixed column set). Every column
 * reserves at least enough width for its own header. The status column
 * additionally reserves two characters so a `[running]` row's spinner
 * glyph never shifts the column boundary.
 */
export const adminTableColumnWidths = (
  entries: ReadonlyArray<AdminProfileEntry>,
  statusesByRef: ReadonlyMap<string, AdminStatus>,
  terminalWidth: number,
  versionColumnsByRef: ReadonlyMap<string, AdminVersionColumns> = new Map(),
): AdminTableColumnWidths => {
  const available = Math.max(40, terminalWidth - 4)
  const harness = bounded(
    longest(
      entries.map((entry) => entry.harness ?? "—"),
      "HARNESS",
    ) + 2,
    8,
    Math.max(8, Math.floor(available * 0.18)),
  )
  const type = bounded(
    longest(
      entries.map((entry) => adminProfileType(entry)),
      "TYPE",
    ) + 2,
    8,
    11,
  )
  const statusLabels = entries.map((entry) => statusLabel(statusesByRef.get(entry.ref) ?? "idle"))
  const status = bounded(longest(statusLabels, "STATUS") + 4, 14, Math.max(14, Math.floor(available * 0.42)))
  const installedLabels = entries.map((entry) => versionColumnsByRef.get(entry.ref)?.installed ?? "—")
  const version = bounded(longest(installedLabels, "VERSION") + 2, 9, Math.max(9, Math.floor(available * 0.16)))
  const latestLabels = entries.map((entry) => versionColumnsByRef.get(entry.ref)?.latest ?? "—")
  const latestVersion = bounded(longest(latestLabels, "LATEST VERSION") + 2, 14, Math.max(14, Math.floor(available * 0.2)))
  const name = Math.max(10, available - harness - type - status - version - latestVersion)
  return { harness, name, type, status, version, latestVersion }
}
