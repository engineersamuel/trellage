import { runSelectorProfiles } from "./run-select-state.ts"
import React, { useReducer } from "react"
import { Box, Text, useApp, useInput } from "ink"
import { useTheme } from "./termcn/use-theme.ts"
import {
  initialRunSelectorState,
  runSelectorChoice,
  runSelectorCommand,
  runSelectorReducer,
  type RunSelectorCatalog,
  type RunSelectorChoice,
  type RunSelectorField,
  type RunSelectorInitial,
} from "./run-select-state.ts"

export interface RunSelectorProps {
  readonly catalog: RunSelectorCatalog
  readonly initial?: RunSelectorInitial | undefined
  readonly restoredFrom?: string | undefined
  readonly onDone: (choice: RunSelectorChoice | null) => void
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
  const cursorLine = Math.max(0, lines.findIndex((line) => line.index === cursor))
  const start = Math.max(0, Math.min(cursorLine - Math.floor(PANEL_ROWS / 2), lines.length - PANEL_ROWS))
  const visible = lines.slice(start, start + PANEL_ROWS)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.focusRing} paddingX={1}>
      <Text bold color={theme.colors.primary}>Select model</Text>
      {start > 0 ? <Text dimColor>  ↑ more</Text> : null}
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
      {start + PANEL_ROWS < lines.length ? <Text dimColor>  ↓ more</Text> : null}
      <Text>
        <Text color={theme.colors.primary}>↑↓</Text><Text dimColor> move · </Text>
        <Text color={theme.colors.primary}>enter</Text><Text dimColor> select · </Text>
        <Text color={theme.colors.primary}>esc</Text><Text dimColor> back</Text>
      </Text>
    </Box>
  )
}

export const RunSelector = ({ catalog, initial, restoredFrom, onDone }: RunSelectorProps) => {
  const { exit } = useApp()
  const theme = useTheme()
  const [state, dispatch] = useReducer(
    (current: ReturnType<typeof initialRunSelectorState>, action: Parameters<typeof runSelectorReducer>[1]) =>
      runSelectorReducer(current, action, catalog),
    initialRunSelectorState(catalog, initial),
  )
  const finish = (choice: RunSelectorChoice | null) => {
    onDone(choice)
    exit()
  }
  useInput((input, key) => {
    if (state.picker !== null) {
      if (key.escape || input === "q") dispatch({ kind: "picker-close" })
      else if (key.return) dispatch({ kind: "picker-select" })
      else if (key.upArrow) dispatch({ kind: "picker-move", delta: -1 })
      else if (key.downArrow || key.tab) dispatch({ kind: "picker-move", delta: 1 })
      return
    }
    if (key.return && state.field === "model") dispatch({ kind: "open-picker" })
    else if (key.escape || input === "q" || (key.ctrl && input === "c")) finish(null)
    else if (key.return) finish(runSelectorChoice(state, catalog))
    else if (key.upArrow) dispatch({ kind: "field", delta: -1 })
    else if (key.downArrow || key.tab) dispatch({ kind: "field", delta: 1 })
    else if (key.leftArrow) dispatch({ kind: "change", delta: -1 })
    else if (key.rightArrow) dispatch({ kind: "change", delta: 1 })
    else if (input === " ") dispatch({ kind: "toggle" })
  })

  const harness = catalog.harnesses[state.harnessIndex]!
  const choice = runSelectorChoice(state, catalog)
  const active = (field: RunSelectorField) => state.field === field
  const always = (catalog.always ?? []).filter((entry) => !entry.harnesses || entry.harnesses.includes(harness.harness))
  const alwaysSkills = [...new Set(always.flatMap((entry) => entry.skills))]
  const alwaysStyles = [...new Set(always.flatMap((entry) => entry.instructions))]
  if (state.picker !== null) return <ModelPanel catalog={catalog} cursor={state.picker} current={state.modelIndex} />
  return (
    <Box flexDirection="column">
      <Text><Text bold color={theme.colors.primary}>trx run</Text>: choose a harness, profiles and model</Text>
      {restoredFrom ? <Text dimColor>Restored from {restoredFrom} history</Text> : null}
      {always.length > 0 || (harness.extensions?.length ?? 0) > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            <Text color={theme.colors.primary}>Always on</Text> (<Text color={theme.colors.selection}>{always.map((entry) => entry.profile).join(", ")}</Text>
            <Text dimColor>; --no-always skips</Text>)
          </Text>
          {(harness.extensions?.length ?? 0) > 0 ? <Text>  Extensions  <Text color={theme.colors.selection}>{harness.extensions!.join(", ")}</Text></Text> : null}
          {alwaysSkills.length > 0 ? <Text>  Skills  <Text color={theme.colors.selection}>{alwaysSkills.join(", ")}</Text></Text> : null}
          {alwaysStyles.length > 0 ? <Text>  Styles  <Text color={theme.colors.accent}>{alwaysStyles.join(", ")}</Text></Text> : null}
        </Box>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        <Row active={active("harness")} label="Harness">
          <Text color={theme.colors.primary}>◂ {harness.label} ▸</Text>
        </Row>
        <Row active={active("profiles")} label="Profiles">
          <Box flexDirection="column">
            {runSelectorProfiles(catalog, state.harnessIndex).length === 0 ? <Text dimColor>none defined in config.toml (clean base harness)</Text> : null}
            {runSelectorProfiles(catalog, state.harnessIndex).map((profile, index) => (
              <Text
                key={profile}
                inverse={active("profiles") && index === state.profileCursor}
                bold={active("profiles") && index === state.profileCursor}
                {...(!(active("profiles") && index === state.profileCursor) && state.profiles.includes(profile) ? { color: theme.colors.selection } : {})}
              >
                [{state.profiles.includes(profile) ? "x" : " "}] {profile}
              </Text>
            ))}
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
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color={theme.colors.primary}>Normal</Text>{"  "}
          <Text color={theme.colors.accent}>{choice.model ?? harness.defaultModel ?? "harness default"}</Text>
          {" · effort "}<Text color={theme.colors.warning}>{choice.effort ?? harness.defaultEffort ?? "harness default"}</Text>
        </Text>
        <Text><Text color={theme.colors.primary}>Plan</Text>{"    "}<Text color={theme.colors.accent}>{harness.planModel}</Text></Text>
        <Text color={theme.colors.selection}>{runSelectorCommand(choice)}</Text>
      </Box>
      <Text>
        <Text color={theme.colors.primary}>↑↓</Text><Text dimColor> field · </Text>
        <Text color={theme.colors.primary}>←→</Text><Text dimColor> change · </Text>
        <Text color={theme.colors.primary}>space</Text><Text dimColor> toggle profile · </Text>
        <Text color={theme.colors.primary}>enter</Text><Text dimColor> launch (on Model: open list) · </Text>
        <Text color={theme.colors.primary}>esc</Text><Text dimColor> cancel</Text>
      </Text>
    </Box>
  )
}
