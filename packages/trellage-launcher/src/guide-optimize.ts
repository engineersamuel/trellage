import { adapters } from "@trellage/runtime/native-run"
import {
  approveAll,
  CopilotClient,
  RuntimeConnection,
  type CopilotClientOptions,
  type SessionConfig,
} from "@github/copilot-sdk"
import { findExecutableOnPath, runCleanupStep } from "./copilot-guide-provider.ts"
import type { GuideModelConfig } from "./guide-model-routing.ts"

/** One Optimize skill: a standing instruction an agent applies to the whole repository. */
export interface GuideOptimizeSkill {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly prompt: string
  /** Skills loaded into a harness run, as `owner/repo:name` for `trx run --skill`. */
  readonly harnessSkills?: ReadonlyArray<string>
}

export const guideOptimizeSkills: ReadonlyArray<GuideOptimizeSkill> = [
  {
    id: "first-principles",
    title: "First principles",
    description: "Challenge assumptions. Prefer deletion, then simplification. Leave good code alone.",
    prompt:
      "Review the implementation from first principles. Challenge weak assumptions and unnecessary complexity. Find only high-impact opportunities to delete or simplify. Prefer deleting over simplifying, simplifying over optimizing, and optimizing over automating. It is valid to recommend no change.",
  },
  {
    id: "behavior-preservation",
    title: "Behavior preservation",
    description: "Protect requirements, edge cases, and existing behavior.",
    prompt:
      "Check the implementation against the repository contracts and relevant tests. Find concrete behavioral risks and simpler alternatives that preserve requirements. Do not manufacture objections. A necessary safeguard is not needless complexity.",
  },
  {
    id: "improve-codebase-architecture",
    title: "Improve codebase architecture",
    description: "Matt Pocock's skill: deepen modules, improve locality, and remove shallow layers.",
    harnessSkills: ["mattpocock/skills:improve-codebase-architecture", "mattpocock/skills:codebase-design"],
    prompt:
      "Use the improve-codebase-architecture and codebase-design skills (invoke them; they are loaded). Deepen shallow modules, improve locality, and remove layers that only pass calls through. Read GLOSSARY.md and relevant ADRs if present. State ADR conflicts instead of overriding them.",
  },
  {
    id: "ui-css",
    title: "UI and CSS",
    description: "Modern CSS from good-css.com: intrinsic layout, focus, motion, and color.",
    prompt: [
      "Review the repository's stylesheets and UI markup (CSS, HTML, JSX, TSX). If there are none, report that and stop.",
      "Read https://good-css.com and its linked entries when network access is available. Apply its rules, including:",
      "- Set min-width: 0 where flex or grid children overflow.",
      "- Prefer intrinsic layout (clamp(), auto-fit grids, container queries) over breakpoint ladders.",
      "- Use logical properties (inline, block) instead of left, right, top, and bottom.",
      "- Use :focus-visible and never remove outlines without a replacement.",
      "- Guard motion with @media (prefers-reduced-motion: no-preference).",
      "- Use :user-invalid for form feedback, :has() for parent state, and @starting-style for entry transitions.",
      "- Use OKLCH colors and color-mix() for consistent palettes; text-wrap: pretty or balance for text.",
      "Rank the improvements by user impact. Prefer CSS over JavaScript when both work.",
    ].join("\n"),
  },
]

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
  on(handler: (event: { readonly type: string; readonly data: unknown }) => void): () => void
  sendAndWait(options: { readonly prompt: string }, timeoutMs: number): Promise<unknown>
  abort(): Promise<void>
  disconnect(): Promise<void>
}

export interface GuideOptimizeSdkClient {
  start(): Promise<void>
  createSession(config: SessionConfig): Promise<GuideOptimizeSdkSession>
  stop(): Promise<ReadonlyArray<Error>>
}

export interface GuideOptimizeSdkOptions {
  readonly cwd: string
  readonly prompt: string
  readonly skillDirectory?: string | undefined
  readonly model: GuideModelConfig
  readonly signal: AbortSignal
  readonly onActivity: (text: string) => void
  readonly clientFactory?: (options: CopilotClientOptions) => GuideOptimizeSdkClient
  readonly timeoutMs?: number
}

const activityText = (event: { readonly type: string; readonly data: unknown }): string | undefined => {
  const data = event.data as Record<string, unknown> | null
  if (event.type === "tool.execution_start" && typeof data?.toolName === "string") return `Tool: ${data.toolName}`
  if (event.type === "assistant.message" && typeof data?.content === "string" && data.content.trim() !== "")
    return data.content.trim()
  if (event.type === "session.error" && typeof data?.message === "string") return `Error: ${data.message}`
  return undefined
}

/**
 * Runs the prompt as a full Copilot agent in the repository. Every tool and
 * permission request is approved: the user chose this runner for that reason.
 */
export const runGuideOptimizeSdk = async (options: GuideOptimizeSdkOptions): Promise<void> => {
  const copilotCliPath = findExecutableOnPath("copilot")
  const client = (options.clientFactory ?? ((config) => new CopilotClient(config)))({
    mode: "copilot-cli",
    ...(copilotCliPath === undefined ? {} : { connection: RuntimeConnection.forStdio({ path: copilotCliPath }) }),
    workingDirectory: options.cwd,
    logLevel: "none",
  })
  let session: GuideOptimizeSdkSession | undefined
  const abort = () => void session?.abort()
  options.signal.addEventListener("abort", abort, { once: true })
  try {
    await client.start()
    options.signal.throwIfAborted()
    session = await client.createSession({
      clientName: "trellage-trx-optimize",
      model: options.model.model,
      reasoningEffort: options.model.effort,
      workingDirectory: options.cwd,
      streaming: false,
      ...(options.skillDirectory === undefined ? {} : { skillDirectories: [options.skillDirectory] }),
      onPermissionRequest: approveAll,
    })
    session.on((event) => {
      const text = activityText(event)
      if (text !== undefined) options.onActivity(text)
    })
    options.signal.throwIfAborted()
    await session.sendAndWait({ prompt: options.prompt }, options.timeoutMs ?? 3_600_000)
  } finally {
    options.signal.removeEventListener("abort", abort)
    const errors: unknown[] = []
    if (session !== undefined) await runCleanupStep(errors, () => session!.disconnect())
    await runCleanupStep(errors, () => client.stop())
    if (errors.length > 0 && !options.signal.aborted) throw new AggregateError(errors, "Copilot SDK cleanup failed.")
  }
}
