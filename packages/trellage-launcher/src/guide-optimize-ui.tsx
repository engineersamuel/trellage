import React, { useEffect, useRef, useState } from "react"
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
  | { readonly kind: "sdk"; readonly status: "running" | "done" | "failed"; readonly log: ReadonlyArray<string> }

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
    goto({ kind: "sdk", status: "running", log: ["Starting Copilot SDK."] })
    const append = (line: string) =>
      setStage((current) => (current.kind === "sdk" ? { ...current, log: [...current.log, line].slice(-200) } : current))
    void (props.runSdk ?? runGuideOptimizeSdk)({
      cwd: props.cwd, prompt: text, skillDirectory: directory, model: props.model, signal: abort.signal, onActivity: append,
    }).then(
      () => setStage((current) => (current.kind === "sdk" ? { ...current, status: "done" } : current)),
      (cause: unknown) => {
        append(cause instanceof Error ? cause.message : String(cause))
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
    if (stage.kind === "sdk") {
      if (stage.status === "running" && (key.escape || (key.ctrl && input === "c"))) controller.current?.abort()
      else if (stage.status !== "running" && (key.escape || key.return || input === "q")) props.onBack()
      return
    }
    if (stage.kind === "preparing") {
      if (key.escape) controller.current?.abort()
      return
    }
    if (stage.kind === "branch") {
      if (stage.checking) return
      if (key.escape) goto({ kind: "runner" })
      else if (key.return) confirmBranch(stage)
      else if (key.backspace || key.delete) setStage({ ...stage, branch: stage.branch.slice(0, -1) })
      else if (printable(input, key)) setStage({ ...stage, branch: stage.branch + input })
      return
    }
    if (key.escape || input === "b") {
      if (stage.kind === "skills") props.onBack()
      else goto(stage.kind === "runner" ? { kind: "skills" } : { kind: "runner" })
      return
    }
    if (input === "q") {
      props.onBack()
      return
    }
    const length = stage.kind === "skills" ? guideOptimizeSkills.length : stage.kind === "runner" ? runners.length : guideOptimizeHarnesses.length
    const delta = movement(input, key)
    if (delta !== undefined) {
      setIndex((current) => cycle(current, delta, length))
      return
    }
    if (stage.kind === "skills") {
      const skill = guideOptimizeSkills[index]
      if (input === " " && skill !== undefined) {
        const next = new Set(selected)
        if (!next.delete(skill.id)) next.add(skill.id)
        setSelected(next)
        setError(undefined)
      } else if (key.return) {
        if (selected.size === 0) setError("Press Space to select one or more skills.")
        else goto({ kind: "runner" })
      }
    } else if (key.return && stage.kind === "runner") {
      const runner = runners[index]
      if (runner !== undefined) chooseRunner(runner)
    } else if (key.return && stage.kind === "harness") {
      const harness = guideOptimizeHarnesses[index]
      if (harness !== undefined && !harness.composable)
        setError(`${harness.label} uses preset profiles and cannot load individual skills yet.`)
      else if (harness !== undefined) chooseHarness(stage.runner, harness.id)
    }
  })

  const footer =
    stage.kind === "skills" ? "↑/↓ or j/k move · Space select · ↵ continue · Esc back · q close"
      : stage.kind === "preparing" ? "Esc cancel"
      : stage.kind === "branch" ? (stage.checking ? "Checking the branch…" : "Type a branch name · ↵ create worktree · Esc back")
        : stage.kind === "sdk" ? (stage.status === "running" ? "Esc stop the agent" : "↵ or Esc return to Guide")
          : "↑/↓ or j/k move · ↵ choose · b back · q close"

  return (
    <Box flexDirection="column" paddingX={1} height={Math.max(3, props.rows - 1)} overflowY="hidden">
      <Text bold color="cyan">Optimize · {props.cwd}</Text>
      <Text dimColor>Runs skills on the whole repository, not on a change set.</Text>
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {stage.kind === "skills" && guideOptimizeSkills.map((skill, itemIndex) => (
          <Choice key={skill.id} active={itemIndex === index}>
            [{selected.has(skill.id) ? "x" : " "}] {skill.title}
            <Text dimColor> · {skill.description}</Text>
          </Choice>
        ))}
        {stage.kind === "runner" && runners.map((runner, itemIndex) => (
          <Choice key={runner} active={itemIndex === index}>{guideOptimizeRunnerLabels[runner]}</Choice>
        ))}
        {stage.kind === "harness" && (
          <>
            <Text>Harness for {guideOptimizeRunnerLabels[stage.runner]}. Guide loads only the selected skills; the harness keeps its own permission settings.</Text>
            {guideOptimizeHarnesses.map((harness, itemIndex) => (
              <Choice key={harness.id} active={itemIndex === index}>
                {harness.label}{harness.composable ? "" : <Text dimColor> · preset profiles only</Text>}
              </Choice>
            ))}
          </>
        )}
        {stage.kind === "preparing" && <Text>Preparing managed skills…</Text>}
        {stage.kind === "branch" && <Text>Branch: {stage.branch}<Text inverse> </Text></Text>}
        {stage.kind === "sdk" && (
          <>
            <Text>
              Copilot SDK · {props.model.model} / {props.model.effort} · {stage.status === "running" ? "running" : stage.status === "done" ? "finished" : "failed"}
            </Text>
            {stage.log.slice(-Math.max(1, props.rows - 8)).map((line, lineIndex) => (
              <Text key={lineIndex} wrap="truncate-end">{line}</Text>
            ))}
          </>
        )}
      </Box>
      {error === undefined ? null : <Text color="yellow">{error}</Text>}
      <Text dimColor>{footer}</Text>
    </Box>
  )
}
