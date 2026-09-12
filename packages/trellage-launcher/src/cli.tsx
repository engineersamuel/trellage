#!/usr/bin/env bun
import { constants, openSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import tty from "node:tty"
import path from "node:path"
import React, { useMemo, useState } from "react"
import { Box, Text, render, useApp, useInput, useWindowSize } from "ink"
import { parseLaunchCatalog, type LaunchCatalog } from "./catalog.ts"
import { detailRows, type DetailRow } from "./detail-layout.ts"
import {
  handleCommandInput,
  handleCustomModelInput,
  handleDetailsInput,
  handleModelInput,
  handleSearchInput,
  type LaunchTarget,
} from "./input.ts"
import { tableColumns } from "./table-layout.ts"
import { enrichNativeProfileList } from "./native-guide-list.ts"
import { createLauncherState, visibleEntries, type LaunchEntry, type LauncherState } from "./state.ts"
import { guideHeadlessHelpText, parseGuideHeadlessArgv, resolveGuideModelRouting } from "./guide-api.ts"
import { readGuideCatalog, runGuideJsonCommand } from "./guide-command.ts"
import { CopilotGuideProvider } from "./copilot-guide-provider.ts"
import { popupGuideIntentFileEnvironmentVariable, resolveInteractiveGuideIntent } from "./guide-interactive-intent.ts"
import { CopilotGoalAugmentProvider } from "./copilot-goal-augment-provider.ts"
import { createGuideGoalSkillResolver } from "./guide-goal-skills.ts"
import { GuideGoalError, type GuideGoalAugmentProvider } from "./guide-goal-augment.ts"
import { executeGuideUiResult } from "./guide-interactive-execution.ts"
import {
  createNodeCommandRunner,
  getHerdrContext,
  probeHerdrAvailability,
  type HerdrEnvironment,
} from "./guide-launch.ts"
import { loadDefaultGuidePrompts } from "./guide-prompts.ts"
import { GuideArtifactCache } from "./guide-match-cache.ts"
import { createInitialGuideRenderHandler } from "./guide-terminal.ts"
import { GuideApp, type GuideUiResult } from "./guide-ui.tsx"
import { ContinuationApp } from "./continuation-ui.tsx"
import { ContinuationStore } from "./continuation-store.ts"
import { ContinuationSourceClient } from "./continuation-source-client.ts"
import { openContinuationRequest } from "./continuation-entry.ts"
import { createContinuationServices, resolveContinuationModelRouting } from "./continuation-runtime.ts"
import { createCopilotContinuationProvider } from "./continuation-provider.ts"
import {
  BasketPreviewApp,
  basketPreviewHelpText,
  parseBasketPreviewArgv,
  type BasketPreviewResult,
} from "./basket-preview.tsx"
import { ForkPreviewApp, forkPreviewHelpText, parseForkPreviewArgv, type ForkPreviewResult } from "./fork-preview.tsx"
import { AdminRoot } from "./admin-ui.tsx"
import { AdminRunManager } from "./admin-run-manager.ts"
import { DoctorFailureDiagnosisProvider } from "./admin-diagnosis-provider.ts"
import {
  confirmHarnessUpgrade,
  InteractiveTerminalRequiredError,
  normalizeInteractiveTerminalError,
  runHarnessUpgradeCli,
  type HarnessUpgradeConfirmation,
} from "./harness-upgrade-cli.ts"
import { parseContextMenuUiRequest, runContextMenuCommand } from "./context-menu-command.ts"
import { runContextMenuUi } from "./context-menu-ui.tsx"

interface LaunchIntent {
  readonly id: string
  readonly target: LaunchTarget
  readonly model?: string
}

const readInput = async (filename: string | undefined): Promise<string> => {
  if (filename !== undefined) return readFile(filename, "utf8")
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

const readContextMenuWorkerInput = async (onDisconnect: () => void): Promise<{
  readonly input: string
  readonly close: () => void
}> => {
  const reader = createInterface({ input: process.stdin, crlfDelay: Infinity })
  let disposed = false
  let lineReceived = false
  let resolveLine: ((value: string) => void) | undefined
  let rejectLine: ((error: Error) => void) | undefined
  const line = new Promise<string>((resolve, reject) => {
    resolveLine = resolve
    rejectLine = reject
  })
  const onLine = (value: string): void => {
    if (lineReceived) return
    lineReceived = true
    resolveLine?.(value)
  }
  const onClose = (): void => {
    if (disposed) return
    if (lineReceived) onDisconnect()
    else rejectLine?.(new Error("rewrite worker request is missing"))
  }
  reader.on("line", onLine)
  reader.on("close", onClose)
  const close = (): void => {
    if (disposed) return
    disposed = true
    reader.removeListener("line", onLine)
    reader.removeListener("close", onClose)
    reader.close()
  }
  try {
    return { input: await line, close }
  } catch (error) {
    close()
    throw error
  }
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
  Run: "green",
  Skills: "green",
  MCPs: "cyan",
  Sandbox: "green",
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

const DetailsView = ({
  selected,
  expandedDetails,
  visibleDetails,
  detailOffset,
  detailCapacity,
}: {
  readonly selected: LaunchEntry
  readonly expandedDetails: ReadonlyArray<DetailRow>
  readonly visibleDetails: ReadonlyArray<DetailRow>
  readonly detailOffset: number
  readonly detailCapacity: number
}) => (
  <Box flexDirection="column" paddingX={1}>
    <Box justifyContent="space-between">
      <Text bold color="cyan">
        Profile details
      </Text>
      <Text dimColor>
        {detailOffset + 1}–{Math.min(expandedDetails.length, detailOffset + detailCapacity)} of {expandedDetails.length}
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

type TableWidths = ReturnType<typeof tableColumns>

const ProfileTable = ({
  shown,
  state,
  widths,
}: {
  readonly shown: ReadonlyArray<LaunchEntry>
  readonly state: LauncherState
  readonly widths: TableWidths
}) => (
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
      <Box width={widths.sandbox}>
        {widths.sandbox === 0 ? null : (
          <Text bold color="green">
            SANDBOX
          </Text>
        )}
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
        const sandboxLabel = entry.sandbox === undefined ? "—" : entry.sandbox ? "true" : "false"
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
            <Box width={widths.sandbox}>
              {widths.sandbox === 0 ? null : (
                <Text bold={active} color="green" dimColor={!active} wrap="truncate-end">
                  {sandboxLabel}
                </Text>
              )}
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
)

const SelectionSummary = ({
  selected,
  summaryRows,
  summaryTruncated,
}: {
  readonly selected: LaunchEntry | undefined
  readonly summaryRows: ReadonlyArray<DetailRow>
  readonly summaryTruncated: boolean
}) => (
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
)

const ModelChooser = ({
  selected,
  modelIndex,
  editingCustomModel,
  customModel,
}: {
  readonly selected: LaunchEntry
  readonly modelIndex: number
  readonly editingCustomModel: boolean
  readonly customModel: string
}) => (
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
)

const ShortcutHelp = ({
  searching,
  herdrAvailable,
  remoteAvailable,
}: {
  readonly searching: boolean
  readonly herdrAvailable: boolean
  readonly remoteAvailable: boolean
}) => (
  <Text dimColor>
    {searching
      ? "Type to filter · ↑↓ move · ↵ launch · Esc commands · Ctrl-C cancel"
      : `↑↓ move · / search · S sort · M model · D details · ↵ launch${herdrAvailable ? " · H Herdr" : ""}${remoteAvailable ? " · R Remote" : ""} · Esc`}
  </Text>
)

const SelectionView = ({
  catalog,
  state,
  searching,
  herdrAvailable,
  remoteAvailable,
  shown,
  widths,
  selected,
  summaryRows,
  summaryTruncated,
  choosingModel,
  modelIndex,
  editingCustomModel,
  customModel,
}: {
  readonly catalog: LaunchCatalog
  readonly state: LauncherState
  readonly searching: boolean
  readonly herdrAvailable: boolean
  readonly remoteAvailable: boolean
  readonly shown: ReadonlyArray<LaunchEntry>
  readonly widths: TableWidths
  readonly selected: LaunchEntry | undefined
  readonly summaryRows: ReadonlyArray<DetailRow>
  readonly summaryTruncated: boolean
  readonly choosingModel: boolean
  readonly modelIndex: number
  readonly editingCustomModel: boolean
  readonly customModel: string
}) => (
  <Box flexDirection="column" paddingX={1}>
    <Box justifyContent="space-between">
      <Text bold color="cyan">
        {catalog.prompt}
      </Text>
      <Text dimColor>
        Sort: {state.sort} · Herdr: {herdrAvailable ? "available" : "unavailable"} · Remote:{" "}
        {remoteAvailable ? "available" : "unavailable"}
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
    <ProfileTable shown={shown} state={state} widths={widths} />
    <SelectionSummary selected={selected} summaryRows={summaryRows} summaryTruncated={summaryTruncated} />
    {choosingModel && selected !== undefined ? (
      <ModelChooser
        selected={selected}
        modelIndex={modelIndex}
        editingCustomModel={editingCustomModel}
        customModel={customModel}
      />
    ) : null}
    <ShortcutHelp searching={searching} herdrAvailable={herdrAvailable} remoteAvailable={remoteAvailable} />
  </Box>
)

const Launcher = ({
  catalog,
  herdrAvailable,
  remoteAvailable,
}: {
  readonly catalog: LaunchCatalog
  readonly herdrAvailable: boolean
  readonly remoteAvailable: boolean
}) => {
  const { exit } = useApp()
  const { columns, rows } = useWindowSize()
  const [state, updateState] = useState(() => createLauncherState(catalog.entries))
  const [searching, setSearching] = useState(true)
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
    const cancel = () => exit({ cancelled: true, exitCode: 130 })
    if (key.ctrl && input === "c") {
      cancel()
      return
    }
    if (showingDetails) {
      handleDetailsInput(input, key, expandedDetails.length, rows, setShowingDetails, setDetailOffset)
      return
    }
    if (editingCustomModel && selected !== undefined) {
      handleCustomModelInput(
        input,
        key,
        selected.id,
        customModel,
        updateState,
        setCustomModel,
        setEditingCustomModel,
        setChoosingModel,
      )
      return
    }
    if (choosingModel && selected !== undefined) {
      handleModelInput(
        input,
        key,
        selected,
        modelIndex,
        updateState,
        setChoosingModel,
        setEditingCustomModel,
        setCustomModel,
        setModelIndex,
      )
      return
    }
    if (searching) {
      handleSearchInput(input, key, updateState, setSearching, finish)
      return
    }
    handleCommandInput(
      input,
      key,
      state,
      selected,
      herdrAvailable,
      remoteAvailable,
      updateState,
      setSearching,
      setModelIndex,
      setChoosingModel,
      setDetailOffset,
      setShowingDetails,
      finish,
      cancel,
    )
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
      <DetailsView
        selected={selected}
        expandedDetails={expandedDetails}
        visibleDetails={visibleDetails}
        detailOffset={detailOffset}
        detailCapacity={detailCapacity}
      />
    )
  }

  return (
    <SelectionView
      catalog={catalog}
      state={state}
      searching={searching}
      herdrAvailable={herdrAvailable}
      remoteAvailable={remoteAvailable}
      shown={shown}
      widths={widths}
      selected={selected}
      summaryRows={summaryRows}
      summaryTruncated={summaryTruncated}
      choosingModel={choosingModel}
      modelIndex={modelIndex}
      editingCustomModel={editingCustomModel}
      customModel={customModel}
    />
  )
}

const runEnrichNativeList = async (): Promise<void> => {
  const guideRoot = process.argv[3]
  if (guideRoot === undefined) throw new Error("enrich-native-list requires GUIDE_ROOT")
  process.stdout.write(`${await enrichNativeProfileList(await readInput(undefined), guideRoot)}\n`)
}

const runGuideJsonMode = async (
  argv: ReadonlyArray<string>,
  guideRoot: string,
  promptMasterSkillDirectory: string,
): Promise<void> => {
  const args = parseGuideHeadlessArgv(argv)
  const catalog = readGuideCatalog()
  const stdinRequest = args.intent === undefined ? await readInput(undefined) : undefined
  const response = await runGuideJsonCommand({
    argv,
    catalog,
    guideRoot,
    promptMasterSkillDirectory,
    ...(stdinRequest === undefined ? {} : { stdinRequest }),
    env: process.env,
    cwd: process.cwd(),
  })
  process.stdout.write(`${JSON.stringify(response)}\n`)
}

const herdrEnvironment = (): HerdrEnvironment => ({
  ...(process.env.HERDR_ENV === undefined ? {} : { HERDR_ENV: process.env.HERDR_ENV }),
  ...(process.env.HERDR_WORKSPACE_ID === undefined ? {} : { HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID }),
  ...(process.env.HERDR_PANE_ID === undefined ? {} : { HERDR_PANE_ID: process.env.HERDR_PANE_ID }),
  ...(process.env.TRELLAGE_GUIDE_HERDR_CONTEXT_JSON === undefined
    ? {}
    : { TRELLAGE_GUIDE_HERDR_CONTEXT_JSON: process.env.TRELLAGE_GUIDE_HERDR_CONTEXT_JSON }),
})

const probeInteractiveHerdr = async (
  runner: ReturnType<typeof createNodeCommandRunner>,
  env: HerdrEnvironment,
  cwd: string,
): Promise<boolean> => {
  if (getHerdrContext(env) === null) return false
  try {
    return await probeHerdrAvailability(runner, { cwd, timeoutMs: 5_000 })
  } catch {
    return false
  }
}

interface InteractiveTerminalStreams {
  readonly input: NodeJS.ReadStream
  readonly output: NodeJS.WriteStream
  readonly close: () => void
}

const openInteractiveTerminalStreams = (): InteractiveTerminalStreams => {
  let input: NodeJS.ReadStream | undefined
  try {
    input = process.stdin.isTTY ? process.stdin : new tty.ReadStream(openSync("/dev/tty", constants.O_RDONLY))
    const openedInput = input
    const output = process.stderr.isTTY ? process.stderr : new tty.WriteStream(openSync("/dev/tty", constants.O_WRONLY))
    return {
      input: openedInput,
      output,
      close: () => {
        if (openedInput !== process.stdin) openedInput.destroy()
        if (output !== process.stderr) output.destroy()
      },
    }
  } catch (cause) {
    if (input !== undefined && input !== process.stdin) input.destroy()
    throw normalizeInteractiveTerminalError(cause)
  }
}

const runInteractiveGuideMode = async (
  argv: ReadonlyArray<string>,
  guideRoot: string,
  promptMasterSkillDirectory: string,
): Promise<void> => {
  const args = parseGuideHeadlessArgv(argv)
  if (args.nextSteps) {
    await runContinuationMode(argv, guideRoot, promptMasterSkillDirectory)
    return
  }
  const herdrEnv = herdrEnvironment()
  const herdrContext = getHerdrContext(herdrEnv)
  const initialIntent = await resolveInteractiveGuideIntent({
    args,
    herdrContext,
    env: process.env,
    readStdin: () => readInput(undefined),
  })
  const catalog = readGuideCatalog()
  const routing = resolveGuideModelRouting(
    {
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(args.effort === undefined ? {} : { effort: args.effort }),
    },
    process.env,
  )
  const prompts = await loadDefaultGuidePrompts()
  const provider = new CopilotGuideProvider({ routing, prompts, promptMasterSkillDirectory })
  const runner = createNodeCommandRunner()
  const goalProvider: GuideGoalAugmentProvider = {
    async augment(input, context) {
      const managerPath = process.env.TRELLAGE_GUIDE_SKILLS_MANAGER
      const catalogPath = process.env.TRELLAGE_GUIDE_SKILLS_CATALOG
      const cachePath = process.env.TRELLAGE_GUIDE_NATIVE_SKILLS_CACHE
      if (!managerPath || !catalogPath || !cachePath) {
        throw new GuideGoalError("Goal me runtime paths are missing. Reinstall trx, then reopen trx guide.")
      }
      return new CopilotGoalAugmentProvider({
        resolveSkills: createGuideGoalSkillResolver({ managerPath, catalogPath, cachePath, runner }),
      }).augment(input, context)
    },
  }
  const cwd = herdrContext?.cwd ?? process.cwd()
  const cache = new GuideArtifactCache({ cwd, routing, prompts, promptMasterSkillDirectory })
  const herdrAvailabilityProbe = await probeInteractiveHerdr(runner, herdrEnv, cwd)
  if (herdrContext?.surface === "popup" && !herdrAvailabilityProbe) {
    throw new Error("Herdr is unavailable for this guide popup")
  }
  const terminal = openInteractiveTerminalStreams()
  const { input, output } = terminal
  const redrawInitialFrame = createInitialGuideRenderHandler((text) => {
    output.write(text)
  }, process.env.INK_SCREEN_READER !== "true")
  let result: GuideUiResult
  try {
    const instance = render(
      <GuideApp
        catalog={catalog}
        guideRoot={guideRoot}
        provider={provider}
        goalProvider={goalProvider}
        cache={cache}
        routing={routing}
        runner={runner}
        cwd={cwd}
        herdrEnv={herdrEnv}
        herdrAvailabilityProbe={herdrAvailabilityProbe}
        {...(initialIntent === undefined ? {} : { initialIntent })}
        {...(args.uiVariant === undefined ? {} : { uiVariant: args.uiVariant })}
      />,
      {
        stdin: input,
        stdout: output,
        interactive: true,
        exitOnCtrlC: false,
        kittyKeyboard: { mode: "disabled" },
        alternateScreen: true,
        onRender: redrawInitialFrame,
        maxFps: 30,
      },
    )
    const resolved = await instance.waitUntilExit()
    if (resolved === undefined) {
      process.exitCode = 130
      return
    }
    result = resolved as GuideUiResult
  } finally {
    terminal.close()
  }
  process.exitCode = await executeGuideUiResult(result, {
    runner,
    write: (text) => process.stdout.write(text),
  })
}

const runContinuationMode = async (
  argv: ReadonlyArray<string>,
  guideRoot: string,
  promptMasterSkillDirectory: string,
): Promise<void> => {
  const args = parseGuideHeadlessArgv(argv)
  if (process.env[popupGuideIntentFileEnvironmentVariable] !== undefined) {
    throw new Error("A conversation request cannot be combined with an ordinary guide intent file.")
  }
  const context = getHerdrContext(herdrEnvironment())
  if (context === null) throw new Error("Conversation next steps requires Herdr.")
  const stateRoot = process.env.HERDR_PLUGIN_STATE_DIR
  if (stateRoot === undefined || !path.isAbsolute(stateRoot)) {
    throw new Error("Conversation next steps requires the private Herdr plugin state directory.")
  }
  const runner = createNodeCommandRunner()
  const store = new ContinuationStore(stateRoot)
  const helperRoot = process.env.TRELLAGE_GUIDE_CONVERSATION_HELPER_ROOT ?? path.dirname(guideRoot)
  if (!path.isAbsolute(helperRoot)) throw new Error("The conversation helper root must be absolute.")
  const sourceClient = new ContinuationSourceClient({
    store,
    runner,
    repoRoot: helperRoot,
    env: process.env,
  })
  const routing = resolveGuideModelRouting(
    {
      ...(args.model === undefined ? {} : { model: args.model }),
      ...(args.effort === undefined ? {} : { effort: args.effort }),
    },
    process.env,
  )
  const { draft, hasSavedDraft } = await openContinuationRequest({
    store,
    sourceClient,
    context,
    requestPath: process.env.TRELLAGE_GUIDE_CONVERSATION_REQUEST_FILE,
    model: routing.match.model,
    effort: routing.match.effort,
  })
  const catalog = readGuideCatalog()
  const prompts = await loadDefaultGuidePrompts()
  const services = createContinuationServices({
    store,
    sourceClient,
    catalog,
    guideRoot,
    runner,
    context,
    socketPath: process.env.HERDR_SOCKET_PATH ?? "",
    initialDraft: draft,
    assessmentProvider: (current) => createCopilotContinuationProvider(resolveContinuationModelRouting(current).match),
    preparationProvider: (current, signal) =>
      new CopilotGuideProvider({
        routing: resolveContinuationModelRouting(current),
        prompts,
        promptMasterSkillDirectory,
        signal,
      }),
  })
  const terminal = openInteractiveTerminalStreams()
  try {
    const instance = render(
      <ContinuationApp
        initialDraft={draft}
        services={services}
        hasSavedDraft={hasSavedDraft}
        onExit={(code) => {
          process.exitCode = code
        }}
      />,
      {
        stdin: terminal.input,
        stdout: terminal.output,
        interactive: true,
        exitOnCtrlC: false,
        kittyKeyboard: { mode: "disabled" },
        alternateScreen: true,
        onRender: createInitialGuideRenderHandler((text) => {
          terminal.output.write(text)
        }, process.env.INK_SCREEN_READER !== "true"),
        maxFps: 30,
      },
    )
    await instance.waitUntilExit()
  } finally {
    terminal.close()
  }
}

const runGuideMode = async (): Promise<void> => {
  const guideRoot = process.argv[3]
  if (guideRoot === undefined) throw new Error("guide requires GUIDE_ROOT")
  const promptMasterSkillDirectory = process.argv[4]
  if (promptMasterSkillDirectory === undefined) throw new Error("guide requires PROMPT_MASTER_SKILL_DIRECTORY")
  const argv = process.argv.slice(5)
  const args = parseGuideHeadlessArgv(argv)
  if (args.help) {
    process.stdout.write(`${guideHeadlessHelpText}\n`)
    return
  }
  if (args.json) {
    await runGuideJsonMode(argv, guideRoot, promptMasterSkillDirectory)
    return
  }
  await runInteractiveGuideMode(argv, guideRoot, promptMasterSkillDirectory)
}

/**
 * Renders one staged prompt basket layout from fixture data. It reads no
 * catalog, calls no provider, and runs no command, so it opens instantly and
 * works with no Docker and no Copilot credentials.
 */
const runGuidePreviewMode = async (): Promise<void> => {
  const args = parseBasketPreviewArgv(process.argv.slice(3))
  if (args.help) {
    process.stdout.write(`${basketPreviewHelpText}\n`)
    return
  }
  const terminal = openInteractiveTerminalStreams()
  let result: BasketPreviewResult
  try {
    const instance = render(<BasketPreviewApp />, {
      stdin: terminal.input,
      stdout: terminal.output,
      interactive: true,
      exitOnCtrlC: false,
      kittyKeyboard: { mode: "disabled" },
      alternateScreen: true,
      maxFps: 30,
    })
    const resolved = await instance.waitUntilExit()
    if (resolved === undefined) {
      process.exitCode = 130
      return
    }
    result = resolved as BasketPreviewResult
  } finally {
    terminal.close()
  }
  if (result.kind === "submitted") process.stdout.write(`${result.prompt}\n`)
}

const runForkPreviewMode = async (): Promise<void> => {
  const args = parseForkPreviewArgv(process.argv.slice(3))
  if (args.help) {
    process.stdout.write(`${forkPreviewHelpText}\n`)
    return
  }
  const terminal = openInteractiveTerminalStreams()
  let result: ForkPreviewResult
  try {
    const instance = render(<ForkPreviewApp variant={args.variant} />, {
      stdin: terminal.input,
      stdout: terminal.output,
      interactive: true,
      exitOnCtrlC: false,
      kittyKeyboard: { mode: "disabled" },
      alternateScreen: true,
      maxFps: 30,
    })
    const resolved = await instance.waitUntilExit()
    if (resolved === undefined) {
      process.exitCode = 130
      return
    }
    result = resolved as ForkPreviewResult
  } finally {
    terminal.close()
  }
  if (result.kind === "launched") process.stdout.write(`${result.lines.join("\n")}\n`)
}

const runAdminMode = async (): Promise<void> => {
  const guideRoot = process.argv[3]
  if (guideRoot === undefined) throw new Error("admin requires GUIDE_ROOT")
  const catalog = readGuideCatalog()
  const runner = createNodeCommandRunner()
  const runManager = new AdminRunManager({ runner })
  const diagnosisProvider = new DoctorFailureDiagnosisProvider()
  const terminal = openInteractiveTerminalStreams()
  const { input, output } = terminal
  try {
    const instance = render(
      <AdminRoot
        catalog={catalog}
        runner={runner}
        runManager={runManager}
        guideRoot={guideRoot}
        cwd={process.cwd()}
        diagnosisProvider={diagnosisProvider}
        herdrEnv={herdrEnvironment()}
        routerCommandPath={process.env.TRELLAGE_TRX_COMMAND_PATH ?? "trx"}
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
    await instance.waitUntilExit()
  } finally {
    terminal.close()
  }
}

const confirmHarnessUpgradeMode = async (signal?: AbortSignal): Promise<HarnessUpgradeConfirmation> => {
  let terminal: InteractiveTerminalStreams
  try {
    terminal = openInteractiveTerminalStreams()
  } catch (error) {
    if (error instanceof InteractiveTerminalRequiredError) return "unavailable"
    throw error
  }
  try {
    return await confirmHarnessUpgrade(terminal.input, terminal.output, signal)
  } finally {
    terminal.close()
  }
}

const runHarnessUpgradeMode = async (): Promise<void> => {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.on("SIGINT", cancel)
  process.on("SIGTERM", cancel)
  try {
    process.exitCode = await runHarnessUpgradeCli({
      argv: process.argv.slice(3),
      readCatalog: () => readGuideCatalog(0),
      runner: createNodeCommandRunner(),
      cwd: process.cwd(),
      routerCommandPath: process.env.TRELLAGE_TRX_COMMAND_PATH ?? "trx",
      writeLine: (line) => {
        process.stdout.write(`${line}\n`)
      },
      confirm: confirmHarnessUpgradeMode,
      signal: controller.signal,
    })
  } finally {
    process.removeListener("SIGINT", cancel)
    process.removeListener("SIGTERM", cancel)
  }
}

export const main = async (): Promise<void> => {
  if (process.argv[2] === "rewrite-context") {
    if (process.argv[3] === "--worker") {
      const controller = new AbortController()
      const cancel = () => controller.abort()
      process.once("SIGINT", cancel)
      process.once("SIGTERM", cancel)
      let workerInput: { readonly input: string; readonly close: () => void } | undefined
      try {
        workerInput = await readContextMenuWorkerInput(cancel)
        await runContextMenuCommand({ input: workerInput.input, signal: controller.signal })
      } finally {
        workerInput?.close()
        process.removeListener("SIGINT", cancel)
        process.removeListener("SIGTERM", cancel)
      }
      return
    }
    if (process.argv[3] === "--interactive") {
      const request = parseContextMenuUiRequest(await readInput(undefined))
      await runContextMenuUi({ request })
      return
    }
    const controller = new AbortController()
    const cancel = () => controller.abort()
    process.once("SIGINT", cancel)
    process.once("SIGTERM", cancel)
    try {
      await runContextMenuCommand({ input: await readInput(undefined), signal: controller.signal })
    } finally {
      process.removeListener("SIGINT", cancel)
      process.removeListener("SIGTERM", cancel)
    }
    return
  }
  if (process.argv[2] === "upgrade") {
    await runHarnessUpgradeMode()
    return
  }
  if (process.argv[2] === "enrich-native-list") {
    await runEnrichNativeList()
    return
  }
  if (process.argv[2] === "guide-preview") {
    await runGuidePreviewMode()
    return
  }
  if (process.argv[2] === "guide-forks") {
    await runForkPreviewMode()
    return
  }
  if (process.argv[2] === "guide") {
    await runGuideMode()
    return
  }
  if (process.argv[2] === "admin") {
    await runAdminMode()
    return
  }
  const catalog = parseLaunchCatalog(await readInput(process.argv[2]))
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
        remoteAvailable={process.env.TRELLAGE_REMOTE_AVAILABLE === "true"}
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

if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`trellage-launcher: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
