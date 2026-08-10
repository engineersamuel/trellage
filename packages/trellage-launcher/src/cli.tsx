#!/usr/bin/env node
import { constants, openSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import tty from "node:tty"
import React, { useMemo, useState } from "react"
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink"
import { parseLaunchCatalog, type LaunchCatalog } from "./catalog.js"
import { detailRows, type DetailRow } from "./detail-layout.js"
import { tableColumns } from "./table-layout.js"
import {
  createLauncherState,
  cycleSort,
  moveSelection,
  selectModel,
  setQuery,
  visibleEntries,
  type LauncherState,
} from "./state.js"

interface LaunchIntent {
  readonly id: string
  readonly target: "current" | "herdr"
  readonly model?: string
}

const readCatalog = async (): Promise<string> => {
  const path = process.argv[2]
  if (path !== undefined) return readFile(path, "utf8")
  const chunks: Array<Buffer> = []
  let length = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    length += buffer.length
    if (length > 1024 * 1024) throw new Error("stdin exceeds 1048576 bytes")
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString("utf8")
}

const selectedEntry = (state: LauncherState) => state.entries.find(({ id }) => id === state.selectedId)
const detailColors: Record<
  NonNullable<DetailRow["label"]>,
  "blue" | "cyan" | "gray" | "green" | "magenta" | "yellow"
> = {
  Alias: "green",
  Binary: "blue",
  Arguments: "yellow",
  Description: "cyan",
  Harness: "yellow",
  Model: "magenta",
  Plugins: "blue",
  Skills: "green",
  MCPs: "cyan",
  Status: "gray",
}

const DetailLine = ({ row }: { readonly row: DetailRow }) => (
  <Text wrap="wrap">
    {row.label === undefined ? (
      "  "
    ) : (
      <Text bold color={detailColors[row.label]}>
        {row.label}:{" "}
      </Text>
    )}
    {row.text}
  </Text>
)

const Launcher = ({
  catalog,
  herdrAvailable,
}: {
  readonly catalog: LaunchCatalog
  readonly herdrAvailable: boolean
}) => {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const [state, updateState] = useState(() => createLauncherState(catalog.entries))
  const [searching, setSearching] = useState(false)
  const [choosingModel, setChoosingModel] = useState(false)
  const [modelIndex, setModelIndex] = useState(0)
  const [editingCustomModel, setEditingCustomModel] = useState(false)
  const [customModel, setCustomModel] = useState("")
  const [showingDetails, setShowingDetails] = useState(false)
  const [detailOffset, setDetailOffset] = useState(0)
  const visible = useMemo(() => visibleEntries(state), [state])
  const selected = selectedEntry(state)
  const selectedModel = selected === undefined ? undefined : state.modelByEntry[selected.id]
  const model = selected === undefined ? undefined : (selectedModel ?? selected.defaultModel)
  const forwardedModel =
    selectedModel === undefined || selectedModel === selected?.defaultModel ? undefined : selectedModel
  const expandedDetails = useMemo(
    () => (selected === undefined ? [] : detailRows(selected, model, Math.max(16, columns - 4), forwardedModel)),
    [selected, model, columns, forwardedModel],
  )

  const finish = (target: LaunchIntent["target"]) => {
    if (selected === undefined) return
    exit({
      id: selected.id,
      target,
      ...(forwardedModel === undefined ? {} : { model: forwardedModel }),
    } satisfies LaunchIntent)
  }

  useInput((input, key) => {
    if (showingDetails) {
      const maximumOffset = Math.max(0, expandedDetails.length - Math.max(1, rows - 4))
      if (key.escape || input === "D" || input === "q") {
        setShowingDetails(false)
      } else if (key.upArrow || input === "k") {
        setDetailOffset((offset) => Math.max(0, offset - 1))
      } else if (key.downArrow || input === "j") {
        setDetailOffset((offset) => Math.min(maximumOffset, offset + 1))
      }
      return
    }

    if (editingCustomModel && selected !== undefined) {
      if (key.escape) {
        setEditingCustomModel(false)
      } else if (key.return || input === "\r" || input === "\n" || input === "") {
        if (customModel.length > 0) {
          updateState((current) => selectModel(current, selected.id, customModel))
          setEditingCustomModel(false)
          setChoosingModel(false)
        }
      } else if (key.backspace || key.delete) {
        setCustomModel((value) => value.slice(0, -1))
      } else if (
        !key.ctrl &&
        !key.meta &&
        input.length > 0 &&
        customModel.length + input.length <= 256 &&
        !/[\u0000-\u001f\u007f-\u009f]/u.test(input)
      ) {
        setCustomModel((value) => value + input)
      }
      return
    }

    if (choosingModel && selected !== undefined) {
      const choiceCount = selected.models.length + 1
      if (key.escape) {
        setChoosingModel(false)
      } else if (key.upArrow || input === "k") {
        setModelIndex((index) => (index - 1 + choiceCount) % choiceCount)
      } else if (key.downArrow || input === "j") {
        setModelIndex((index) => (index + 1) % choiceCount)
      } else if (
        input.toLocaleLowerCase("en") === "l" ||
        key.return ||
        input === "\r" ||
        input === "\n" ||
        input === ""
      ) {
        if (modelIndex === selected.models.length) {
          setCustomModel("")
          setEditingCustomModel(true)
        } else {
          updateState((current) => selectModel(current, selected.id, selected.models[modelIndex]!))
          setChoosingModel(false)
        }
      }
      return
    }

    if (searching) {
      if (key.escape || key.return || input === "\r" || input === "\n" || input === "") {
        setSearching(false)
      } else if (key.backspace || key.delete) {
        updateState((current) => setQuery(current, current.query.slice(0, -1)))
      } else if (!key.ctrl && !key.meta && input.length > 0) {
        updateState((current) => setQuery(current, current.query + input))
      }
      return
    }

    if (key.escape || (key.ctrl && input === "c") || input === "q") {
      exit({ cancelled: true, exitCode: 130 })
    } else if (key.upArrow || input === "k") {
      updateState((current) => moveSelection(current, -1))
    } else if (key.downArrow || input === "j") {
      updateState((current) => moveSelection(current, 1))
    } else if (input === "/") {
      setSearching(true)
    } else if (input.toLocaleLowerCase("en") === "s") {
      updateState(cycleSort)
    } else if (input.toLocaleLowerCase("en") === "m" && selected?.modelOverrideSupported) {
      const active = state.modelByEntry[selected.id] ?? selected.defaultModel
      setModelIndex(Math.max(0, selected.models.indexOf(active ?? selected.models[0]!)))
      setChoosingModel(true)
    } else if (input === "D" && selected !== undefined) {
      setDetailOffset(0)
      setShowingDetails(true)
    } else if (input === "H" && herdrAvailable) {
      finish("herdr")
    } else if (
      input.toLocaleLowerCase("en") === "l" ||
      key.return ||
      input === "\r" ||
      input === "\n" ||
      input === ""
    ) {
      finish("current")
    }
  })

  const maximumSummaryRows = Math.max(4, Math.floor(rows * 0.35))
  const summaryRows = expandedDetails.slice(0, maximumSummaryRows)
  const summaryTruncated = summaryRows.length < expandedDetails.length
  const introRows =
    catalog.description === undefined
      ? 0
      : Math.ceil((catalog.description.length + "Context: ".length) / Math.max(1, columns - 2))
  const capacity = Math.max(1, Math.min(visible.length, rows - summaryRows.length - introRows - 8))
  const selectedIndex = Math.max(
    0,
    visible.findIndex(({ id }) => id === state.selectedId),
  )
  const start = Math.max(0, Math.min(selectedIndex - Math.floor(capacity / 2), visible.length - capacity))
  const shown = visible.slice(start, start + capacity)
  const widths = useMemo(() => tableColumns(visible, columns), [visible, columns])
  const detailCapacity = Math.max(1, rows - 4)
  const visibleDetails = expandedDetails.slice(detailOffset, detailOffset + detailCapacity)

  if (showingDetails && selected !== undefined) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box justifyContent="space-between">
          <Text bold color="cyan">
            Profile details
          </Text>
          <Text dimColor>
            {detailOffset + 1}–{Math.min(expandedDetails.length, detailOffset + detailCapacity)} of{" "}
            {expandedDetails.length}
          </Text>
        </Box>
        <Text>
          <Text bold color="green">
            {selected.profile}
          </Text>{" "}
          <Text dimColor>· {selected.harness}</Text>
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {visibleDetails.map((row, index) => (
            <DetailLine key={`${detailOffset + index}:${row.label ?? "continuation"}`} row={row} />
          ))}
        </Box>
        <Text dimColor>↑/↓ or j/k scroll · D/Esc/q back</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">
          {catalog.prompt}
        </Text>
        <Text dimColor>
          Sort: {state.sort} · Herdr: {herdrAvailable ? "available" : "unavailable"}
        </Text>
      </Box>
      {catalog.description === undefined ? null : (
        <Text wrap="wrap">
          <Text bold color="blue">
            Context:{" "}
          </Text>
          {catalog.description}
        </Text>
      )}
      <Text {...(searching ? { color: "yellow" as const } : {})}>
        Search: {state.query}
        {searching ? "█" : ""}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        <Box>
          <Box width={2}>
            <Text> </Text>
          </Box>
          <Box width={widths.harness}>
            <Text bold color="yellow">
              HARNESS
            </Text>
          </Box>
          <Box width={widths.profile}>
            <Text bold color="cyan">
              PROFILE
            </Text>
          </Box>
          <Box width={widths.model}>
            <Text bold color="magenta">
              MODEL
            </Text>
          </Box>
        </Box>
        {shown.length === 0 ? (
          <Text color="yellow">No matching profiles</Text>
        ) : (
          shown.map((entry) => {
            const active = entry.id === state.selectedId
            const entryModel = state.modelByEntry[entry.id] ?? entry.defaultModel
            const modelLabel =
              entryModel === undefined ? "—" : `${entryModel}${entry.modelOverrideSupported ? "" : " (pinned)"}`
            return (
              <Box key={entry.id}>
                <Box width={2}>
                  <Text bold={active} {...(active ? { color: "green" as const } : {})}>
                    {active ? "❯ " : "  "}
                  </Text>
                </Box>
                <Box width={widths.harness}>
                  <Text bold={active} color="yellow" dimColor={!active} wrap="truncate-end">
                    {entry.harness}
                  </Text>
                </Box>
                <Box width={widths.profile}>
                  <Text bold={active} color="cyan" dimColor={!active} wrap="truncate-end">
                    {entry.profile}
                  </Text>
                </Box>
                <Box width={widths.model}>
                  <Text bold={active} color="magenta" dimColor={!active} wrap="truncate-end">
                    {modelLabel}
                  </Text>
                </Box>
              </Box>
            )
          })
        )}
      </Box>
      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
        {selected === undefined ? (
          <Text>Adjust the search to select a profile.</Text>
        ) : (
          <>
            <Text>
              <Text bold color="green">
                {selected.profile}
              </Text>{" "}
              <Text dimColor>· {selected.harness}</Text>
            </Text>
            {summaryRows.map((row, index) => (
              <DetailLine key={`${index}:${row.label ?? "continuation"}`} row={row} />
            ))}
            {summaryTruncated ? <Text color="yellow">More metadata available — press D for full details.</Text> : null}
          </>
        )}
      </Box>
      {choosingModel && selected !== undefined ? (
        <Box flexDirection="column" borderStyle="double" borderColor="magenta" paddingX={1}>
          <Text bold>Select model</Text>
          {selected.models.map((candidate, index) => (
            <Text key={candidate} {...(index === modelIndex ? { color: "magenta" as const } : {})}>
              {index === modelIndex ? "❯ " : "  "}
              {candidate}
              {candidate === selected.defaultModel ? " (default)" : ""}
            </Text>
          ))}
          <Text {...(modelIndex === selected.models.length ? { color: "magenta" as const } : {})}>
            {modelIndex === selected.models.length ? "❯ " : "  "}Custom…
          </Text>
          {editingCustomModel ? (
            <Text>
              Model ID: <Text color="yellow">{customModel}█</Text>
            </Text>
          ) : null}
        </Box>
      ) : null}
      <Text dimColor>
        ↑↓ move · / search · S sort · M model · D details · ↵ launch{herdrAvailable ? " · H Herdr" : ""} · Esc
      </Text>
    </Box>
  )
}

const main = async () => {
  const catalog = parseLaunchCatalog(await readCatalog())
  let outputFd: number | undefined
  let input: NodeJS.ReadStream
  let output: NodeJS.WriteStream
  try {
    input = process.stdin.isTTY ? process.stdin : new tty.ReadStream(openSync("/dev/tty", constants.O_RDONLY))
    output = process.stderr.isTTY
      ? process.stderr
      : new tty.WriteStream((outputFd = openSync("/dev/tty", constants.O_WRONLY)))
  } catch {
    throw new Error("an interactive controlling terminal is required")
  }
  try {
    const instance = render(
      <Launcher
        catalog={catalog}
        herdrAvailable={process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_PANE_ID)}
      />,
      {
        stdin: input,
        stdout: output,
        interactive: true,
        exitOnCtrlC: false,
        kittyKeyboard: { mode: "disabled" },
        alternateScreen: true,
        maxFps: 30,
      },
    )
    const result = (await instance.waitUntilExit()) as
      | LaunchIntent
      | { readonly cancelled: true; readonly exitCode: number }
    if ("cancelled" in result) {
      process.exitCode = result.exitCode
      return
    }
    const serialized = `${JSON.stringify(result)}\n`
    const resultPath = process.argv[3]
    if (resultPath === undefined) process.stdout.write(serialized)
    else await writeFile(resultPath, serialized, { mode: 0o600 })
  } finally {
    if (input !== process.stdin) input.destroy()
    if (output !== process.stderr) output.destroy()
  }
}

try {
  await main()
} catch (error) {
  process.stderr.write(`trellage-launcher: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
