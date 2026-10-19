import React, { useEffect, useRef, useState } from "react"
import { stripVTControlCharacters } from "node:util"
import { Box, Text, useInput, type Key } from "ink"
import {
  buildGuideOptimizeHarnessCommand,
  buildGuideOptimizePrompt,
  guideOptimizeHarnesses,
  type GuideOptimizeHarness,
  guideOptimizeRunnerLabels,
  guideOptimizeRunners,
  guideOptimizeSkills,
  GuideOptimizeRunner,
  runGuideOptimizeSdk,
  selectGuideOptimizeSkills,
  updateGuideOptimizeLog,
  type GuideOptimizeActivity,
  type GuideOptimizeSdkOptions,
} from "./guide-optimize.ts"
import type { CompositionCatalog } from "./composition-catalog.ts"
import { ensureOptimizeSkills } from "./guide-optimize-skills.ts"
import {
  inspectGitWorktreeIntent,
  parseSelectedProfile,
  suggestWorktreeBranch,
  type CommandRunner,
  type CommandSpec,
  type HerdrContext,
  type NativeSelectedProfile,
} from "./guide-launch.ts"
import type { GuideModelConfig } from "./guide-model-routing.ts"
import { wrapGuideText } from "./guide-markdown.tsx"

/** A harness launch: `command` is `trx run HARNESS --no-always --skill ... -- PROMPT`. */
interface HarnessLaunch {
  readonly profile: NativeSelectedProfile
  readonly command: CommandSpec
  readonly prompt: string
}

export type GuideOptimizeLaunch =
  | ({ readonly runner: GuideOptimizeRunner.CurrentTerminal } & HarnessLaunch)
  | ({ readonly runner: GuideOptimizeRunner.NewHerdrTab } & HarnessLaunch)
  | ({
      readonly runner: GuideOptimizeRunner.NewHerdrWorktree
      readonly primaryCheckoutPath: string
      readonly branch: string
      readonly baseRef: string
    } & HarnessLaunch)

/** The `trx` router path; every Native catalog entry points at it. */
const routerPath = (catalog: CompositionCatalog): string | undefined => catalog.entries[0]?.commandPath

/** A placeholder Native profile for the harness: the real content comes from `--skill`. */
const harnessProfile = (trx: string, harness: GuideOptimizeHarness): NativeSelectedProfile => {
  return parseSelectedProfile({ surface: "native", harness, commandPath: trx, profiles: ["optimize"], headlessPrompt: false })
}

export interface GuideOptimizeScreenProps {
  readonly catalog: CompositionCatalog
  readonly cwd: string
  readonly runner: CommandRunner
  readonly herdrContext: HerdrContext | null
  readonly model: GuideModelConfig
  readonly rows: number
  readonly columns: number
  readonly terminalBlockedReason?: string | undefined
  readonly runSdk?: (options: GuideOptimizeSdkOptions) => Promise<void>
  readonly ensureSkills?: typeof ensureOptimizeSkills
  readonly onBack: () => void
  readonly onLaunch: (launch: GuideOptimizeLaunch) => void
}

type Stage =
  | { readonly kind: "skills" }
  | { readonly kind: "runner" }
  | { readonly kind: "preparing"; readonly runner: GuideOptimizeRunner }
  | { readonly kind: "harness"; readonly runner: GuideOptimizeRunner }
  | { readonly kind: "branch"; readonly harness: GuideOptimizeHarness; readonly branch: string; readonly checking: boolean }
  | { readonly kind: "sdk"; readonly status: "running" | "done" | "failed"; readonly log: ReadonlyArray<GuideOptimizeActivity> }

export const guideOptimizeDisplayLines = (log: ReadonlyArray<GuideOptimizeActivity>, columns: number) =>
  log.flatMap((entry) => {
    const tool = entry.kind === "tool"
    const text = tool ? `> ${entry.text.split("\n")[0]} [${entry.status}]` : entry.text
    const body = tool ? [...entry.text.split("\n").slice(1), ...entry.output.split("\n")] : []
    return [
      ...wrapGuideText(stripVTControlCharacters(text), columns).map((line) => ({ text: line, kind: entry.kind })),
      ...body.filter((line) => line !== "").flatMap((line) =>
        wrapGuideText(stripVTControlCharacters(line), columns - 4).map((part) => ({ text: `  | ${part}`, kind: "output" as const }))),
      { text: "", kind: "status" as const },
    ]
  })

const OptimizeSdkLog = ({ log, rows, columns }: {
  readonly log: ReadonlyArray<GuideOptimizeActivity>
  readonly rows: number
  readonly columns: number
}) => {
  const [scroll, setScroll] = useState(0)
  const lines = guideOptimizeDisplayLines(log, columns - 2)
  const page = Math.max(1, rows - 9)
  const maxScroll = Math.max(0, lines.length - page)
  useInput((_input, key) => {
    if (key.pageUp || key.upArrow) setScroll((current) => Math.min(maxScroll, current + (key.pageUp ? page : 1)))
    else if (key.pageDown || key.downArrow) setScroll((current) => Math.max(0, current - (key.pageDown ? page : 1)))
    else if (key.end) setScroll(0)
  })
  const end = lines.length - Math.min(scroll, maxScroll)
  return <Box flexDirection="column">
    {lines.slice(Math.max(0, end - page), end).map((line, lineIndex) => (
      <Text key={lineIndex} wrap="truncate-end" bold={line.kind === "tool"}
        dimColor={line.kind === "output" || line.kind === "status"}
        {...(line.kind === "error" ? { color: "red" } : line.kind === "tool" ? { color: "cyan" } : {})}>{line.text}</Text>
    ))}
  </Box>
}

const cycle = (index: number, delta: number, length: number): number => (length === 0 ? 0 : (index + delta + length) % length)
const movement = (input: string, key: Key): number | undefined =>
  key.upArrow || input === "k" ? -1 : key.downArrow || input === "j" ? 1 : undefined
const printable = (input: string, key: Key): boolean =>
  !key.ctrl && !key.meta && input.length > 0 && !/[\u0000-\u001f\u007f]/u.test(input)

const Choice = ({ active, children }: { readonly active: boolean; readonly children: React.ReactNode }) => (
  <Text bold={active} {...(active ? { color: "green" as const } : {})}>
    {active ? "> " : "  "}
    {children}
  </Text>
)

const optimizeFooter = (stage: Stage): string => {
  switch (stage.kind) {
    case "skills": return "↑/↓ or j/k move · Space select · ↵ continue · Esc back · q close"
    case "preparing": return "Esc cancel"
    case "branch": return stage.checking ? "Checking the branch…" : "Type a branch name · ↵ create worktree · Esc back"
    case "sdk": return `↑/↓ or PgUp/PgDn scroll · End latest · ${stage.status === "running" ? "Esc stop the agent" : "↵ or Esc return to Guide"}`
    default: return "↑/↓ or j/k move · ↵ choose · b back · q close"
  }
}

const OptimizeStageContent = ({ stage, index, selected, runners, model, rows, columns }: {
  readonly stage: Stage
  readonly index: number
  readonly selected: ReadonlySet<string>
  readonly runners: ReadonlyArray<GuideOptimizeRunner>
  readonly model: GuideModelConfig
  readonly rows: number
  readonly columns: number
}) => {
  switch (stage.kind) {
    case "skills": return guideOptimizeSkills.map((skill, itemIndex) => (
      <Choice key={skill.id} active={itemIndex === index}>
        [{selected.has(skill.id) ? "x" : " "}] {skill.title}
        <Text dimColor> · {skill.description}</Text>
      </Choice>
    ))
    case "runner": return runners.map((runner, itemIndex) => (
      <Choice key={runner} active={itemIndex === index}>{guideOptimizeRunnerLabels[runner]}</Choice>
    ))
    case "harness": return <>
      <Text>Harness for {guideOptimizeRunnerLabels[stage.runner]}. Guide loads only the selected skills; the harness keeps its own permission settings.</Text>
      {guideOptimizeHarnesses.map((harness, itemIndex) => (
        <Choice key={harness.id} active={itemIndex === index}>
          {harness.label}{harness.composable ? "" : <Text dimColor> · preset profiles only</Text>}
        </Choice>
      ))}
    </>
    case "preparing": return <Text>Preparing managed skills…</Text>
    case "branch": return <Text>Branch: {stage.branch}<Text inverse> </Text></Text>
    case "sdk": return <>
      <Text>
        Copilot SDK · {model.model} / {model.effort} · {stage.status === "done" ? "finished" : stage.status}
      </Text>
      <OptimizeSdkLog log={stage.log} rows={rows} columns={columns} />
    </>
  }
}

const handleOptimizeSdkInput = (
  stage: Extract<Stage, { kind: "sdk" }>, input: string, key: Key, abort: () => void, back: () => void,
): void => {
  if (stage.status === "running") {
    if (key.escape || (key.ctrl && input === "c")) abort()
  } else if (key.escape || key.return || input === "q") back()
}

const handleOptimizeBranchInput = (
  stage: Extract<Stage, { kind: "branch" }>, input: string, key: Key,
  setStage: (stage: Stage) => void, back: () => void,
  confirm: (stage: Extract<Stage, { kind: "branch" }>) => void,
): void => {
  if (stage.checking) return
  if (key.escape) back()
  else if (key.return) confirm(stage)
  else if (key.backspace || key.delete) setStage({ ...stage, branch: stage.branch.slice(0, -1) })
  else if (printable(input, key)) setStage({ ...stage, branch: stage.branch + input })
}

const handleOptimizeSkillInput = (
  input: string, key: Key, index: number, selected: ReadonlySet<string>,
  setSelected: (selected: ReadonlySet<string>) => void,
  setError: (error: string | undefined) => void, next: () => void,
): void => {
  const skill = guideOptimizeSkills[index]
  if (input === " " && skill !== undefined) {
    const selection = new Set(selected)
    if (!selection.delete(skill.id)) selection.add(skill.id)
    setSelected(selection)
    setError(undefined)
  } else if (key.return) {
    if (selected.size === 0) setError("Press Space to select one or more skills.")
    else next()
  }
}

const confirmOptimizeHarness = (
  stage: Extract<Stage, { kind: "harness" }>, index: number,
  setError: (error: string) => void, choose: (runner: GuideOptimizeRunner, harness: GuideOptimizeHarness) => void,
): void => {
  const harness = guideOptimizeHarnesses[index]
  if (harness === undefined) return
  if (!harness.composable) setError(`${harness.label} uses preset profiles and cannot load individual skills yet.`)
  else choose(stage.runner, harness.id)
}

interface OptimizeChoiceInput {
  readonly stage: Extract<Stage, { kind: "skills" | "runner" | "harness" }>
  readonly index: number
  readonly runners: ReadonlyArray<GuideOptimizeRunner>
  readonly selected: ReadonlySet<string>
  readonly setIndex: React.Dispatch<React.SetStateAction<number>>
  readonly setSelected: (selected: ReadonlySet<string>) => void
  readonly setError: (error: string | undefined) => void
  readonly goto: (stage: Stage) => void
  readonly back: () => void
  readonly chooseRunner: (runner: GuideOptimizeRunner) => void
  readonly chooseHarness: (runner: GuideOptimizeRunner, harness: GuideOptimizeHarness) => void
}

const handleOptimizeChoiceConfirm = (context: OptimizeChoiceInput, input: string, key: Key): void => {
  const { stage, index, runners } = context
  switch (stage.kind) {
    case "skills":
      handleOptimizeSkillInput(input, key, index, context.selected, context.setSelected, context.setError, () => context.goto({ kind: "runner" }))
      break
    case "runner": {
      const runner = runners[index]
      if (key.return && runner !== undefined) context.chooseRunner(runner)
      break
    }
    case "harness":
      if (key.return) confirmOptimizeHarness(stage, index, context.setError, context.chooseHarness)
      break
  }
}

const handleOptimizeChoiceInput = (context: OptimizeChoiceInput, input: string, key: Key): void => {
  const { stage } = context
  if (key.escape || input === "b") {
    if (stage.kind === "skills") context.back()
    else context.goto(stage.kind === "runner" ? { kind: "skills" } : { kind: "runner" })
    return
  }
  if (input === "q") {
    context.back()
    return
  }
  const lengths = { skills: guideOptimizeSkills.length, runner: context.runners.length, harness: guideOptimizeHarnesses.length }
  const delta = movement(input, key)
  if (delta !== undefined) context.setIndex((current) => cycle(current, delta, lengths[stage.kind]))
  else handleOptimizeChoiceConfirm(context, input, key)
}

export const GuideOptimizeScreen = (props: GuideOptimizeScreenProps) => {
  const [stage, setStage] = useState<Stage>({ kind: "skills" })
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [index, setIndex] = useState(0)
  const [error, setError] = useState<string | undefined>()
  const [skillDirectory, setSkillDirectory] = useState<string | undefined>()
  const controller = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => controller.current?.abort(), [])

  const runners = guideOptimizeRunners(props.herdrContext !== null)
  const trx = routerPath(props.catalog)
  const harnessLaunch = (harness: GuideOptimizeHarness): HarnessLaunch => {
    if (trx === undefined) throw new Error("The trx router is not in the catalog.")
    const text = prompt(undefined)
    const command = buildGuideOptimizeHarnessCommand(trx, harness, selectGuideOptimizeSkills([...selected]), text)
    return { profile: harnessProfile(trx, harness), command, prompt: text }
  }
  const prompt = (directory = skillDirectory) => buildGuideOptimizePrompt(selectGuideOptimizeSkills([...selected]), directory)
  const goto = (next: Stage) => {
    setStage(next)
    setIndex(0)
    setError(undefined)
  }

  const startSdk = (directory: string | undefined) => {
    const text = prompt(directory)
    const abort = new AbortController()
    controller.current = abort
    goto({ kind: "sdk", status: "running", log: [{ kind: "status", id: "starting", text: "Starting Copilot SDK." }] })
    const append = (activity: GuideOptimizeActivity) =>
      setStage((current) => (current.kind === "sdk" ? { ...current, log: updateGuideOptimizeLog(current.log, activity) } : current))
    void (props.runSdk ?? runGuideOptimizeSdk)({
      cwd: props.cwd, prompt: text, skillDirectory: directory, model: props.model, signal: abort.signal, onActivity: append,
    }).then(
      () => setStage((current) => (current.kind === "sdk" ? { ...current, status: "done" } : current)),
      (cause: unknown) => {
        append({ kind: "error", id: "failure", text: cause instanceof Error ? cause.message : String(cause) })
        setStage((current) => (current.kind === "sdk" ? { ...current, status: "failed" } : current))
      },
    )
  }

  const afterSkills = (runner: GuideOptimizeRunner, directory: string | undefined) => {
    if (runner === GuideOptimizeRunner.CopilotSdk) startSdk(directory)
    else goto({ kind: "harness", runner })
  }

  const chooseRunner = (runner: GuideOptimizeRunner) => {
    if (runner === GuideOptimizeRunner.CurrentTerminal && props.terminalBlockedReason !== undefined) {
      setError(props.terminalBlockedReason)
      return
    }
    if (runner !== GuideOptimizeRunner.CopilotSdk && trx === undefined) {
      setError("No Native harnesses are installed; run trx install.")
      return
    }
    // Harness runs compose their skills through `trx run --skill`; only the SDK needs a local copy.
    if (runner !== GuideOptimizeRunner.CopilotSdk) {
      setSkillDirectory(undefined)
      goto({ kind: "harness", runner })
      return
    }
    const abort = new AbortController()
    controller.current = abort
    goto({ kind: "preparing", runner })
    void (props.ensureSkills ?? ensureOptimizeSkills)(props.runner, [...selected], abort.signal).then(
      (directory) => {
        setSkillDirectory(directory)
        afterSkills(runner, directory)
      },
      (cause: unknown) => {
        goto({ kind: "runner" })
        setError(cause instanceof Error ? cause.message : String(cause))
      },
    )
  }

  const chooseHarness = (runner: GuideOptimizeRunner, harness: GuideOptimizeHarness) => {
    if (runner === GuideOptimizeRunner.NewHerdrWorktree) {
      goto({ kind: "branch", harness, branch: suggestWorktreeBranch("repository", harnessProfile(trx!, harness)), checking: false })
    } else if (runner === GuideOptimizeRunner.CurrentTerminal || runner === GuideOptimizeRunner.NewHerdrTab) {
      props.onLaunch({ runner, ...harnessLaunch(harness) })
    }
  }

  const confirmBranch = (current: Extract<Stage, { kind: "branch" }>) => {
    setStage({ ...current, checking: true })
    void inspectGitWorktreeIntent(props.runner, { cwd: props.cwd, branch: current.branch.trim() }).then(
      (inspection) => {
        if (inspection.kind === "ready") {
          props.onLaunch({
            runner: GuideOptimizeRunner.NewHerdrWorktree, ...harnessLaunch(current.harness),
            primaryCheckoutPath: inspection.primaryCheckoutPath, branch: inspection.branch, baseRef: inspection.baseRef,
          })
        } else {
          setStage({ ...current, checking: false })
          setError(inspection.kind === "invalid-branch" ? "Enter a valid branch name." : "That branch or worktree path is already in use.")
        }
      },
      (cause: unknown) => {
        setStage({ ...current, checking: false })
        setError(cause instanceof Error ? cause.message : String(cause))
      },
    )
  }

  useInput((input, key) => {
    const abort = () => controller.current?.abort()
    switch (stage.kind) {
      case "sdk":
        handleOptimizeSdkInput(stage, input, key, abort, props.onBack)
        break
      case "preparing":
        if (key.escape) abort()
        break
      case "branch":
        handleOptimizeBranchInput(stage, input, key, setStage, () => goto({ kind: "runner" }), confirmBranch)
        break
      default:
        handleOptimizeChoiceInput({
          stage, index, runners, selected, setIndex, setSelected, setError, goto, back: props.onBack, chooseRunner, chooseHarness,
        }, input, key)
    }
  })

  return (
    <Box flexDirection="column" paddingX={1} height={Math.max(3, props.rows - 1)} overflowY="hidden">
      <Text bold color="cyan">Optimize · {props.cwd}</Text>
      <Text dimColor>Runs skills on the whole repository, not on a change set.</Text>
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        <OptimizeStageContent stage={stage} index={index} selected={selected} runners={runners}
          model={props.model} rows={props.rows} columns={props.columns} />
      </Box>
      {error === undefined ? null : <Text color="yellow">{error}</Text>}
      <Text dimColor>{optimizeFooter(stage)}</Text>
    </Box>
  )
}
