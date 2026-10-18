#!/usr/bin/env bun
import { loadRunCatalog, type RunCatalog, type RunCatalogProfile } from "./run-catalog.ts"

export interface RunListHarness {
  readonly harness: string
  readonly canonical: boolean
  readonly presets: ReadonlyArray<string>
  readonly profiles: ReadonlyArray<string>
}

export type RunListProfile = Omit<RunCatalogProfile, "skills">

export interface RunListDocument {
  readonly schemaVersion: 2
  readonly harnesses: ReadonlyArray<RunListHarness>
  readonly profiles: ReadonlyArray<RunListProfile>
}

const profileApplies = (profile: RunCatalogProfile, harness: string): boolean =>
  profile.harnesses === null || profile.harnesses.includes(harness)

export const buildRunList = (catalog: RunCatalog): RunListDocument => ({
  schemaVersion: 2,
  harnesses: catalog.harnesses.map(({ harness }) => ({
    harness,
    canonical: harness !== "fx" && harness !== "headlong",
    presets: catalog.presetsByHarness[harness] ?? [],
    profiles: [
      ...new Set([
        ...(catalog.presetsByHarness[harness] ?? []),
        ...catalog.profileEntries.filter((profile) => profileApplies(profile, harness)).map((profile) => profile.name),
      ]),
    ].sort(),
  })),
  profiles: catalog.profileEntries.map(({ skills: _skills, ...profile }) => profile),
})

const renderTable = (headers: ReadonlyArray<string>, rows: ReadonlyArray<ReadonlyArray<string>>): string => {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  )
  return [headers, ...rows]
    .map((row) => row.map((value, column) => value.padEnd(widths[column] ?? value.length)).join("  ").trimEnd())
    .join("\n")
}

export const formatRunList = (document: RunListDocument): string => {
  const harnesses = renderTable(
    ["HARNESS", "BUILT-IN PRESETS"],
    document.harnesses.map((entry) => [entry.harness, entry.presets.length === 0 ? "-" : entry.presets.join(", ")]),
  )
  const profiles = renderTable(
    ["PROFILE", "APPLIES TO", "MODE", "KIND"],
    document.profiles.map((entry) => [
      entry.name,
      entry.harnesses === null ? "all" : entry.harnesses.join(", "),
      entry.always ? "always" : "optional",
      entry.kind,
    ]),
  )
  return `${harnesses}\n\n${profiles}`
}

export const main = async (argv: ReadonlyArray<string> = process.argv.slice(2)): Promise<number> => {
  if (argv.some((argument) => argument !== "--json") || argv.filter((argument) => argument === "--json").length > 1) {
    process.stderr.write("trx list accepts only --json\n")
    return 2
  }
  const document = buildRunList(await loadRunCatalog({ includeModels: false }))
  process.stdout.write(argv[0] === "--json" ? `${JSON.stringify(document)}\n` : `${formatRunList(document)}\n`)
  return 0
}

if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    process.stderr.write(`trx list: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
