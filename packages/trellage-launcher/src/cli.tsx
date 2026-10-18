#!/usr/bin/env bun
import { constants, openSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { createInterface } from "node:readline"
import tty from "node:tty"
import path from "node:path"
import React from "react"
import { render } from "ink"
import { guideHeadlessHelpText, parseGuideHeadlessArgv, resolveGuideModelRouting } from "./guide-api.ts"
import { runGuideJsonCommand } from "./guide-command.ts"
import { loadCompositionCatalog, type CompositionCatalog } from "./composition-catalog.ts"
import { CopilotGuideProvider } from "./copilot-guide-provider.ts"
import { popupGuideIntentFileEnvironmentVariable, resolveInteractiveGuideIntent } from "./guide-interactive-intent.ts"
import { CopilotGoalAugmentProvider } from "./copilot-goal-augment-provider.ts"
import { createGuideGoalSkillResolver } from "./guide-goal-skills.ts"
import { GuideGoalError, type GuideGoalAugmentProvider } from "./guide-goal-augment.ts"
import { executeGuideUiResult } from "./guide-interactive-execution.ts"
import {
  createNodeCommandRunner,
  getHerdrContext,
  herdrEnvironment,
  probeHerdrAvailability,
  type HerdrEnvironment,
} from "./guide-launch.ts"
import { loadDefaultGuidePrompts } from "./guide-prompts.ts"
import { GuideArtifactCache } from "./guide-match-cache.ts"
import { resolveGuideCapabilities } from "./guide-capabilities.ts"
import { JevGuideMatcher } from "./jev-guide-matcher.ts"
import { adoptPrivateJevApiKey } from "./jev-decisions.ts"
import { createInitialGuideRenderHandler } from "./guide-terminal.ts"
import { GuideApp, type GuideUiResult } from "./guide-ui.tsx"
import { createGuideReviewServices } from "./review-services.ts"
import { GuideReviewApp } from "./review-flow-ui.tsx"
import { ContinuationApp } from "./continuation-ui.tsx"
import { ContinuationStore } from "./continuation-store.ts"
import { ContinuationSourceClient } from "./continuation-source-client.ts"
import { openContinuationRequest } from "./continuation-entry.ts"
import { createContinuationServices, resolveContinuationModelRouting } from "./continuation-runtime.ts"
import { createCopilotContinuationProvider } from "./continuation-provider.ts"
import { engagementDefaultIntent, inspectEngagementRepository } from "./engagement-context.ts"
import { createEngagementAssessor } from "./engagement-assessment.ts"
import { EngagementWorkStore, type EngagementWork } from "./engagement-work.ts"
import { EngagementApp, type EngagementUiProps, type EngagementUiResult } from "./engagement-ui.tsx"
import { executeEngagementWork } from "./engagement-execution.ts"
import { text as guideText } from "./guide-text.ts"
import { copyTextToClipboard } from "./ritual-clipboard.ts"
import { loadRitualCatalog, requireRitual } from "./ritual-catalog.ts"
import { RitualApp } from "./ritual-ui.tsx"
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

const readInput = async (): Promise<string> => {
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


const loadGuideCatalog = async (guideRoot: string): Promise<CompositionCatalog> => {
  const commandPath = process.env.TRELLAGE_TRX_COMMAND_PATH
  if (commandPath === undefined) throw new Error("guide requires TRELLAGE_TRX_COMMAND_PATH")
  return loadCompositionCatalog({ guideRoot, commandPath })
}

const runGuideJsonMode = async (
  argv: ReadonlyArray<string>,
  guideRoot: string,
  promptMasterSkillDirectory: string,
): Promise<void> => {
  const args = parseGuideHeadlessArgv(argv)
  const catalog = await loadGuideCatalog(guideRoot)
  const runner = createNodeCommandRunner()
  const stdinRequest = args.intent === undefined ? await readInput() : undefined
  const response = await runGuideJsonCommand({
    argv,
    catalog,
    guideRoot,
    promptMasterSkillDirectory,
    ...(stdinRequest === undefined ? {} : { stdinRequest }),
    env: process.env,
    cwd: process.cwd(),
    resolveCatalog: (signal) => resolveGuideCapabilities(catalog, runner, process.cwd(), signal),
  })
  process.stdout.write(`${JSON.stringify(response)}\n`)
}

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

/**
 * Ink leaves stdin in flowing mode after it unmounts. A paused, listener-free
 * stdin lets a launched child harness receive every key from the terminal.
 */
const releaseStdin = (): void => {
  if (process.stdin.isTTY) process.stdin.setRawMode(false)
  process.stdin.removeAllListeners("data")
  process.stdin.removeAllListeners("readable")
  process.stdin.pause()
  process.stdin.unref()
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
        else releaseStdin()
        if (output !== process.stderr) output.destroy()
      },
    }
  } catch (cause) {
    if (input !== undefined && input !== process.stdin) input.destroy()
    throw normalizeInteractiveTerminalError(cause)
  }
}

const interactiveGuideMatcher = (
  cwd: string,
): JevGuideMatcher => new JevGuideMatcher({ cwd, env: process.env })

const completeInteractiveGuideResult = async (
  result: GuideUiResult,
  catalog: CompositionCatalog,
  runner: ReturnType<typeof createNodeCommandRunner>,
): Promise<void> => {
  if (result.action === "review") {
    await runOptimizeMode(["--review"], catalog)
    return
  }
  process.exitCode = await executeGuideUiResult(result, {
    runner,
    write: (text) => process.stdout.write(text),
  })
}

const isChangeReview = (args: ReturnType<typeof parseGuideHeadlessArgv>): boolean => Boolean(args.review)
const reviewModelOverrides = (
  args: ReturnType<typeof parseGuideHeadlessArgv>, routing: ReturnType<typeof resolveGuideModelRouting>,
) => ({
  ...(args.model ?? process.env.TRELLAGE_GUIDE_MODEL ? { model: routing.optimize.model } : {}),
  ...(args.effort ?? process.env.TRELLAGE_GUIDE_EFFORT ? { effort: routing.optimize.effort } : {}),
})

const writeRitualPrompt = (prompt: string): void => {
  process.stdout.write(prompt.endsWith("\n") ? prompt : `${prompt}\n`)
}

const runRitualOutput = async (args: ReturnType<typeof parseGuideHeadlessArgv>): Promise<void> => {
  const ritual = requireRitual(await loadRitualCatalog({ env: process.env }), args.ritualId ?? "")
  if (args.ritualPrint) {
    writeRitualPrompt(ritual.prompt)
    return
  }
  copyTextToClipboard(ritual.prompt)
  process.stdout.write("Copied. Paste it into the current agent.\n")
}

const runRitualMode = async (args: ReturnType<typeof parseGuideHeadlessArgv>): Promise<void> => {
  if (args.ritualPrint || args.ritualCopy) {
    await runRitualOutput(args)
    return
  }
  const catalog = await loadRitualCatalog({ env: process.env })
  const terminal = openInteractiveTerminalStreams()
  try {
    const instance = render(
      <RitualApp
        catalog={catalog}
        {...(args.ritualId === undefined ? {} : { selectedId: args.ritualId })}
        copy={copyTextToClipboard}
      />,
      {
        stdin: terminal.input,
        stdout: terminal.output,
        interactive: true,
        exitOnCtrlC: false,
        kittyKeyboard: { mode: "disabled" },
        alternateScreen: true,
        onRender: createInitialGuideRenderHandler((value) => {
          terminal.output.write(value)
        }, process.env.INK_SCREEN_READER !== "true"),
        maxFps: 30,
      },
    )
    await instance.waitUntilExit()
  } finally {
    terminal.close()
  }
}

const runAlternateGuideMode = async (
  args: ReturnType<typeof parseGuideHeadlessArgv>,
  argv: ReadonlyArray<string>,
  guideRoot: string,
  promptMasterSkillDirectory: string,
): Promise<boolean> => {
  if (args.ritual) {
    await runRitualMode(args)
    return true
  }
  if (args.engagement) {
    await runEngagementMode(argv, guideRoot)
    return true
  }
  if (isChangeReview(args)) {
    await runOptimizeMode(argv, undefined, guideRoot)
    return true
  }
  if (args.nextSteps) {
    await runContinuationMode(argv, guideRoot, promptMasterSkillDirectory)
    return true
  }
  return false
}

const runInteractiveGuideMode = async (
  argv: ReadonlyArray<string>,
  guideRoot: string,
  promptMasterSkillDirectory: string,
): Promise<void> => {
  const args = parseGuideHeadlessArgv(argv)
  if (await runAlternateGuideMode(args, argv, guideRoot, promptMasterSkillDirectory)) return
  const herdrEnv = herdrEnvironment()
  const herdrContext = getHerdrContext(herdrEnv)
  const initialIntent = await resolveInteractiveGuideIntent({
    args,
    herdrContext,
    env: process.env,
    readStdin: () => readInput(),
  })
  const catalog = await loadGuideCatalog(guideRoot)
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
  const matcher = interactiveGuideMatcher(cwd)
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
        matcher={matcher}
        resolveCatalog={(signal) => resolveGuideCapabilities(catalog, runner, cwd, signal)}
        goalProvider={goalProvider}
        cache={cache}
        routing={routing}
        reviewModelOverrides={reviewModelOverrides(args, routing)}
        runner={runner}
        cwd={cwd}
        herdrEnv={herdrEnv}
        herdrAvailabilityProbe={herdrAvailabilityProbe}
        {...(initialIntent === undefined ? {} : { initialIntent })}
        {...(args.uiVariant === undefined ? {} : { uiVariant: args.uiVariant })}
        {...(args.optimize ? { openOptimize: true } : {})}
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
  await completeInteractiveGuideResult(result, catalog, runner)
}

const renderEngagementUi = async (props: Omit<EngagementUiProps, "onResult">): Promise<EngagementUiResult> => {
  const terminal = openInteractiveTerminalStreams()
  const result: { current: EngagementUiResult } = { current: { action: "exit", exitCode: 130 } }
  try {
    const instance = render(<EngagementApp {...props} onResult={(value) => { result.current = value }} />, {
      stdin: terminal.input, stdout: terminal.output, interactive: true,
      exitOnCtrlC: false, kittyKeyboard: { mode: "disabled" }, alternateScreen: true,
      onRender: createInitialGuideRenderHandler((value) => { terminal.output.write(value) }, process.env.INK_SCREEN_READER !== "true"),
      maxFps: 30,
    })
    await instance.waitUntilExit()
    return result.current
  } finally {
    terminal.close()
  }
}

const runEngagementMode = async (argv: ReadonlyArray<string>, guideRoot: string): Promise<void> => {
  const args = parseGuideHeadlessArgv(argv)
  const context = getHerdrContext(herdrEnvironment())
  if (context?.surface === "popup" || process.env[popupGuideIntentFileEnvironmentVariable] !== undefined) {
    throw new Error("Engagement mode needs a normal terminal in the engagement worktree, not a conversation or prompt popup.")
  }
  const intent = guideText(args.intentStdin ? await readInput() : args.intent ?? engagementDefaultIntent,
    "engagement intent", 8000, { multiline: true, preserve: true })
  const runner = createNodeCommandRunner()
  const repository = await inspectEngagementRepository(runner, context?.cwd ?? process.cwd())
  const catalog = await loadGuideCatalog(guideRoot)
  const routing = resolveGuideModelRouting({
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
  }, process.env)
  const store = new EngagementWorkStore(repository.root, catalog, runner)
  const assessor = createEngagementAssessor(catalog, routing.match)
  await runEngagementSession({
    repository, intent, runner, catalog, guideRoot, store, assessor,
    modelLabel: `${routing.match.model} / ${routing.match.effort}`,
  })
}

const runEngagementSession = async (
  props: Omit<EngagementUiProps, "onResult" | "records" | "initialWork" | "notice">,
): Promise<void> => {
  const { repository, intent, runner, catalog, guideRoot, store } = props
  let initialWork: EngagementWork | undefined
  let notice: string | undefined
  for (;;) {
    const result = await renderEngagementUi({
      ...props,
      repository: await inspectEngagementRepository(runner, repository.root),
      intent: initialWork?.request.intent ?? intent,
      store, records: await store.list(),
      ...(initialWork === undefined ? {} : { initialWork }),
      ...(notice === undefined ? {} : { notice }),
    })
    if (result.action === "exit") {
      process.exitCode = result.exitCode
      return
    }
    try {
      const returned = await executeEngagementWork(result.work, store, catalog, guideRoot, {
        runner, write: (value) => { process.stdout.write(value) },
      })
      initialWork = returned.work
      notice = returned.notice
    } catch (cause) {
      initialWork = await store.read(result.work.request.id)
      notice = `Execution stopped: ${cause instanceof Error ? cause.message : String(cause)}`
    }
  }
}

const runOptimizeMode = async (argv: ReadonlyArray<string>, catalog?: CompositionCatalog, guideRoot?: string): Promise<void> => {
  const args = parseGuideHeadlessArgv(argv)
  const env = herdrEnvironment()
  const context = getHerdrContext(env)
  const originalIntent = await resolveInteractiveGuideIntent({
    args, herdrContext: context, env: process.env, readStdin: () => readInput(),
  })
  const runner = createNodeCommandRunner()
  const cwd = context?.surface === "popup" ? context.cwd ?? process.cwd() : process.cwd()
  const routing = resolveGuideModelRouting({
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
  }, process.env)
  const resolvedCatalog = catalog ?? await loadGuideCatalog(guideRoot ?? (() => { throw new Error("review requires GUIDE_ROOT") })())
  const services = createGuideReviewServices({ runner, cwd, context, catalog: resolvedCatalog, routing,
    modelOverrides: reviewModelOverrides(args, routing),
  })
  const terminal = openInteractiveTerminalStreams()
  let result: GuideUiResult
  try {
    const instance = render(<GuideReviewApp services={services} originalIntent={originalIntent} initialBase={args.reviewBase} />, {
      stdin: terminal.input,
      stdout: terminal.output,
      interactive: true,
      exitOnCtrlC: false,
      kittyKeyboard: { mode: "disabled" },
      alternateScreen: true,
      onRender: createInitialGuideRenderHandler((value) => terminal.output.write(value), process.env.INK_SCREEN_READER !== "true"),
      maxFps: 30,
    })
    const resolved = await instance.waitUntilExit()
    if (resolved === undefined) {
      process.exitCode = 130
      return
    }
    result = resolved as GuideUiResult
  } finally {
    terminal.close()
  }
  process.exitCode = await executeGuideUiResult(result, { runner, write: (value) => process.stdout.write(value) })
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
  const catalog = await loadGuideCatalog(guideRoot)
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
    jevDecision: { cwd: process.cwd() },
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
 * works with no Copilot credentials.
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
  const guideRoot = process.argv[3] ?? process.env.TRELLAGE_TRX_GUIDE_ROOT
  if (guideRoot === undefined) throw new Error("admin requires GUIDE_ROOT")
  const commandPath = path.resolve(process.env.TRELLAGE_TRX_COMMAND_PATH ?? process.argv[1] ?? "trx")
  const catalog = await loadCompositionCatalog({ guideRoot, commandPath })
  const runner = createNodeCommandRunner()
  const runManager = new AdminRunManager({ runner })
  const diagnosisProvider = new DoctorFailureDiagnosisProvider({ jev: { cwd: process.cwd() } })
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
        routerCommandPath={commandPath}
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
    const guideRoot = process.env.TRELLAGE_TRX_GUIDE_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../profile-guides")
    const commandPath = path.resolve(process.env.TRELLAGE_TRX_COMMAND_PATH ?? process.argv[1] ?? "trx")
    process.exitCode = await runHarnessUpgradeCli({
      argv: process.argv.slice(3),
      readCatalog: () => loadCompositionCatalog({ guideRoot, commandPath }),
      runner: createNodeCommandRunner(),
      cwd: process.cwd(),
      routerCommandPath: commandPath,
      writeLine: (line) => process.stdout.write(`${line}\n`),
      confirm: confirmHarnessUpgradeMode,
      signal: controller.signal,
    })
  } finally {
    process.removeListener("SIGINT", cancel)
    process.removeListener("SIGTERM", cancel)
  }
}

const runRewriteContextMode = async (): Promise<void> => {
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
    const request = parseContextMenuUiRequest(await readInput())
    await runContextMenuUi({ request })
    return
  }
  const controller = new AbortController()
  const cancel = () => controller.abort()
  process.once("SIGINT", cancel)
  process.once("SIGTERM", cancel)
  try {
    await runContextMenuCommand({ input: await readInput(), signal: controller.signal })
  } finally {
    process.removeListener("SIGINT", cancel)
    process.removeListener("SIGTERM", cancel)
  }
}

export const main = async (): Promise<void> => {
  adoptPrivateJevApiKey()
  if (process.argv[2] === "rewrite-context") {
    await runRewriteContextMode()
    return
  }
  if (process.argv[2] === "upgrade") {
    await runHarnessUpgradeMode()
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
  if (process.argv[2] === "guide-review") {
    await runOptimizeMode(["--review", ...process.argv.slice(3)])
    return
  }
  if (process.argv[2] === "admin") {
    await runAdminMode()
    return
  }
  throw new Error(`unknown launcher mode: ${process.argv[2] ?? "(missing)"}`)
}


if (import.meta.main) {
  try {
    await main()
  } catch (error) {
    process.stderr.write(`trellage-launcher: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  }
}
