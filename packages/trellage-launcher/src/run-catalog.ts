import os from "node:os"
import path from "node:path"
import { readTrellageConfig, type NativeCatalog, type NativeProfile } from "@trellage/runtime/native-config"
import {
  adapters,
  builtinProfile,
  CLEAN_PROFILE,
  hostDefaults,
  loadModelCatalog,
  nativePresetProfiles,
  nativeSharedPresets,
  resolveNativeRunPaths,
} from "@trellage/runtime/native-run"
import type { RunSelectorCatalog } from "./run-select-state.ts"

export type RunProfileKind = "config" | "shared" | "special"

export interface RunCatalogProfile {
  readonly name: string
  readonly label: string
  readonly kind: RunProfileKind
  readonly always: boolean
  readonly harnesses: ReadonlyArray<string> | null
  readonly skills: ReadonlyArray<string>
}

export interface RunCatalog extends RunSelectorCatalog {
  readonly profileEntries: ReadonlyArray<RunCatalogProfile>
  readonly presetsByHarness: Readonly<Record<string, ReadonlyArray<string>>>
}

export interface LoadRunCatalogOptions {
  readonly environment?: NodeJS.ProcessEnv
  readonly home?: string
  readonly cwd?: string
  readonly includeModels?: boolean
}


const isPresetContentProfile = (id: string): boolean =>
  Object.keys(adapters).some((harness) => nativePresetProfiles(harness).some((preset) => id === `preset-${harness}-${preset}`))

const collectProfileHarnesses = async (
  catalog: NativeCatalog,
  configuredProfiles: ReadonlyArray<readonly [string, NativeProfile]>,
  harnessOrder: ReadonlyArray<string>,
): Promise<Record<string, ReadonlyArray<string> | undefined>> => {
  const profileHarnesses: Record<string, ReadonlyArray<string> | undefined> = {}

  for (const harness of harnessOrder) {
    for (const profile of nativePresetProfiles(harness)) {
      if (!Object.hasOwn(catalog.profiles, profile))
        profileHarnesses[profile] = [...(profileHarnesses[profile] ?? []), harness]
    }
  }
  for (const [id, profile] of configuredProfiles) {
    if (!profile.always) profileHarnesses[id] = profile.harnesses
  }
  for (const id of nativeSharedPresets) {
    if (!Object.hasOwn(catalog.profiles, id)) profileHarnesses[id] = (await builtinProfile(id))?.harnesses
  }
  profileHarnesses[CLEAN_PROFILE] = harnessOrder.filter((id) => adapters[id]?.clean.supported)
  return profileHarnesses
}

const catalogProfileEntry = (name: string, profile: NativeProfile, kind: RunProfileKind): RunCatalogProfile => ({
  name,
  label: profile.label ?? name,
  kind,
  always: kind === "shared" ? false : profile.always,
  harnesses: profile.harnesses ?? null,
  skills: profile.skills.flatMap((selection) => selection.names),
})

const collectProfileEntries = async (
  catalog: NativeCatalog,
  configuredProfiles: ReadonlyArray<readonly [string, NativeProfile]>,
  cleanHarnesses: ReadonlyArray<string>,
): Promise<RunCatalogProfile[]> => {
  const profileEntries: RunCatalogProfile[] = configuredProfiles
    .filter(([name]) => name !== CLEAN_PROFILE)
    .map(([name, profile]) => catalogProfileEntry(name, profile, "config"))
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const name of nativeSharedPresets) {
    if (Object.hasOwn(catalog.profiles, name)) continue
    const profile = await builtinProfile(name)
    if (!profile) continue
    profileEntries.push(catalogProfileEntry(name, profile, "shared"))
  }
  profileEntries.push({
    name: CLEAN_PROFILE,
    label: "Clean",
    kind: "special",
    always: false,
    harnesses: cleanHarnesses,
    skills: [],
  })
  return profileEntries
}

const loadRunModels = async (
  includeModels: boolean | undefined,
  environment: NodeJS.ProcessEnv,
  home: string,
) =>
  includeModels === false
    ? { groups: [] }
    : await loadModelCatalog({
        paths: resolveNativeRunPaths({ environment, home }),
        hostModelsPath: path.join(home, ".copilot", "models.json"),
        ...(environment.TRELLAGE_MODELS_URL ? { url: environment.TRELLAGE_MODELS_URL } : {}),
      })

const catalogHarnessEntry = (id: string): RunCatalog["harnesses"][number] => {
  const adapter = adapters[id]
  const defaults = adapter ? hostDefaults(id) : { model: undefined, effort: undefined }
  return {
    harness: id,
    label: adapter?.label ?? id,
    efforts: adapter?.efforts ?? [],
    defaultModel: defaults.model,
    defaultEffort: defaults.effort,
    planModel: adapter?.effectivePolicy(defaults.model, defaults.effort).plan ?? "managed preset",
    extensions: adapter?.extensions ?? [],
  }
}

export const loadRunCatalog = async (options: LoadRunCatalogOptions = {}): Promise<RunCatalog> => {
  const environment = options.environment ?? process.env
  const home = options.home ?? environment.HOME ?? os.homedir()
  const cwd = options.cwd ?? process.cwd()
  const loaded = await readTrellageConfig({ environment, home, cwd })
  const catalog = loaded.config.native
  const configuredProfiles = Object.entries(catalog.profiles).filter(([id]) => !isPresetContentProfile(id))
  const harnessOrder = Object.keys(adapters)
  const profileHarnesses = await collectProfileHarnesses(catalog, configuredProfiles, harnessOrder)
  const profileEntries = await collectProfileEntries(catalog, configuredProfiles, profileHarnesses[CLEAN_PROFILE] ?? [])
  const modelCatalog = await loadRunModels(options.includeModels, environment, home)
  const first = modelCatalog.groups[0]
  const presetsByHarness = Object.fromEntries(
    harnessOrder.map((harness) => [
      harness,
      nativePresetProfiles(harness).filter((preset) => !Object.hasOwn(loaded.config.native.profiles, preset)),
    ]),
  )

  return {
    harnesses: harnessOrder.map(catalogHarnessEntry),
    profileHarnesses,
    profiles: Object.keys(profileHarnesses).sort(),
    disabledProfiles: Object.keys(profileHarnesses).filter(
      (id) => profileHarnesses[id] !== undefined && id !== CLEAN_PROFILE && !harnessOrder.some((harness) => nativePresetProfiles(harness).includes(id)),
    ),
    always: configuredProfiles
      .filter(([, profile]) => profile.always)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([profile, value]) => ({
        profile,
        harnesses: value.harnesses,
        skills: value.skills.flatMap((selection) => selection.names),
        instructions: value.instructions,
      })),
    models: modelCatalog.groups.flatMap((group) => group.models),
    modelGroups: modelCatalog.groups,
    cycleCount: first?.title === "Frontier" ? first.models.length : 0,
    profileEntries,
    presetsByHarness,
  }
}
