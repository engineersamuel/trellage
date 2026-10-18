import { CLEAN_PROFILE } from "@trellage/runtime/native-run"

export interface RunSelectorOption {
  readonly harness: string
  readonly label: string
  readonly efforts: ReadonlyArray<string>
  /** The model and effort the harness uses when none is chosen; undefined when unknown. */
  readonly defaultModel: string | undefined
  readonly defaultEffort?: string | undefined
  readonly planModel: string
  /** Extensions the harness always loads, shown with the always-on items. */
  readonly extensions?: ReadonlyArray<string>
}

export type RunSelectorField = "harness" | "profiles" | "model" | "effort"

export const runSelectorFields: ReadonlyArray<RunSelectorField> = ["harness", "profiles", "model", "effort"]

export interface RunSelectorState {
  readonly field: RunSelectorField
  readonly harnessIndex: number
  readonly profileCursor: number
  readonly profiles: ReadonlyArray<string>
  readonly modelIndex: number
  readonly effortIndex: number
  /** Cursor of the open model panel (0 is the harness default); null when closed. */
  readonly picker: number | null
}

export interface RunSelectorCatalog {
  readonly harnesses: ReadonlyArray<RunSelectorOption>
  readonly profiles: ReadonlyArray<string>
  readonly profileHarnesses?: Readonly<Record<string, ReadonlyArray<string> | undefined>>
  /** Profiles shown disabled, instead of hidden, on harnesses outside their harness list. */
  readonly disabledProfiles?: ReadonlyArray<string>
  /** Always-on profiles, shown read-only; a missing harness list means every harness. */
  readonly always?: ReadonlyArray<{
    readonly profile: string
    readonly harnesses?: ReadonlyArray<string> | undefined
    readonly skills: ReadonlyArray<string>
    readonly instructions: ReadonlyArray<string>
  }>
  /** Every model choice after the leading "harness default" entry, frontier first. */
  readonly models: ReadonlyArray<string>
  /** Display groups in the same order as models. */
  readonly modelGroups?: ReadonlyArray<{ readonly title: string; readonly models: ReadonlyArray<string> }>
  /** How many leading models the inline selector cycles through; the panel shows all. Defaults to all. */
  readonly cycleCount?: number
}

export interface RunSelectorInitial {
  readonly harness?: string | undefined
  readonly profiles?: ReadonlyArray<string> | undefined
  readonly model?: string | undefined
  readonly effort?: string | undefined
}

export type RunSelectorAction =
  | { readonly kind: "field"; readonly delta: 1 | -1 }
  | { readonly kind: "change"; readonly delta: 1 | -1 }
  | { readonly kind: "toggle" }
  | { readonly kind: "open-picker" }
  | { readonly kind: "picker-move"; readonly delta: 1 | -1 }
  | { readonly kind: "picker-select" }
  | { readonly kind: "picker-close" }

const wrap = (value: number, size: number): number => (size <= 0 ? 0 : ((value % size) + size) % size)

export const runSelectorProfiles = (catalog: RunSelectorCatalog, harnessIndex: number): ReadonlyArray<string> =>
  catalog.profiles.filter((profile) => {
    const harnesses = catalog.profileHarnesses?.[profile]
    return harnesses === undefined || harnesses.includes(catalog.harnesses[harnessIndex]?.harness ?? "")
  })

/** Profiles listed for the harness, in display order; disabled ones cannot be selected. */
export const runSelectorVisibleProfiles = (
  catalog: RunSelectorCatalog,
  harnessIndex: number,
  selectedProfiles: ReadonlyArray<string> = [],
): ReadonlyArray<{ readonly profile: string; readonly enabled: boolean }> => {
  const enabled = runSelectorProfiles(catalog, harnessIndex)
  const cleanSelected = selectedProfiles.includes(CLEAN_PROFILE)
  return catalog.profiles
    .filter((profile) => enabled.includes(profile) || catalog.disabledProfiles?.includes(profile))
    .map((profile) => ({
      profile,
      enabled: enabled.includes(profile) && (!cleanSelected || profile === CLEAN_PROFILE),
    }))
}

export const initialRunSelectorState = (
  catalog: RunSelectorCatalog,
  initial: RunSelectorInitial = {},
): RunSelectorState => {
  const harnessIndex = Math.max(
    0,
    catalog.harnesses.findIndex((option) => option.harness === initial.harness),
  )
  const harness = catalog.harnesses[harnessIndex]
  const modelIndex = initial.model === undefined ? -1 : catalog.models.indexOf(initial.model)
  const effortIndex = initial.effort === undefined || !harness ? -1 : harness.efforts.indexOf(initial.effort)
  const profiles = (initial.profiles ?? []).filter((profile) =>
    runSelectorProfiles(catalog, harnessIndex).includes(profile),
  )
  return {
    field: "harness",
    harnessIndex,
    profileCursor: 0,
    profiles: profiles.includes(CLEAN_PROFILE) ? [CLEAN_PROFILE] : profiles,
    modelIndex: modelIndex + 1,
    effortIndex: effortIndex + 1,
    picker: null,
  }
}

const toggleProfile = (state: RunSelectorState, catalog: RunSelectorCatalog): RunSelectorState => {
  const row = runSelectorVisibleProfiles(catalog, state.harnessIndex, state.profiles)[state.profileCursor]
  if (row === undefined || !row.enabled) return state
  if (row.profile === CLEAN_PROFILE) {
    return {
      ...state,
      profiles: state.profiles.includes(CLEAN_PROFILE) ? [] : [CLEAN_PROFILE],
    }
  }
  const profiles = state.profiles.filter((profile) => profile !== CLEAN_PROFILE)
  return {
    ...state,
    profiles: profiles.includes(row.profile)
      ? profiles.filter((profile) => profile !== row.profile)
      : [...profiles, row.profile],
  }
}

const changeHarness = (state: RunSelectorState, delta: 1 | -1, catalog: RunSelectorCatalog): RunSelectorState => {
  const harnessIndex = wrap(state.harnessIndex + delta, catalog.harnesses.length)
  return {
    ...state,
    harnessIndex,
    effortIndex: 0,
    profileCursor: 0,
    profiles: state.profiles.filter((profile) => runSelectorProfiles(catalog, harnessIndex).includes(profile)),
  }
}

const changeSelection = (state: RunSelectorState, delta: 1 | -1, catalog: RunSelectorCatalog): RunSelectorState => {
  if (state.field === "harness") return changeHarness(state, delta, catalog)
  if (state.field === "profiles") {
    return {
      ...state,
      profileCursor: wrap(
        state.profileCursor + delta,
        runSelectorVisibleProfiles(catalog, state.harnessIndex, state.profiles).length,
      ),
    }
  }
  if (state.field === "model") {
    const size = Math.min(catalog.cycleCount ?? catalog.models.length, catalog.models.length) + 1
    return { ...state, modelIndex: wrap(state.modelIndex + delta, size) }
  }
  const efforts = catalog.harnesses[state.harnessIndex]?.efforts ?? []
  return { ...state, effortIndex: wrap(state.effortIndex + delta, efforts.length + 1) }
}

const changeField = (state: RunSelectorState, delta: 1 | -1): RunSelectorState => {
  const index = runSelectorFields.indexOf(state.field)
  return { ...state, field: runSelectorFields[wrap(index + delta, runSelectorFields.length)]! }
}

const reduceWithoutPicker = (
  state: RunSelectorState,
  action: RunSelectorAction,
  catalog: RunSelectorCatalog,
): RunSelectorState => {
  if (action.kind === "field") return changeField(state, action.delta)
  if (action.kind === "toggle") return state.field === "profiles" ? toggleProfile(state, catalog) : state
  if (action.kind === "change") return changeSelection(state, action.delta, catalog)
  return state
}

export const runSelectorReducer = (
  state: RunSelectorState,
  action: RunSelectorAction,
  catalog: RunSelectorCatalog,
): RunSelectorState => {
  if (action.kind === "open-picker") return state.field === "model" ? { ...state, picker: state.modelIndex } : state
  if (action.kind === "picker-close") return { ...state, picker: null }
  if (state.picker !== null) {
    if (action.kind === "picker-move")
      return { ...state, picker: wrap(state.picker + action.delta, catalog.models.length + 1) }
    if (action.kind === "picker-select") return { ...state, modelIndex: state.picker, picker: null }
    return state
  }
  return reduceWithoutPicker(state, action, catalog)
}

export interface RunSelectorChoice {
  readonly harness: string
  readonly profiles: ReadonlyArray<string>
  readonly model?: string | undefined
  readonly effort?: string | undefined
}

export const runSelectorChoice = (state: RunSelectorState, catalog: RunSelectorCatalog): RunSelectorChoice => {
  const harness = catalog.harnesses[state.harnessIndex]
  if (!harness) throw new Error("no harness available")
  return {
    harness: harness.harness,
    profiles: runSelectorProfiles(catalog, state.harnessIndex).filter((profile) => state.profiles.includes(profile)),
    model: state.modelIndex === 0 ? undefined : catalog.models[state.modelIndex - 1],
    effort: state.effortIndex === 0 ? undefined : harness.efforts[state.effortIndex - 1],
  }
}

export const runSelectorCommand = (
  choice: RunSelectorChoice,
  modifiers: ReadonlyArray<string> = [],
): string =>
  [
    "trx run",
    choice.harness,
    ...choice.profiles,
    ...(choice.model === undefined ? [] : ["--model", choice.model]),
    ...(choice.effort === undefined ? [] : ["--effort", choice.effort]),
    ...modifiers,
  ].join(" ")
