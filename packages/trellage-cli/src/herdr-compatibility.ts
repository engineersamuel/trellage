import { readFile } from "node:fs/promises"
import path from "node:path"

import { Effect } from "effect"

export type HerdrCompatibilityStatus = "verified" | "known-issue" | "untested"

export interface HerdrCompatibilityEntry {
  readonly status: HerdrCompatibilityStatus
  readonly issue?: string
  readonly notes?: string
}

interface LedgerRecord {
  readonly kind: "native" | "container"
  readonly launcher?: string
  readonly profile: string
  readonly harness?: string
  readonly status: HerdrCompatibilityStatus
  readonly issue?: string
  readonly notes?: string
}

interface Ledger {
  readonly schemaVersion: 1
  readonly lastUpdated: string
  readonly entries: ReadonlyArray<LedgerRecord>
}

const untested: HerdrCompatibilityEntry = { status: "untested" }

const toEntry = (record: LedgerRecord): HerdrCompatibilityEntry => ({
  status: record.status,
  ...(record.issue === undefined ? {} : { issue: record.issue }),
  ...(record.notes === undefined ? {} : { notes: record.notes }),
})

/**
 * Loads the hand-maintained Herdr compatibility ledger (`docs/herdr-compatibility.json`).
 * This is a curated signal, not a live probe: Trellage cannot detect Herdr-side
 * bugs (agent detection, consent-dialog handling, etc.) on its own, so this file
 * records the outcome of manual verification runs and must be refreshed by hand.
 * Returns `untested` (rather than failing) for any profile that has no ledger
 * entry, or if the ledger itself cannot be read/parsed.
 */
export const loadHerdrCompatibilityLedger = (repositoryRoot: string): Effect.Effect<Ledger, never> =>
  Effect.tryPromise({
    try: async () => {
      const raw = await readFile(path.join(repositoryRoot, "docs", "herdr-compatibility.json"), "utf8")
      return JSON.parse(raw) as Ledger
    },
    catch: (cause) => cause,
  }).pipe(Effect.orElseSucceed(() => ({ schemaVersion: 1 as const, lastUpdated: "", entries: [] })))

export const containerHerdrCompatibility = (ledger: Ledger, profileName: string): HerdrCompatibilityEntry => {
  const record = ledger.entries.find((entry) => entry.kind === "container" && entry.profile === profileName)
  return record === undefined ? untested : toEntry(record)
}

export const nativeHerdrCompatibility = (
  ledger: Ledger,
  launcher: string,
  profileName: string,
): HerdrCompatibilityEntry => {
  const record = ledger.entries.find(
    (entry) => entry.kind === "native" && entry.launcher === launcher && entry.profile === profileName,
  )
  return record === undefined ? untested : toEntry(record)
}
