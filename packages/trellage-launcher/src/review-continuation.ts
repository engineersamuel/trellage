import { randomUUID } from "node:crypto"
import path from "node:path"
import {
  buildHerdrGuideLaunch, createHerdrWorktreeAndHandoff, createNodeCommandRunner,
  handoffToNewHerdrTab, inspectGitWorktreeIntent,
  runInteractiveCommand, type CommandRunner, type CommandSpec, type HerdrContext, type NativeSelectedProfile,
} from "./guide-launch.ts"
import type { CombinedGuideCatalog } from "./guide-catalog.ts"
import type { ReviewContinuation } from "./review-ui.tsx"

const continuationProfile = "hve"

export const reviewContinuationProfile = (catalog: CombinedGuideCatalog): NativeSelectedProfile => {
  const entry = catalog.native.find((candidate) => candidate.launcher === "copilot" && candidate.name === continuationProfile)
  if (!entry) throw new Error("Copilot hve is unavailable in the Guide catalog.")
  return {
    surface: "native", launcher: entry.launcher, commandPath: entry.commandPath,
    profile: entry.name, headlessPrompt: entry.headless.prompt,
  }
}

export const reviewContinuationProfileFromPath = (commandPath: string | undefined): NativeSelectedProfile => {
  if (!commandPath || !path.isAbsolute(commandPath)) {
    throw new Error("Review Copilot launcher is missing. Open Review through trx guide --review.")
  }
  return { surface: "native", launcher: "copilot", commandPath, profile: continuationProfile, headlessPrompt: false }
}

export const reviewContinuationPrompt = (result: ReviewContinuation): string => [
  result.destination === "new-herdr-tab"
    ? "Implement verified fixes from the TRX Guide review in this worktree. Do not start another review, commit, or publish changes."
    : "Plan fixes for the TRX Guide review. Do not edit files, implement changes, or start another review. Stop for my approval after the plan.",
  `Review report: ${result.outcome.markdownPath}`,
  `Structured report: ${result.outcome.jsonPath}`,
  `Reviewed base: ${result.snapshot.baseSha}; HEAD: ${result.snapshot.headSha}.`,
  `Review status: ${result.outcome.complete ? "complete" : "incomplete"}. Read both reports and verify findings against the current code.`,
  result.destination === "new-herdr-tab"
    ? "Check the current HEAD and changed-file scope against the reports before editing. If either differs, stop before editing and report that the review is stale. Skip any finding you cannot verify in the current code."
    : "Compare the current working-tree changes to the reviewed snapshot, not just HEAD. If the frozen patch is unavailable or differs, mark snapshot equivalence unverified.",
  result.destination === "new-herdr-tab"
    ? "Triage each retained finding against the code. Implement only verified fixes, run relevant checks, and report rejected suggestions and unresolved disagreements. Do not treat partial coverage as an all-clear."
    : "Triage each retained finding, preserve rejected suggestions and unresolved disagreements, then give a prioritized fix plan with affected files and checks. Do not treat partial coverage as an all-clear.",
].join("\n")

const currentTerminalReviewCommand = (profile: NativeSelectedProfile, prompt: string, cwd: string): CommandSpec => {
  const routerArgs = ["run", "copilot", profile.profile, "--", "--plan", "-i", prompt]
  const sourceWorktree = process.env.TRELLAGE_TRX_NATIVE_SOURCE === "1" &&
    !!process.env.MISE_PROJECT_ROOT &&
    path.resolve(process.env.MISE_PROJECT_ROOT) === path.resolve(cwd)
  return sourceWorktree
    ? { executable: "mise", args: ["run", "trx", "--", ...routerArgs] }
    : { executable: "trx", args: routerArgs }
}

export const executeReviewContinuation = async (
  result: ReviewContinuation,
  profile: NativeSelectedProfile,
  cwd: string,
  context: HerdrContext | null,
  services: {
    readonly runner: CommandRunner
    readonly runInteractive: (command: CommandSpec, options: {
      readonly cwd: string; readonly env: NodeJS.ProcessEnv
    }) => Promise<void>
  } = { runner: createNodeCommandRunner(), runInteractive: runInteractiveCommand },
): Promise<void> => {
  const prompt = reviewContinuationPrompt(result)
  const launch = buildHerdrGuideLaunch(profile, prompt)
  if (profile.launcher !== "copilot" || launch.promptDelivery !== "command" ||
    launch.command.args.length !== 5 || launch.command.args[0] !== "run" || launch.command.args[1] !== "copilot" || launch.command.args[2] !== profile.profile ||
    launch.command.args[3] !== "-i" || launch.command.args[4] !== prompt) {
    throw new Error("Copilot review continuation needs the selected profile and an argv prompt.")
  }
  const command: CommandSpec = {
    executable: launch.command.executable,
    args: ["run", "copilot", profile.profile, "--plan", ...(result.destination === "new-herdr-tab"
      ? ["--mode", "autopilot", "--allow-all", "--no-ask-user"] : []), "-i", prompt],
  }
  if (result.destination === "current-terminal") {
    await services.runInteractive(currentTerminalReviewCommand(profile, prompt, cwd),
      { cwd, env: { ...process.env, TRELLAGE_AUTOMATION: "1" } })
    return
  }
  if (!context) throw new Error("Herdr is unavailable. Continue in the current terminal instead.")
  const options = {
    command, prompt, promptDelivery: launch.promptDelivery,
    promptTimeoutMs: 60_000, timeoutMs: 60_000,
  } as const
  if (result.destination === "new-herdr-tab") {
    await handoffToNewHerdrTab(services.runner, { ...options, workspaceId: context.workspaceId, cwd })
    return
  }
  if (result.snapshot.workingTreeFiles.length > 0) {
    throw new Error("New worktrees cannot carry uncommitted review changes. Use the current terminal or a new tab.")
  }
  const branch = `worktree/review-${result.snapshot.headSha.slice(0, 8)}-${randomUUID().slice(0, 8)}`
  const inspected = await inspectGitWorktreeIntent(services.runner, { cwd, branch })
  if (inspected.kind !== "ready" || inspected.dirty || inspected.currentHeadSha !== result.snapshot.headSha) {
    throw new Error("Reviewed HEAD or worktree changed. New worktree continuation was not started.")
  }
  await createHerdrWorktreeAndHandoff(services.runner, {
    ...options, primaryCheckoutPath: inspected.primaryCheckoutPath,
    branch, baseRef: result.snapshot.headSha,
  })
}
