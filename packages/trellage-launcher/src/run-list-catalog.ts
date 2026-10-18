import { lstat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  parseSelectionMetadata,
  selectionMetadataStatus,
  type SelectionMetadata,
} from "@trellage/guide-core"
import {
  adapters,
  enumerateNamedRunProfiles,
  inspectHarnessReadiness,
  inspectProfileReadiness,
  loadEffectiveRunConfig,
  type LocalReadiness,
  type ResolvedNamedProfile,
} from "@trellage/runtime/native-run"
import { resolveInstructionFile } from "@trellage/runtime/native-run"
import type { NativeCatalog, NativeProfile } from "@trellage/runtime/native-config"
import type { HeadlessCapabilitiesV1 } from "./guide-catalog.ts"
import { loadRunExecutionFacts, profileExecutionFacts } from "./run-catalog-facts.ts"

export interface RunGuideEligibility {
  readonly eligible: boolean
  readonly reasons: ReadonlyArray<string>
}

export interface RunListHarness {
  readonly id: string
  readonly selection: SelectionMetadata
  readonly metadataStatus: "complete" | "incomplete"
  readonly readiness: LocalReadiness
  readonly guideEligibility: RunGuideEligibility
  readonly sandbox: boolean | null
}

export interface RunListProfile {
  readonly id: string
  readonly argument: string
  readonly selection: SelectionMetadata
  readonly metadataStatus: "complete" | "incomplete"
  readonly harnesses: ReadonlyArray<string>
  readonly readyHarnesses: ReadonlyArray<string>
  readonly guideHarnesses: ReadonlyArray<string>
  readonly readiness: LocalReadiness
  readonly guideEligibility: RunGuideEligibility
  readonly unavailableOn: ReadonlyArray<{ readonly harness: string; readonly reasons: LocalReadiness["reasons"] }>
  readonly prerequisites: ReadonlyArray<{ readonly command: string; readonly description: string }>
  readonly workflows: ReadonlyArray<{ readonly id: string; readonly description: string; readonly examples: ReadonlyArray<string> }>
  readonly headless: HeadlessCapabilitiesV1 | null
  readonly herdrCompatibility: { readonly status: string } | null
  readonly goalExecution: { readonly controller: string; readonly workflowIds: ReadonlyArray<string> } | null
}

export interface RunListCatalog {
  readonly schemaVersion: 2
  readonly harnesses: ReadonlyArray<RunListHarness>
  readonly profiles: ReadonlyArray<RunListProfile>
  readonly unavailable: {
    readonly harnesses: ReadonlyArray<RunListHarness>
    readonly profiles: ReadonlyArray<RunListProfile>
  }
}

interface ProfileRow {
  readonly profile: ResolvedNamedProfile
  readonly readiness: LocalReadiness
  readonly selection: SelectionMetadata
  readonly metadataStatus: "complete" | "incomplete"
  readonly guideEligibility: RunGuideEligibility
}

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url))
const unique = <T>(values: ReadonlyArray<T>): T[] => [...new Map(values.map((value) => [JSON.stringify(value), value])).values()]

const selectionFor = (selection: NativeProfile["selection"] | undefined): SelectionMetadata =>
  parseSelectionMetadata(selection ?? {}, "selection")

const guideEligibilityFor = async (
  profile: NativeProfile,
  selection: SelectionMetadata,
  configDirectory: string,
  shippedRoot: string,
): Promise<RunGuideEligibility> => {
  const reasons: string[] = []
  if (selectionMetadataStatus(selection) === "incomplete") reasons.push("profile-metadata-incomplete")
  const documents = [
    ...(profile.guide?.document === undefined ? [] : [profile.guide.document]),
    ...Object.values(profile.guide?.documents ?? {}),
  ]
  for (const document of documents) {
    const file = resolveInstructionFile(document, configDirectory, shippedRoot)
    const info = await lstat(file).catch((error) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!info?.isFile() || info.isSymbolicLink() || info.size > 128_000) reasons.push("workflow-unavailable")
  }
  return { eligible: reasons.length === 0, reasons: [...new Set(reasons)] }
}

const harnessRows = async (
  environment: NodeJS.ProcessEnv,
  cwd: string,
  shippedRoot: string,
  configDirectory: string,
  catalog: NativeCatalog,
) => {
  const rows = await Promise.all(
    Object.keys(adapters)
      .sort()
      .map(async (id) => {
        const readiness = await inspectHarnessReadiness(id, { environment, cwd, shippedRoot, configDirectory })
        const selection = selectionFor(catalog.harnesses?.[id]?.selection)
        const eligibility = selectionMetadataStatus(selection) === "complete"
        return {
          entry: {
            id,
            selection,
            metadataStatus: selectionMetadataStatus(selection),
            readiness,
            guideEligibility: {
              eligible: eligibility,
              reasons: eligibility ? [] : ["harness-metadata-incomplete"],
            },
            sandbox: adapters[id]!.sandbox,
          } satisfies RunListHarness,
          readiness,
        }
      }),
  )
  return new Map(rows.map((row) => [row.entry.id, row]))
}

const profileRows = async (
  profiles: ReadonlyArray<ResolvedNamedProfile>,
  harnesses: Awaited<ReturnType<typeof harnessRows>>,
  environment: NodeJS.ProcessEnv,
  cwd: string,
  shippedRoot: string,
  configDirectory: string,
): Promise<ReadonlyArray<ProfileRow>> =>
  Promise.all(
    profiles.map(async (profile) => {
      const harness = harnesses.get(profile.harness)
      if (!harness) throw new Error(`Missing readiness for ${profile.harness}`)
      const selection = selectionFor(profile.definition.selection)
      return {
        profile,
        selection,
        metadataStatus: selectionMetadataStatus(selection),
        readiness: await inspectProfileReadiness(profile, harness.readiness, {
          environment,
          cwd,
          shippedRoot,
          configDirectory,
        }),
        guideEligibility: await guideEligibilityFor(profile.definition, selection, configDirectory, shippedRoot),
      }
    }),
  )

const buildProfile = (
  id: string,
  rows: ReadonlyArray<ProfileRow>,
  facts: Awaited<ReturnType<typeof loadRunExecutionFacts>>,
  unavailableHarnesses: ReadonlySet<string>,
): RunListProfile => {
  const ready = rows.filter((row) => row.readiness.status === "ready")
  const eligible = rows.filter((row) => row.guideEligibility.eligible)
  const first = rows[0]!
  const workflows = first.profile.definition.guide?.workflows ?? []
  const prerequisites = (first.profile.definition.prerequisites ?? []).map(({ command }) => ({
    command,
    description: `Requires executable: ${command}`,
  }))
  const execution = profileExecutionFacts(first.profile, facts)
  const reasons = ready.length ? [] : unique(rows.flatMap((row) => row.readiness.reasons))
  const guideReasons = eligible.length ? [] : unique(rows.flatMap((row) => row.guideEligibility.reasons))
  return {
    id,
    argument: first.profile.name,
    selection: first.selection,
    metadataStatus: first.metadataStatus,
    harnesses: rows.map((row) => row.profile.harness),
    readyHarnesses: ready.map((row) => row.profile.harness),
    guideHarnesses: eligible.map((row) => row.profile.harness),
    readiness: {
      status: ready.length ? "ready" : "unavailable",
      reasons,
      automaticSetup: unique(ready.flatMap((row) => row.readiness.automaticSetup)),
      unverified: unique(rows.flatMap((row) => row.readiness.unverified)),
    },
    guideEligibility: { eligible: eligible.length > 0, reasons: guideReasons },
    unavailableOn: rows
      .filter((row) => row.readiness.status === "unavailable" && !unavailableHarnesses.has(row.profile.harness))
      .map((row) => ({ harness: row.profile.harness, reasons: row.readiness.reasons })),
    prerequisites,
    workflows: workflows.map(({ id: workflowId, description, examples }) => ({
      id: workflowId,
      description,
      examples,
    })),
    headless: execution.headless,
    herdrCompatibility: execution.herdrCompatibility,
    goalExecution: first.profile.definition.guide?.goal_execution
      ? {
          controller: first.profile.definition.guide.goal_execution.controller,
          workflowIds: first.profile.definition.guide.goal_execution.workflow_ids,
        }
      : null,
  }
}

export const loadRunListCatalog = async (options: {
  readonly environment?: NodeJS.ProcessEnv
  readonly home?: string
  readonly cwd?: string
} = {}): Promise<RunListCatalog> => {
  const environment = options.environment ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const shippedConfigPath = path.join(repositoryRoot, "config.example.toml")
  const home = options.home ?? environment.HOME
  const effective = await loadEffectiveRunConfig({
    environment,
    ...(home === undefined ? {} : { home }),
    cwd,
    shippedConfigPath,
  })
  const configDirectory = path.dirname(effective.configPath)
  const harnesses = await harnessRows(environment, cwd, effective.shippedRoot, configDirectory, effective.catalog)
  const profiles = await profileRows(
    enumerateNamedRunProfiles(effective),
    harnesses,
    environment,
    cwd,
    effective.shippedRoot,
    configDirectory,
  )
  const facts = await loadRunExecutionFacts({ shippedRoot: effective.shippedRoot, environment })
  const grouped = new Map<string, ProfileRow[]>()
  for (const row of profiles) {
    const id = row.profile.definitionKey
    const values = grouped.get(id) ?? []
    values.push(row)
    grouped.set(id, values)
  }
  const unavailableHarnessIds = new Set(
    [...harnesses].filter(([, row]) => row.readiness.status === "unavailable").map(([id]) => id),
  )
  const listedProfiles = [...grouped]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([id, rows]) => buildProfile(id, rows, facts, unavailableHarnessIds))
  const readyHarnessRows = [...harnesses.values()]
    .filter((row) => row.readiness.status === "ready")
    .map((row) => row.entry)
  const unavailableHarnessRows = [...harnesses.values()]
    .filter((row) => row.readiness.status === "unavailable")
    .map((row) => row.entry)
  return {
    schemaVersion: 2,
    harnesses: readyHarnessRows,
    profiles: listedProfiles.filter((profile) => profile.readiness.status === "ready"),
    unavailable: {
      harnesses: unavailableHarnessRows,
      profiles: listedProfiles.filter((profile) => profile.readiness.status === "unavailable"),
    },
  }
}
