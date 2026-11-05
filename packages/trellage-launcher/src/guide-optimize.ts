import { resolveGuideTaskModel, type GuideModelSelector } from "./guide-model-selector.ts"
import { adapters } from "@trellage/runtime/native-run"
import {
  approveAll,
  RuntimeConnection,
  type CopilotClientOptions,
  type SessionConfig,
  type SessionEvent,
} from "@github/copilot-sdk"
import { findExecutableOnPath, runCleanupStep } from "./copilot-guide-provider.ts"
import { automaticGuideModel, type GuideModelConfig } from "./guide-model-routing.ts"
import { createLiveCopilotClient } from "./provider-clients.ts"

export { guideOptimizeSkills, type GuideOptimizeSkill } from "./guide-optimize-catalog.ts"
import { guideOptimizeSkills, type GuideOptimizeSkill } from "./guide-optimize-catalog.ts"

/** Where the selected skills run. */
export enum GuideOptimizeRunner {
  CopilotSdk = "copilot-sdk",
  CurrentTerminal = "current-terminal",
  NewHerdrTab = "new-herdr-tab",
  NewHerdrWorktree = "new-herdr-worktree",
}

export const guideOptimizeRunnerLabels: Readonly<Record<GuideOptimizeRunner, string>> = {
  [GuideOptimizeRunner.CopilotSdk]: "Copilot SDK in this terminal (all tools allowed)",
  [GuideOptimizeRunner.CurrentTerminal]: "Agent harness in this terminal",
  [GuideOptimizeRunner.NewHerdrTab]: "Agent harness in a new Herdr tab",
  [GuideOptimizeRunner.NewHerdrWorktree]: "Agent harness in a new Herdr worktree",
}

export const guideOptimizeRunners = (herdr: boolean): ReadonlyArray<GuideOptimizeRunner> =>
  herdr
    ? [
        GuideOptimizeRunner.CopilotSdk,
        GuideOptimizeRunner.CurrentTerminal,
        GuideOptimizeRunner.NewHerdrTab,
        GuideOptimizeRunner.NewHerdrWorktree,
      ]
    : [GuideOptimizeRunner.CopilotSdk, GuideOptimizeRunner.CurrentTerminal]

/** Every `trx run` harness, in its picker order; each accepts `--skill`. */
export const guideOptimizeHarnesses: ReadonlyArray<{ readonly id: string; readonly label: string; readonly composable: boolean }> =
  Object.entries(adapters).map(([id, adapter]) => ({ id, label: adapter.label, composable: true }))
export type GuideOptimizeHarness = string

/**
 * The `trx run` command for a harness with exactly the selected skills. It skips
 * always-on profiles and keeps the harness's own permission settings.
 */
export const buildGuideOptimizeHarnessCommand = (
  trx: string,
  harness: GuideOptimizeHarness,
  skills: ReadonlyArray<GuideOptimizeSkill>,
  prompt: string,
): { readonly executable: string; readonly args: ReadonlyArray<string> } => ({
  executable: trx,
  args: [
    "run", harness, "--no-always", ...(harness === "copilot" ? ["--model", "auto"] : []),
    ...[...new Set(skills.flatMap((skill) => skill.harnessSkills ?? []))].flatMap((ref) => ["--skill", ref]),
    "--", ...(harness === "copilot" ? ["-i", prompt] : [prompt]),
  ],
})

export const selectGuideOptimizeSkills = (ids: ReadonlyArray<string>): ReadonlyArray<GuideOptimizeSkill> => {
  const selected = guideOptimizeSkills.filter((skill) => ids.includes(skill.id))
  if (selected.length === 0 || selected.length !== new Set(ids).size) throw new Error("Select one or more Optimize skills.")
  return selected
}

/** The agent prompt. It targets the repository as it is now, not a change set. */
export const buildGuideOptimizePrompt = (skills: ReadonlyArray<GuideOptimizeSkill>, skillDirectory?: string): string =>
  [
    "Optimize this repository as it is now. Do not limit the work to uncommitted or committed changes.",
    ...(skillDirectory === undefined ? [] : [`Managed skills are in ${JSON.stringify(skillDirectory)}. Read each <name>/SKILL.md named below before you start.`]),
    "Read repository instructions (AGENTS.md, CLAUDE.md, CONTRIBUTING.md) and follow them.",
    "Apply each section below. Make the highest-impact improvements, keep behavior unchanged, and run the relevant checks after each change.",
    "Do not stage, commit, or push. End with a short summary of what changed and what you left alone and why.",
    ...skills.map((skill) => `## ${skill.title}\n${skill.prompt}`),
  ].join("\n\n")

export interface GuideOptimizeSdkSession {
  on(handler: (event: SessionEvent) => void): () => void
  sendAndWait(options: { readonly prompt: string }, timeoutMs: number): Promise<unknown>
  abort(): Promise<void>
  disconnect(): Promise<void>
}

export interface GuideOptimizeSdkClient {
  start(): Promise<void>
  createSession(config: SessionConfig): Promise<GuideOptimizeSdkSession>
  stop(): Promise<ReadonlyArray<Error>>
}

export type GuideOptimizeActivity =
  | { readonly kind: "assistant"; readonly id: string; readonly text: string; readonly append?: boolean }
  | { readonly kind: "tool"; readonly id: string; readonly text: string; readonly output: string; readonly status: "running" | "done" | "failed" }
  | { readonly kind: "status" | "error"; readonly id: string; readonly text: string }

export interface GuideOptimizeSdkOptions {
  readonly selectModel?: GuideModelSelector
  readonly cwd: string
  readonly prompt: string
  readonly skillDirectory?: string | undefined
  readonly model: GuideModelConfig
  readonly signal: AbortSignal
  readonly onActivity: (activity: GuideOptimizeActivity) => void
  readonly clientFactory?: (options: CopilotClientOptions) => GuideOptimizeSdkClient
  readonly timeoutMs?: number
}

const boundedOutput = (text: string): string =>
  text.length > 16_000 ? `[Earlier output omitted]\n${text.slice(-16_000)}` : text

type OptimizeToolActivity = Extract<GuideOptimizeActivity, { kind: "tool" }>

const completeToolActivity = (
  previous: OptimizeToolActivity,
  data: Extract<SessionEvent, { type: "tool.execution_complete" }>["data"],
): OptimizeToolActivity => ({
  ...previous,
  status: data.success ? "done" : "failed",
  output: boundedOutput([
    data.result?.detailedContent || data.result?.content || previous.output,
    data.error?.message,
  ].filter(Boolean).join("\n")),
})

const observeOptimizeTool = (event: SessionEvent, tools: Map<string, OptimizeToolActivity>): OptimizeToolActivity | undefined => {
  if (event.type === "tool.execution_start") {
    const { toolCallId, toolName, arguments: args } = event.data
    const argumentsText = args === undefined ? "" : `\n${JSON.stringify(args, null, 2)}`
    const activity: OptimizeToolActivity = {
      kind: "tool", id: toolCallId, text: `${toolName}${argumentsText}`, output: "", status: "running",
    }
    tools.set(toolCallId, activity)
    return activity
  }
  if (event.type !== "tool.execution_partial_result" && event.type !== "tool.execution_progress" && event.type !== "tool.execution_complete")
    return undefined
  const id = event.data.toolCallId
  const previous = tools.get(id) ?? { kind: "tool", id, text: "Tool", output: "", status: "running" }
  if (event.type === "tool.execution_complete") {
    tools.delete(id)
    return completeToolActivity(previous, event.data)
  }
  const output = event.type === "tool.execution_partial_result" ? event.data.partialOutput : `\n${event.data.progressMessage}\n`
  const activity = { ...previous, output: boundedOutput(previous.output + output) }
  tools.set(id, activity)
  return activity
}

export const updateGuideOptimizeLog = (
  log: ReadonlyArray<GuideOptimizeActivity>,
  activity: GuideOptimizeActivity,
): ReadonlyArray<GuideOptimizeActivity> => {
  const index = log.findIndex((entry) => entry.id === activity.id)
  const previous = log[index]
  const next = activity.kind === "assistant" && activity.append && previous?.kind === "assistant"
    ? { ...activity, text: previous.text + activity.text }
    : activity
  return index < 0 ? [...log, next].slice(-200) : log.map((entry, i) => i === index ? next : entry)
}

/**
 * Runs the prompt as a full Copilot agent in the repository. Every tool and
 * permission request is approved: the user chose this runner for that reason.
 */
export const runGuideOptimizeSdk = async (options: GuideOptimizeSdkOptions): Promise<void> => {
  const model = await resolveGuideTaskModel(options.model, options, options.selectModel)
  if (options.model.model === automaticGuideModel)
    options.onActivity({ kind: "status", id: "model", text: `${model.model} (${model.effort})` })
  const copilotCliPath = findExecutableOnPath("copilot")
  const client = (options.clientFactory ?? createLiveCopilotClient)({
    mode: "copilot-cli",
    ...(copilotCliPath === undefined ? {} : { connection: RuntimeConnection.forStdio({ path: copilotCliPath }) }),
    workingDirectory: options.cwd,
    logLevel: "none",
  })
  let session: GuideOptimizeSdkSession | undefined
  const tools = new Map<string, OptimizeToolActivity>()
  const abort = () => void session?.abort()
  options.signal.addEventListener("abort", abort, { once: true })
  try {
    await client.start()
    options.signal.throwIfAborted()
    session = await client.createSession({
      clientName: "trellage-trx-optimize",
      model: model.model,
      reasoningEffort: model.effort,
      workingDirectory: options.cwd,
      streaming: true,
      ...(options.skillDirectory === undefined ? {} : { skillDirectories: [options.skillDirectory] }),
      onPermissionRequest: approveAll,
    })
    session.on((event) => {
      switch (event.type) {
        case "assistant.message_delta":
          options.onActivity({ kind: "assistant", id: event.data.messageId, text: event.data.deltaContent, append: true })
          break
        case "assistant.message":
          if (event.data.content.trim()) options.onActivity({ kind: "assistant", id: event.data.messageId, text: event.data.content })
          break
        case "session.error":
          options.onActivity({ kind: "error", id: event.id, text: `Error: ${event.data.message}` })
          break
        default: {
          const activity = observeOptimizeTool(event, tools)
          if (activity !== undefined) options.onActivity(activity)
        }
      }
    })
    options.signal.throwIfAborted()
    await session.sendAndWait({ prompt: options.prompt }, options.timeoutMs ?? 3_600_000)
  } finally {
    options.signal.removeEventListener("abort", abort)
    const errors: unknown[] = []
    if (session !== undefined) await runCleanupStep(errors, () => session!.disconnect())
    await runCleanupStep(errors, () => client.stop())
    // Cleanup failures are reported deliberately, even after a session error.
    // oxlint-disable-next-line no-unsafe-finally
    if (errors.length > 0 && !options.signal.aborted) throw new AggregateError(errors, "Copilot SDK cleanup failed.")
  }
}
