export type SortMode = "profile" | "harness"

export interface LaunchEntry {
  readonly id: string
  readonly label: string
  readonly harness: string
  readonly profile: string
  readonly description: string
  readonly harnessVersion?: string
  readonly plugins?: ReadonlyArray<string>
  readonly skills?: ReadonlyArray<string>
  readonly mcps?: ReadonlyArray<string>
  readonly commandAlias?: string
  readonly commandPath?: string
  readonly profileArgument?: string
  readonly passthroughArgs?: ReadonlyArray<string>
  readonly details?: string
  readonly defaultModel?: string
  readonly models: ReadonlyArray<string>
  readonly modelOverrideSupported: boolean
  readonly sandbox?: boolean
}

export interface LauncherState {
  readonly entries: ReadonlyArray<LaunchEntry>
  readonly selectedId: string
  readonly sort: SortMode
  readonly query: string
  readonly modelByEntry: Readonly<Record<string, string>>
}

const compareText = (left: string, right: string): number => left.localeCompare(right, "en")

const compareEntries =
  (sort: SortMode) =>
  (left: LaunchEntry, right: LaunchEntry): number => {
    if (sort === "harness") {
      const harness = compareText(left.harness, right.harness)
      if (harness !== 0) return harness
    }
    return compareText(left.profile, right.profile) || compareText(left.id, right.id)
  }

export const visibleEntries = (state: LauncherState): ReadonlyArray<LaunchEntry> => {
  const query = state.query.trim().toLocaleLowerCase("en")
  return [...state.entries]
    .filter((entry) =>
      query.length === 0
        ? true
        : `${entry.profile}\n${entry.harness}\n${entry.description}`.toLocaleLowerCase("en").includes(query),
    )
    .sort(compareEntries(state.sort))
}

export const createLauncherState = (entries: ReadonlyArray<LaunchEntry>): LauncherState => {
  if (entries.length === 0) throw new Error("launcher catalog must contain at least one entry")
  const state: LauncherState = {
    entries,
    selectedId: entries[0]!.id,
    sort: "harness",
    query: "",
    modelByEntry: {},
  }
  return { ...state, selectedId: visibleEntries(state)[0]!.id }
}

const withValidSelection = (state: LauncherState): LauncherState => {
  const visible = visibleEntries(state)
  if (visible.some(({ id }) => id === state.selectedId)) return state
  return { ...state, selectedId: visible[0]?.id ?? "" }
}

export const cycleSort = (state: LauncherState): LauncherState => {
  const next: Record<SortMode, SortMode> = {
    profile: "harness",
    harness: "profile",
  }
  return withValidSelection({ ...state, sort: next[state.sort] })
}

export const setQuery = (state: LauncherState, query: string): LauncherState => withValidSelection({ ...state, query })

export const moveSelection = (state: LauncherState, delta: number): LauncherState => {
  const visible = visibleEntries(state)
  if (visible.length === 0) return { ...state, selectedId: "" }
  const current = Math.max(
    0,
    visible.findIndex(({ id }) => id === state.selectedId),
  )
  const selected = (current + delta + visible.length) % visible.length
  return { ...state, selectedId: visible[selected]!.id }
}

export const selectModel = (state: LauncherState, entryId: string, model: string): LauncherState => {
  const entry = state.entries.find(({ id }) => id === entryId)
  if (entry === undefined) throw new Error(`unknown launcher entry: ${entryId}`)
  if (!entry.modelOverrideSupported) throw new Error(`${entryId} has a pinned model`)
  if (model.length === 0 || model.length > 256 || /[\u0000-\u001f\u007f-\u009f]/u.test(model)) {
    throw new Error("model must be a non-empty printable string of at most 256 characters")
  }
  return { ...state, modelByEntry: { ...state.modelByEntry, [entryId]: model } }
}
