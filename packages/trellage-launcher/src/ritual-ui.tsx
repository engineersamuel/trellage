import React, { useState } from "react"
import { Box, Text, useApp, useInput } from "ink"

import { filterRituals, type Ritual, type RitualCatalog } from "./ritual-catalog.ts"

export interface RitualKey {
  readonly name?: string
  readonly escape?: boolean
  readonly return?: boolean
  readonly upArrow?: boolean
  readonly downArrow?: boolean
  readonly backspace?: boolean
  readonly ctrl?: boolean
}

export interface RitualScreen {
  readonly query: string
  readonly filtering: boolean
  readonly index: number
  readonly reading: boolean
  readonly status: string
}

const initialScreen = (catalog: RitualCatalog, selectedId: string | undefined): RitualScreen => {
  const index = selectedId === undefined ? 0 : Math.max(0, catalog.rituals.findIndex((ritual) => ritual.id === selectedId))
  const missing = selectedId !== undefined && !catalog.rituals.some((ritual) => ritual.id === selectedId)
  return {
    query: "",
    filtering: false,
    index,
    reading: false,
    status: missing ? `No prompt named ${selectedId}.` : "",
  }
}

const moveIndex = (index: number, count: number, delta: number): number => {
  if (count === 0) return 0
  return Math.min(count - 1, Math.max(0, index + delta))
}

const appendQuery = (query: string, input: string): string => (input.length === 1 && input >= " " ? `${query}${input}` : query)

/** Next list state for one key. Copy is a side effect the view performs when `copy` is true. */
export const nextRitualScreen = (
  screen: RitualScreen,
  input: string,
  key: RitualKey,
  count: number,
): { readonly screen: RitualScreen; readonly copy: boolean; readonly quit: boolean } => {
  if (key.escape || (input === "q" && !screen.filtering) || (key.ctrl && key.name === "c")) {
    return { screen, copy: false, quit: true }
  }
  if (screen.filtering) return { screen: filterKey(screen, input, key), copy: false, quit: false }
  if (input === "/") return { screen: { ...screen, filtering: true, status: "" }, copy: false, quit: false }
  if (input === "v") return { screen: { ...screen, reading: !screen.reading }, copy: false, quit: false }
  if (key.upArrow || input === "k") return { screen: { ...screen, index: moveIndex(screen.index, count, -1) }, copy: false, quit: false }
  if (key.downArrow || input === "j") return { screen: { ...screen, index: moveIndex(screen.index, count, 1) }, copy: false, quit: false }
  if (key.return) return { screen, copy: count > 0, quit: false }
  return { screen, copy: false, quit: false }
}

const filterKey = (screen: RitualScreen, input: string, key: RitualKey): RitualScreen => {
  if (key.return) return { ...screen, filtering: false, index: 0 }
  if (key.backspace || key.name === "backspace") {
    return { ...screen, query: screen.query.slice(0, -1), index: 0 }
  }
  return { ...screen, query: appendQuery(screen.query, input), index: 0 }
}

const copySelection = (
  screen: RitualScreen,
  selected: Ritual | undefined,
  copy: (value: string) => void,
): RitualScreen => {
  if (selected === undefined) return { ...screen, status: "No prompt matches." }
  try {
    copy(selected.prompt)
    return { ...screen, status: "Copied. Paste it into the current agent." }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { ...screen, status: message, reading: true }
  }
}

export const RitualApp = ({
  catalog,
  selectedId,
  copy,
}: {
  readonly catalog: RitualCatalog
  readonly selectedId?: string
  readonly copy: (value: string) => void
}): React.ReactElement => {
  const { exit } = useApp()
  const [screen, setScreen] = useState(() => initialScreen(catalog, selectedId))
  const visible = filterRituals(catalog.rituals, screen.query)
  const selected = visible[screen.index]

  useInput((input, key) => {
    const next = nextRitualScreen(screen, input, key, visible.length)
    if (next.quit) {
      exit()
      return
    }
    setScreen(next.copy ? copySelection(next.screen, selected, copy) : next.screen)
  })

  return (
    <Box flexDirection="column">
      <Text bold>Prompt library</Text>
      {catalog.problems.map((entry) => (
        <Text key={entry.id} color="yellow">{entry.id}: {entry.message}</Text>
      ))}
      {screen.status.length > 0 ? <Text color="yellow">{screen.status}</Text> : null}
      {screen.filtering ? <Text>Filter: {screen.query}</Text> : null}
      {screen.reading && selected !== undefined ? (
        <Box flexDirection="column">
          <Text>{selected.title}</Text>
          <Text>{selected.prompt}</Text>
        </Box>
      ) : visible.length === 0 ? (
        <Text>No prompt matches.</Text>
      ) : (
        visible.map((ritual, index) => (
          <Text key={ritual.id} inverse={index === screen.index}>
            {index === screen.index ? "> " : "  "}{ritual.title}  {ritual.when}
          </Text>
        ))
      )}
      <Text dimColor>Enter copy  v read  / filter  q quit</Text>
    </Box>
  )
}
