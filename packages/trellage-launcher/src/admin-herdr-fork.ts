/**
 * Fork-to-Herdr-worktree remediation action for the Admin panel. Delegates
 * entirely to the existing availability probe, git-worktree inspection, and
 * worktree-create-and-handoff functions in `guide-launch.ts`
 * (`getHerdrContext`, `probeHerdrAvailability`, `inspectGitWorktreeIntent`,
 * `createHerdrWorktreeAndHandoff`, `defaultWorktreeBranch`) — no new git,
 * worktree-mutation, or shell-command logic is introduced here. Every Herdr
 * invocation stays an argument vector built entirely from typed/known
 * fields (profile ref/name, captured doctor output, an optional diagnosis
 * suggestion); untrusted captured output is only ever embedded as inert
 * prompt text, never interpolated into a shell command.
 */
import type { DoctorFailureDiagnosisResult } from "./admin-diagnosis-provider.js"
import {
  createHerdrWorktreeAndHandoff,
  defaultWorktreeBranch,
  getHerdrContext,
  inspectGitWorktreeIntent,
  probeHerdrAvailability,
  type CommandRunner,
  type CommandSpec,
  type GitWorktreeInspection,
  type HerdrEnvironment,
  type HerdrPromptDeliveryMode,
  type HerdrWorktreeLaunchResult,
} from "./guide-launch.js"

export interface HerdrForkRequest {
  readonly ref: string
  readonly name: string
  readonly capturedOutput: string
  readonly diagnosis?: DoctorFailureDiagnosisResult
}

export interface HerdrForkOptions {
  readonly cwd: string
  readonly command: CommandSpec
  readonly promptDelivery: HerdrPromptDeliveryMode
  readonly promptTimeoutMs?: number
  readonly timeoutMs?: number
}

export type HerdrForkOutcome =
  | { readonly kind: "unavailable" }
  | { readonly kind: "not-ready"; readonly inspection: Exclude<GitWorktreeInspection, { readonly kind: "ready" }> }
  | { readonly kind: "launched"; readonly result: HerdrWorktreeLaunchResult }
  | { readonly kind: "failed"; readonly error: unknown }

/**
 * Mirrors the established availability-gate pattern (`probeInteractiveHerdr`
 * in `cli.tsx`): only available when both a live Herdr context is present
 * in the environment and a live `herdr --help` probe succeeds. Never
 * throws — an unreachable/misconfigured Herdr install is reported as
 * `false`, not an error.
 */
export const isForkToHerdrAvailable = async (
  runner: CommandRunner,
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

const buildForkPrompt = (request: HerdrForkRequest): string => {
  const lines = [
    `Fix the failing Trellage doctor check for profile ${request.name} (${request.ref}).`,
    "",
    "<untrusted-data>",
    request.capturedOutput,
    "</untrusted-data>",
  ]
  if (request.diagnosis !== undefined) {
    lines.push(
      "",
      "A Copilot-suggested diagnosis is available (verify before applying):",
      `Summary: ${request.diagnosis.summary}`,
      `Suggested fix: ${request.diagnosis.suggestedFix}`,
      ...(request.diagnosis.rationale === undefined ? [] : [`Rationale: ${request.diagnosis.rationale}`]),
    )
  }
  return lines.join("\n")
}

/**
 * Explicit, confirmed-by-caller action: inspects the current git worktree
 * state (reusing `inspectGitWorktreeIntent` — no new git logic), and only
 * when it is `ready`, creates a new Herdr worktree and hands the
 * constructed prompt off to a fresh agent pane there. Callers must gate
 * this behind `isForkToHerdrAvailable` and an explicit user confirmation
 * before invoking it — this function itself performs the mutating action
 * unconditionally once called (subject to the git-readiness check).
 */
export const forkFailureToHerdrWorktree = async (
  runner: CommandRunner,
  request: HerdrForkRequest,
  options: HerdrForkOptions,
): Promise<HerdrForkOutcome> => {
  const branch = defaultWorktreeBranch(`fix ${request.name} doctor failure`)
  try {
    const inspection = await inspectGitWorktreeIntent(runner, { cwd: options.cwd, branch })
    if (inspection.kind !== "ready") return { kind: "not-ready", inspection }
    const result = await createHerdrWorktreeAndHandoff(runner, {
      primaryCheckoutPath: inspection.primaryCheckoutPath,
      branch,
      baseRef: inspection.baseRef,
      command: options.command,
      prompt: buildForkPrompt(request),
      promptDelivery: options.promptDelivery,
      promptTimeoutMs: options.promptTimeoutMs ?? 60_000,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })
    return { kind: "launched", result }
  } catch (error) {
    return { kind: "failed", error }
  }
}
