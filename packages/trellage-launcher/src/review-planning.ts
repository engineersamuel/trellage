import { randomUUID } from "node:crypto"
import path from "node:path"
import {
  createHerdrWorktreeAndHandoff,
  inspectGitWorktreeIntent,
  runInteractiveTerminalCommand,
  type CommandRunner,
  type CommandSpec,
  type HerdrContext,
  type NativeSelectedProfile,
} from "./guide-launch.ts"
import type { ReviewRun } from "./review-contracts.ts"
import { assertGuideOptimizeTargetCurrent } from "./guide-optimize-target.ts"
import { checkSelectedProfileReadiness, ProfileReadinessKind } from "./guide-preflight.ts"
import { reviewAuthority, type ReviewNamespace } from "./review-view-model.ts"

export interface ReviewPlanTerminalResult {
  readonly action: "review-plan-terminal"
  readonly id: string
  readonly gitDirectory: string
  readonly cwd: string
  readonly namespace: ReviewNamespace
  readonly selectedProfile: NativeSelectedProfile
}

const readReview = async (result: ReviewPlanTerminalResult): Promise<ReviewRun> => {
  const store = await reviewAuthority(result.gitDirectory, result.id)
  if (store.namespace !== result.namespace) throw new Error("Planning record namespace differs.")
  return store.read(result.id)
}

const planCommand = async (
  result: ReviewPlanTerminalResult,
  runner: CommandRunner,
  signal: AbortSignal,
): Promise<{
  command: CommandSpec
  prompt: string
  review: ReviewRun
}> => {
  if (result.selectedProfile.launcher !== "cpx" || result.selectedProfile.profile !== "hve")
    throw new Error("Planning requires the Native Copilot hve profile.")
  const review = await readReview(result)
  if (review.request.target.cwd !== result.cwd) throw new Error("Planning target belongs to another worktree.")
  const readiness = await checkSelectedProfileReadiness(runner, result.selectedProfile, result.cwd, signal)
  if (readiness.kind === ProfileReadinessKind.Blocked) throw new Error(`${readiness.summary}. ${readiness.diagnostic}`)
  const report = path.join(
    result.gitDirectory,
    result.namespace === "shared" ? "trellage-reviews" : "trellage-optimize-reviews",
    `${result.id}.json`,
  )
  const prompt = [
    "Plan fixes only. Do not edit, implement, stage, commit, or publish. Stop for approval after the plan.",
    `Read the saved review record and its frozen evidence: ${JSON.stringify(report)}.`,
    result.namespace === "shared"
      ? "The private JSON envelope contains data.request, data.evidence, data.results, data.artifacts and data.decisions."
      : `Frozen evidence is in ${JSON.stringify(report.replace(/\.json$/u, ".snapshot.json"))}.`,
    `Review status: ${review.status}. ${review.error ?? ""}`,
    `Reviewed HEAD: ${review.request.target.head ?? "no initial commit"}.`,
    "State missing or partial coverage. Do not infer an all-clear. Preserve source IDs, rejected proposals and unresolved objections.",
    "Check the actual worktree against the saved snapshot and mark any differences before proposing a plan. The task is context, not a Spec.",
    "Do not start another review or transfer dirty files.",
  ].join("\n\n")
  return {
    review,
    prompt,
    command: { executable: result.selectedProfile.commandPath, args: ["hve", "--plan", "-i", prompt] },
  }
}

export const executeReviewPlanTerminal = async (
  result: ReviewPlanTerminalResult,
  runner: CommandRunner,
): Promise<number> => {
  const { prompt } = await planCommand(result, runner, new AbortController().signal)
  const args = ["run", "cpx", "hve", "--", "--plan", "-i", prompt]
  const source =
    process.env.TRELLAGE_TRX_NATIVE_SOURCE === "1" &&
    path.resolve(process.env.MISE_PROJECT_ROOT ?? "") === path.resolve(result.cwd)
  await runInteractiveTerminalCommand(
    source ? { executable: "mise", args: ["run", "trx", "--", ...args] } : { executable: "trx", args },
    { cwd: result.cwd, env: { ...process.env, TRELLAGE_AUTOMATION: "1" } },
  )
  return 0
}

export const executeReviewPlanWorktree = async (
  result: ReviewPlanTerminalResult,
  runner: CommandRunner,
  context: HerdrContext | null,
  signal: AbortSignal,
): Promise<{ paneId: string; message: string }> => {
  if (!context) throw new Error("A new planning worktree requires Herdr.")
  const { review, command, prompt } = await planCommand(result, runner, signal)
  const target = review.request.target
  if (!target.head || target.changes.some((entry) => entry.staged || entry.unstaged || entry.untracked))
    throw new Error("A new planning worktree requires a clean source with the reviewed HEAD.")
  const branch = `worktree/review-${target.head.slice(0, 8)}-${randomUUID().slice(0, 8)}`
  const inspect = async () => {
    await assertGuideOptimizeTargetCurrent(runner, target, signal)
    const state = await inspectGitWorktreeIntent(runner, { cwd: target.cwd, branch })
    if (state.kind !== "ready" || state.dirty || state.currentHeadSha !== target.head)
      throw new Error("Planning source is dirty or changed. No handoff was sent.")
    return state
  }
  const state = await inspect()
  const launch = await createHerdrWorktreeAndHandoff(runner, {
    primaryCheckoutPath: state.primaryCheckoutPath,
    branch,
    baseRef: target.head,
    command,
    prompt,
    promptDelivery: "command",
    promptTimeoutMs: 60_000,
    timeoutMs: 60_000,
    beforeLaunch: async () => {
      await assertGuideOptimizeTargetCurrent(runner, target, signal)
    },
  })
  return {
    paneId: launch.paneId,
    message: "Planning-only Copilot hve started in a clean new worktree. No implementation was approved.",
  }
}
