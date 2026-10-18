import { CLEAN_PROFILE } from "@trellage/runtime/native-run"
import { runSelectorProfiles, runSelectorVisibleProfiles } from "./run-select-state.ts"
import React, { useReducer } from "react"
import { Box, Text, useApp, useInput } from "ink"
import { useTheme } from "./termcn/use-theme.ts"
import {
  initialRunSelectorState,
  runSelectorChoice,
  runSelectorCommand,
  runSelectorReducer,
  type RunSelectorAction,
  type RunSelectorCatalog,
  type RunSelectorChoice,
  type RunSelectorField,
  type RunSelectorInitial,
  type RunSelectorOption,
} from "./run-select-state.ts"

export interface RunSelectorProps {
  readonly catalog: RunSelectorCatalog
  readonly initial?: RunSelectorInitial | undefined
  readonly restoredFrom?: string | undefined
  readonly modifiers?: ReadonlyArray<string> | undefined
  readonly herdrAvailable?: boolean | undefined
  readonly onDone: (choice: RunSelectorChoice | null) => void
  readonly onHerdr?: ((choice: RunSelectorChoice) => void) | undefined
}

const Row = ({ active, label, children }: { active: boolean; label: string; children: React.ReactNode }) => {
  const theme = useTheme()
  return (
    <Box>
      <Text {...(active ? { color: theme.colors.focusRing } : {})} bold={active}>
        {active ? "› " : "  "}
        {label.padEnd(9)}
      </Text>
      {children}
    </Box>
  )
}

const PANEL_ROWS = 14

type PanelLine = { readonly key: string; readonly index?: number; readonly text: string }

const panelLines = (catalog: RunSelectorCatalog): PanelLine[] => {
  const groups = catalog.modelGroups ?? [{ title: "Models", models: catalog.models }]
  let index = 0
  return [
    { key: "default", index: 0, text: "harness default" },
    ...groups.flatMap((group) => [
      { key: `h-${group.title}`, text: group.title },
      ...group.models.map((model) => ({ key: model, index: (index += 1), text: model })),
    ]),
  ]
}

const ModelPanel = ({ catalog, cursor, current }: { catalog: RunSelectorCatalog; cursor: number; current: number }) => {
  const theme = useTheme()
  const lines = panelLines(catalog)
  const cursorLine = Math.max(
    0,
    lines.findIndex((line) => line.index === cursor),
  )
  const start = Math.max(0, Math.min(cursorLine - Math.floor(PANEL_ROWS / 2), lines.length - PANEL_ROWS))
  const visible = lines.slice(start, start + PANEL_ROWS)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.focusRing} paddingX={1}>
      <Text bold color={theme.colors.primary}>
        Select model
      </Text>
      {start > 0 ? <Text dimColor> ↑ more</Text> : null}
      {visible.map((line) =>
        line.index === undefined ? (
          <Text key={line.key} bold color={theme.colors.accent}>
            {line.text}
          </Text>
        ) : (
          <Text
            key={line.key}
            inverse={line.index === cursor}
            bold={line.index === cursor}
            {...(line.index !== cursor && line.index === current ? { color: theme.colors.selection } : {})}
          >
            {line.index === current ? "● " : "  "}
            {line.text}
          </Text>
        ),
      )}
      {start + PANEL_ROWS < lines.length ? <Text dimColor> ↓ more</Text> : null}
      <Text>
        <Text color={theme.colors.primary}>↑↓</Text>
        <Text dimColor> move · </Text>
        <Text color={theme.colors.primary}>enter</Text>
        <Text dimColor> select · </Text>
        <Text color={theme.colors.primary}>esc</Text>
        <Text dimColor> back</Text>
      </Text>
    </Box>
  )
}

const ProfileRows = ({
  catalog,
  harnessIndex,
  profiles,
  cursor,
  active,
}: {
  readonly catalog: RunSelectorCatalog
  readonly harnessIndex: number
  readonly profiles: ReadonlyArray<string>
  readonly cursor: number
  readonly active: boolean
}) => {
  const theme = useTheme()
  const visibleProfiles = runSelectorVisibleProfiles(catalog, harnessIndex, profiles)
  const availableProfiles = runSelectorProfiles(catalog, harnessIndex)
  const cleanSelected = profiles.includes(CLEAN_PROFILE)
  if (visibleProfiles.length === 0) return <Text dimColor>none defined in config.toml (clean base harness)</Text>
  return (
    <>
      {visibleProfiles.map(({ profile, enabled }, index) => (
        <Text
          key={profile}
          inverse={active && index === cursor}
          bold={active && index === cursor}
          dimColor={!enabled}
          {...(!(active && index === cursor) && profiles.includes(profile) ? { color: theme.colors.selection } : {})}
        >
          [{profiles.includes(profile) ? "x" : " "}] {profile}
          {enabled
            ? ""
            : cleanSelected && availableProfiles.includes(profile)
              ? " (clean selected)"
              : ` (${catalog.profileHarnesses?.[profile]?.join(", ")} only)`}
        </Text>
      ))}
    </>
  )
}

const AlwaysOnSummary = ({
  harness,
  entries,
  skipAlways,
}: {
  readonly harness: RunSelectorOption
  readonly entries: NonNullable<RunSelectorCatalog["always"]>
  readonly skipAlways: boolean
}) => {
  const theme = useTheme()
  const always = entries.filter((entry) => entry.harnesses === undefined || entry.harnesses.includes(harness.harness))
  const skills = uniqueValues(always.flatMap((entry) => entry.skills))
  const styles = uniqueValues(always.flatMap((entry) => entry.instructions))
  const extensions = harness.extensions ?? []
  if (always.length === 0 && extensions.length === 0) return null
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text dimColor={skipAlways}>
        <Text {...(!skipAlways ? { color: theme.colors.primary } : {})}>Always on</Text> (
        <Text {...(!skipAlways ? { color: theme.colors.selection } : {})}>{always.map((entry) => entry.profile).join(", ")}</Text>
        <Text dimColor>{skipAlways ? "; skipped by --no-always" : "; --no-always skips"}</Text>)
      </Text>
      <SummaryGroup label="Extensions" values={extensions} color={theme.colors.selection} skip={skipAlways} />
      <SummaryGroup label="Skills" values={skills} color={theme.colors.selection} skip={skipAlways} />
      <SummaryGroup label="Styles" values={styles} color={theme.colors.accent} skip={skipAlways} />
    </Box>
  )
}

const uniqueValues = (values: ReadonlyArray<string>): string[] => [...new Set(values)]

const SummaryGroup = ({
  label,
  values,
  color,
  skip,
}: {
  readonly label: string
  readonly values: ReadonlyArray<string>
  readonly color: string
  readonly skip: boolean
}) => {
  if (values.length === 0) return null
  return (
    <Text dimColor={skip}>
      {" "}
      {label} <Text {...(!skip ? { color } : {})}>{values.join(", ")}</Text>
    </Text>
  )
}

const SelectorPreview = ({
  choice,
  harness,
  modifiers,
}: {
  readonly choice: RunSelectorChoice
  readonly harness: RunSelectorOption
  readonly modifiers: ReadonlyArray<string>
}) => {
  const theme = useTheme()
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={theme.colors.primary}>Normal</Text>
        {"  "}
        <Text color={theme.colors.accent}>{choice.model ?? harness.defaultModel ?? "harness default"}</Text>
        {" · effort "}
        <Text color={theme.colors.warning}>{choice.effort ?? harness.defaultEffort ?? "harness default"}</Text>
      </Text>
      <Text>
        <Text color={theme.colors.primary}>Plan</Text>
        {"    "}
        <Text color={theme.colors.accent}>{harness.planModel}</Text>
      </Text>
      <Text color={theme.colors.selection}>{runSelectorCommand(choice, modifiers)}</Text>
    </Box>
  )
}

const SelectorHelp = ({ herdrAvailable }: { readonly herdrAvailable: boolean }) => {
  const theme = useTheme()
  return (
    <Text>
      <Text color={theme.colors.primary}>↑↓</Text>
      <Text dimColor> field · </Text>
      <Text color={theme.colors.primary}>←→</Text>
      <Text dimColor> change · </Text>
      <Text color={theme.colors.primary}>space</Text>
      <Text dimColor> toggle profile · </Text>
      <Text color={theme.colors.primary}>enter</Text>
      <Text dimColor> launch (on Model: open list) · </Text>
      {herdrAvailable ? (
        <>
          <Text color={theme.colors.primary}>H</Text>
          <Text dimColor> Herdr · </Text>
        </>
      ) : null}
      <Text color={theme.colors.primary}>esc</Text>
      <Text dimColor> cancel</Text>
    </Text>
  )
}

const SelectorFields = ({
  catalog,
  harness,
  harnessIndex,
  state,
}: {
  readonly catalog: RunSelectorCatalog
  readonly harness: RunSelectorOption
  readonly harnessIndex: number
  readonly state: ReturnType<typeof initialRunSelectorState>
}) => {
  const theme = useTheme()
  const choice = runSelectorChoice(state, catalog)
  const active = (field: RunSelectorField) => state.field === field
  return (
    <Box flexDirection="column" marginTop={1}>
      <Row active={active("harness")} label="Harness">
        <Text color={theme.colors.primary}>◂ {harness.label} ▸</Text>
      </Row>
      <Row active={active("profiles")} label="Profiles">
        <Box flexDirection="column">
          <ProfileRows
            catalog={catalog}
            harnessIndex={harnessIndex}
            profiles={state.profiles}
            cursor={state.profileCursor}
            active={active("profiles")}
          />
        </Box>
      </Row>
      <Row active={active("model")} label="Model">
        <Text>
          <Text color={theme.colors.accent}>◂ {choice.model ?? (harness.defaultModel || "harness default")}</Text>
          {choice.model === undefined && harness.defaultModel ? <Text dimColor> (default)</Text> : null}
          <Text color={theme.colors.accent}> ▸</Text>
        </Text>
      </Row>
      <Row active={active("effort")} label="Effort">
        <Text>
          <Text color={theme.colors.warning}>◂ {choice.effort ?? (harness.defaultEffort || "harness default")}</Text>
          {choice.effort === undefined && harness.defaultEffort ? <Text dimColor> (default)</Text> : null}
          <Text color={theme.colors.warning}> ▸</Text>
        </Text>
      </Row>
    </Box>
  )
}

const SelectorHeader = ({ restoredFrom }: { readonly restoredFrom: string | undefined }) => {
  const theme = useTheme()
  return (
    <>
      <Text>
        <Text bold color={theme.colors.primary}>
          trx run
        </Text>
        : choose a harness, profiles and model
      </Text>
      {restoredFrom ? <Text dimColor>Restored from {restoredFrom} history</Text> : null}
    </>
  )
}

type InputKey = Parameters<Parameters<typeof useInput>[0]>[1]

const handlePickerInput = (input: string, key: InputKey, dispatch: React.Dispatch<RunSelectorAction>): void => {
  if (key.escape || input === "q") dispatch({ kind: "picker-close" })
  else if (key.return) dispatch({ kind: "picker-select" })
  else if (key.upArrow) dispatch({ kind: "picker-move", delta: -1 })
  else if (key.downArrow || key.tab) dispatch({ kind: "picker-move", delta: 1 })
}

const handleSelectorInput = (
  input: string,
  key: InputKey,
  state: ReturnType<typeof initialRunSelectorState>,
  catalog: RunSelectorCatalog,
  dispatch: React.Dispatch<RunSelectorAction>,
  finish: (choice: RunSelectorChoice | null) => void,
): void => {
  if (key.return) {
    if (state.field === "model") dispatch({ kind: "open-picker" })
    else finish(runSelectorChoice(state, catalog))
    return
  }
  if (key.escape || input === "q" || (key.ctrl && input === "c")) {
    finish(null)
    return
  }
  if (key.upArrow) dispatch({ kind: "field", delta: -1 })
  else if (key.downArrow || key.tab) dispatch({ kind: "field", delta: 1 })
  else if (key.leftArrow) dispatch({ kind: "change", delta: -1 })
  else if (key.rightArrow) dispatch({ kind: "change", delta: 1 })
  else if (input === " ") dispatch({ kind: "toggle" })
}

export const RunSelector = ({
  catalog,
  initial,
  restoredFrom,
  modifiers = [],
  herdrAvailable = false,
  onDone,
  onHerdr,
}: RunSelectorProps) => {
  const { exit } = useApp()
  const [state, dispatch] = useReducer(
    (current: ReturnType<typeof initialRunSelectorState>, action: Parameters<typeof runSelectorReducer>[1]) =>
      runSelectorReducer(current, action, catalog),
    initialRunSelectorState(catalog, initial),
  )
  const finish = (choice: RunSelectorChoice | null) => {
    onDone(choice)
    exit()
  }
  const finishInHerdr = () => {
    if (!herdrAvailable || onHerdr === undefined) return
    onHerdr(runSelectorChoice(state, catalog))
    exit()
  }
  useInput((input, key) => {
    if (state.picker !== null) handlePickerInput(input, key, dispatch)
    else if (input === "H") finishInHerdr()
    else handleSelectorInput(input, key, state, catalog, dispatch, finish)
  })

  const harness = catalog.harnesses[state.harnessIndex]!
  const choice = runSelectorChoice(state, catalog)
  const skipAlways = modifiers.includes("--no-always")
  if (state.picker !== null) return <ModelPanel catalog={catalog} cursor={state.picker} current={state.modelIndex} />
  return (
    <Box flexDirection="column">
      <SelectorHeader restoredFrom={restoredFrom} />
      <AlwaysOnSummary harness={harness} entries={catalog.always ?? []} skipAlways={skipAlways} />
      <SelectorFields catalog={catalog} harness={harness} harnessIndex={state.harnessIndex} state={state} />
      <SelectorPreview choice={choice} harness={harness} modifiers={modifiers} />
      <SelectorHelp herdrAvailable={herdrAvailable} />
    </Box>
  )
}
