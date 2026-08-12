import type { LaunchEntry } from "./state.js"

export interface TableColumns {
  readonly profile: number
  readonly harness: number
  readonly sandbox: number
  readonly model: number
}

const longest = (values: ReadonlyArray<string>, heading: string): number =>
  Math.max(heading.length, ...values.map((value) => value.length))

const bounded = (value: number, minimum: number, maximum: number): number =>
  Math.max(minimum, Math.min(value, maximum))

export const tableColumns = (
  entries: ReadonlyArray<LaunchEntry>,
  terminalWidth: number,
): TableColumns => {
  const available = Math.max(30, terminalWidth - 6)
  const profile = bounded(
    longest(entries.map(({ profile }) => profile), "PROFILE") + 2,
    12,
    Math.max(12, Math.floor(available * 0.42)),
  )
  const harness = bounded(
    longest(entries.map(({ harness }) => harness), "HARNESS") + 2,
    10,
    Math.max(10, Math.floor(available * 0.25)),
  )
  // Only reserve a SANDBOX column when at least one entry actually declares
  // a sandbox status; catalogs that never set it (e.g. Trellage Sandbox,
  // where every profile is implicitly Docker-isolated) omit the column.
  const sandbox = entries.some((entry) => entry.sandbox !== undefined) ? "SANDBOX".length + 2 : 0
  return {
    profile,
    harness,
    sandbox,
    model: Math.max(8, available - profile - harness - sandbox),
  }
}
