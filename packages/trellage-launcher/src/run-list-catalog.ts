import type { RunCatalogSnapshot, RunHarnessEntry, RunProfileEntry } from "./run-catalog.ts"
import type { LocalReadiness } from "@trellage/runtime/native-run"

export type ListedHarness = Omit<RunHarnessEntry, "profiles" | "sandbox"> & { readonly sandbox: boolean | null }
export interface ListedProfile {
  readonly id: string
  readonly argument: string
  readonly selection: RunProfileEntry["selection"]
  readonly metadataStatus: RunProfileEntry["metadataStatus"]
  readonly harnesses: readonly string[]
  readonly readyHarnesses: readonly string[]
  readonly guideHarnesses: readonly string[]
  readonly readiness: LocalReadiness
  readonly guideEligibility: RunProfileEntry["guideEligibility"]
  readonly unavailableOn: readonly { readonly harness: string; readonly reasons: LocalReadiness["reasons"] }[]
  readonly prerequisites: RunProfileEntry["prerequisites"]
  readonly workflows: readonly {
    readonly id: string
    readonly description: string
    readonly examples: readonly string[]
  }[]
  readonly headless: RunProfileEntry["headless"]
  readonly herdrCompatibility: RunProfileEntry["herdrCompatibility"] | null
  readonly goalExecution: NonNullable<RunProfileEntry["goalExecution"]> | null
}
export interface RunListCatalog {
  readonly schemaVersion: 2
  readonly harnesses: readonly ListedHarness[]
  readonly profiles: readonly ListedProfile[]
  readonly unavailable: { readonly harnesses: readonly ListedHarness[]; readonly profiles: readonly ListedProfile[] }
}
const unique = <T>(values: readonly T[]): T[] => [
  ...new Map(values.map((value) => [JSON.stringify(value), value])).values(),
]
const common = <T>(values: readonly T[]): T | null => (values.length && unique(values).length === 1 ? values[0]! : null)
const harnessEntry = ({ profiles, sandbox, ...harness }: RunHarnessEntry): ListedHarness => ({
  ...harness,
  sandbox: sandbox ?? common(profiles.map((profile) => profile.sandbox)),
})

/** Publish definition sets. The expanded launch matrix stays private to Guide. */
export const toRunListCatalog = (snapshot: Pick<RunCatalogSnapshot, "catalog">): RunListCatalog => {
  const catalog = snapshot.catalog
  const unavailableHarnesses = new Set(catalog.unavailable.harnesses.map((h) => h.id))
  const groups = new Map<string, RunProfileEntry[]>()
  for (const profile of [
    ...catalog.harnesses.flatMap((h) => h.profiles),
    ...catalog.unavailable.harnesses.flatMap((h) => h.profiles),
    ...catalog.unavailable.profiles,
  ]) {
    const id = profile.definitionId ?? profile.name
    const group = groups.get(id) ?? []
    group.push(profile)
    groups.set(id, group)
  }
  const profiles: ListedProfile[] = [],
    unavailableProfiles: ListedProfile[] = []
  for (const [id, group] of [...groups].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    group.sort((a, b) => a.harnessId.localeCompare(b.harnessId, "en"))
    const first = group[0]!,
      ready = group.filter((p) => p.readiness.status === "ready"),
      eligible = group.filter((p) => p.guideEligibility.eligible)
    const workflowSource = group.find((p) => p.workflows.length > 0) ?? first
    const profile: ListedProfile = {
      id,
      argument: first.name,
      selection: first.selection,
      metadataStatus: first.metadataStatus,
      harnesses: group.map((p) => p.harnessId),
      readyHarnesses: ready.map((p) => p.harnessId),
      guideHarnesses: eligible.map((p) => p.harnessId),
      readiness: {
        status: ready.length ? "ready" : "unavailable",
        reasons: ready.length ? [] : unique(group.flatMap((p) => p.readiness.reasons)),
        automaticSetup: unique(ready.flatMap((p) => p.readiness.automaticSetup)),
        unverified: unique(group.flatMap((p) => p.readiness.unverified)),
      },
      guideEligibility: {
        eligible: eligible.length > 0,
        reasons: eligible.length ? [] : unique(group.flatMap((p) => p.guideEligibility.reasons)),
      },
      unavailableOn: group
        .filter((p) => p.readiness.status === "unavailable" && !unavailableHarnesses.has(p.harnessId))
        .map((p) => ({ harness: p.harnessId, reasons: p.readiness.reasons })),
      prerequisites: unique(group.flatMap((p) => p.prerequisites)),
      workflows: workflowSource.workflows.map(({ id: workflowId, description, examples }) => ({
        id: workflowId,
        description,
        examples,
      })),
      headless: common(group.map((p) => p.headless)),
      herdrCompatibility: common(group.map((p) => p.herdrCompatibility)),
      goalExecution: common(group.map((p) => p.goalExecution ?? null)),
    }
    if (ready.length) profiles.push(profile)
    else unavailableProfiles.push(profile)
  }
  const byId = (a: ListedHarness, b: ListedHarness) => a.id.localeCompare(b.id, "en")
  return {
    schemaVersion: 2,
    harnesses: catalog.harnesses.map(harnessEntry).sort(byId),
    profiles,
    unavailable: {
      harnesses: catalog.unavailable.harnesses.map(harnessEntry).sort(byId),
      profiles: unavailableProfiles,
    },
  }
}
