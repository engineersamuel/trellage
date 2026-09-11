import {
  CommandRunnerError,
  GuideLaunchError,
  buildGuideLaunchCommand,
  buildHerdrGuideLaunch,
  createHerdrWorktreeAndHandoff,
  handoffToCurrentHerdrWorkspace,
  handoffToNewHerdrTab,
  openHerdrWorktreeAndHandoff,
  runInteractiveCommand,
  sameGuideCommand,
  type CommandRunner,
  type CommandSpec,
  type HerdrPaneLaunchResult,
} from "./guide-launch.js"
import type { GuideUiResult } from "./guide-ui.js"
import { guideBatchExitCode, writeGuideBatchSummary } from "./guide-batch.js"
import { assertGuideGoalCandidate, type GuideGoalCandidateContext } from "./guide-goal-execution.js"
import { guideGoalInputInstructions } from "./guide-goal-transport.js"
import { checkSelectedProfileReadiness, ProfileReadinessKind } from "./guide-preflight.js"

const startupTimeoutMs = 60_000
const promptTimeoutMs = 60_000

export interface GuideInteractiveExecutionServices {
  readonly runner: CommandRunner
  readonly write: (text: string) => void
  readonly checkReadiness?: typeof checkSelectedProfileReadiness
  readonly runInteractive?: (
    command: CommandSpec,
    options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
  ) => Promise<void>
}

const writePrompt = (write: GuideInteractiveExecutionServices["write"], prompt: string, instruction: string): void => {
  write(`${instruction}\n\n${prompt}\n`)
}

const writeRecoveryPrompt = (services: GuideInteractiveExecutionServices, prompt: string): void =>
  writePrompt(services.write, prompt, "Automatic prompt delivery failed. Use this prompt manually:")

const writeIncompleteLaunchPrompt = (services: GuideInteractiveExecutionServices, prompt: string): void =>
  writePrompt(services.write, prompt, "Profile launch did not complete. Selected prompt:")

type LaunchResult = Exclude<GuideUiResult, { readonly action: "cancel" | "print" | "batch" }>
type HerdrResult = Exclude<LaunchResult, { readonly action: "current-terminal" }>

const validateGoalResult = (result: LaunchResult): void => {
  if (result.goalExecution === undefined) return
  const expected = result.action === "current-terminal"
    ? buildGuideLaunchCommand(result.profile, { mode: "argv", prompt: result.prompt }, result.goalExecution)
    : buildHerdrGuideLaunch(result.profile, result.prompt, result.goalExecution)
  const handlingMatches = "promptHandling" in expected
    ? result.action === "current-terminal" && expected.promptHandling === result.promptHandling
    : result.action !== "current-terminal" && expected.promptDelivery === result.promptDelivery
  if (!handlingMatches || !sameGuideCommand(expected.command, result.command)) {
    throw new GuideLaunchError({ kind: "blocked", message: "The selected goal command no longer matches its profile and delivery." })
  }
}

const checkGoalReadiness = async (
  result: LaunchResult,
  services: GuideInteractiveExecutionServices,
  cwd: string,
  paneId?: string,
): Promise<void> => {
  if (result.goalExecution === undefined) return
  const readiness = await (services.checkReadiness ?? checkSelectedProfileReadiness)(
    services.runner, result.profile, cwd, undefined, result.goalExecution,
  )
  if (readiness.kind === ProfileReadinessKind.Blocked) {
    throw new GuideLaunchError({
      kind: "blocked", message: `${readiness.summary}. ${readiness.diagnostic}`,
      cwd,
      ...(paneId === undefined ? {} : { paneId }),
    })
  }
}

const writeGoalInput = (
  services: GuideInteractiveExecutionServices,
  prompt: string,
  execution: GuideGoalCandidateContext,
  heading: string,
): void => services.write(`${heading}\n${guideGoalInputInstructions(execution, prompt)}\n`)

const unexpectedGuideResult = (result: never): never => {
  const action =
    typeof result === "object" && result !== null && "action" in result
      ? String((result as { readonly action: unknown }).action)
      : "missing"
  throw new Error(`interactive guide returned an unsupported action: ${action}`)
}

const launchHerdrResult = async (
  result: HerdrResult,
  services: GuideInteractiveExecutionServices,
): Promise<HerdrPaneLaunchResult & { readonly cwd: string; readonly workspaceId?: string }> => {
  const options = {
    command: result.command,
    prompt: result.prompt,
    promptDelivery: result.promptDelivery,
    timeoutMs: startupTimeoutMs,
    promptTimeoutMs,
    ...(result.goalExecution === undefined ? {} : {
      beforeLaunch: (cwd: string, paneId: string) => checkGoalReadiness(result, services, cwd, paneId),
    }),
  }
  switch (result.action) {
      case "current-herdr-workspace":
        return { ...(await handoffToCurrentHerdrWorkspace(services.runner, {
          ...options,
          callerPaneId: result.callerPaneId,
          cwd: result.cwd,
          direction: result.direction,
        })), cwd: result.cwd }
      case "new-herdr-tab":
        return { ...(await handoffToNewHerdrTab(services.runner, {
          ...options,
          workspaceId: result.workspaceId,
          cwd: result.cwd,
        })), cwd: result.cwd, workspaceId: result.workspaceId }
      case "herdr-worktree-create": {
        const launch = await createHerdrWorktreeAndHandoff(services.runner, {
          ...options,
          primaryCheckoutPath: result.primaryCheckoutPath,
          branch: result.branch,
          baseRef: result.baseRef,
        })
        return { ...launch, cwd: launch.checkoutPath }
      }
      case "herdr-worktree-open": {
        const launch = await openHerdrWorktreeAndHandoff(services.runner, {
          ...options,
          primaryCheckoutPath: result.primaryCheckoutPath,
          path: result.path,
        })
        return { ...launch, cwd: launch.checkoutPath }
      }
      default:
        return unexpectedGuideResult(result)
  }
}

const writeHerdrFailure = (
  result: HerdrResult,
  services: GuideInteractiveExecutionServices,
  error: unknown,
): void => {
  if (result.goalExecution !== undefined) {
    const pane = error instanceof GuideLaunchError && error.paneId !== undefined ? ` Pane: ${error.paneId}.` : ""
    const directory = error instanceof GuideLaunchError && error.cwd !== undefined ? ` Directory: ${error.cwd}.` : ""
    writeGoalInput(services, result.prompt, result.goalExecution, `Goal launch for ${result.profile.profile} did not complete.${pane}${directory} Resolve the error before native input.`)
  } else if (error instanceof GuideLaunchError && error.paneId !== undefined) {
    writeRecoveryPrompt(services, result.prompt)
  } else {
    writeIncompleteLaunchPrompt(services, result.prompt)
  }
}

const executeHerdrResult = async (
  result: HerdrResult,
  services: GuideInteractiveExecutionServices,
): Promise<number> => {
  validateGoalResult(result)
  try {
    const launch = await launchHerdrResult(result, services)
    if (launch.status !== "needs-input") return 0
    services.write(`Profile ${result.profile.profile}: needs-input in pane ${launch.paneId}; directory: ${launch.cwd}.\n`)
    if (launch.workspaceId !== undefined) services.write(`Workspace: ${launch.workspaceId}.\n`)
    if (result.goalExecution === undefined) writePrompt(services.write, result.prompt, "Use this prompt manually:")
    else writeGoalInput(services, result.prompt, result.goalExecution, "The goal has not been activated.")
    return 2
  } catch (error) {
    writeHerdrFailure(result, services, error)
    throw error
  }
}

const executeCurrentTerminalResult = async (
  result: Extract<GuideUiResult, { readonly action: "current-terminal" }>,
  services: GuideInteractiveExecutionServices,
): Promise<number> => {
  validateGoalResult(result)
  try {
    await checkGoalReadiness(result, services, result.cwd)
    if (result.promptHandling === "manual-paste") {
      if (result.goalExecution === undefined) writePrompt(services.write, result.prompt, "Paste this prompt after the profile starts:")
      else writeGoalInput(services, result.prompt, result.goalExecution, "Goal needs-input after the profile starts. Startup does not activate it.")
    }
    await (services.runInteractive ?? runInteractiveCommand)(result.command, {
      cwd: result.cwd,
      env: { ...process.env, TRELLAGE_AUTOMATION: "1" },
    })
    return 0
  } catch (error) {
    if (result.goalExecution !== undefined) {
      writeGoalInput(services, result.prompt, result.goalExecution, `Goal execution is not confirmed in ${result.cwd}. Resolve the error before native input.`)
    }
    if (error instanceof CommandRunnerError && error.kind === "exited") return error.exitCode ?? 130
    throw error
  }
}

export const executeGuideUiResult = async (
  result: GuideUiResult,
  services: GuideInteractiveExecutionServices,
): Promise<number> => {
  switch (result.action) {
    case "cancel":
      return result.exitCode
    case "print":
      if (result.goalExecution === undefined) writePrompt(services.write, result.prompt, "Selected prompt:")
      else {
        assertGuideGoalCandidate({ title: "Goal", notes: "", prompt: result.prompt, goalExecution: result.goalExecution })
        writeGoalInput(services, result.prompt, result.goalExecution, "Selected goal (not launched):")
      }
      return 0
    case "current-terminal":
      return executeCurrentTerminalResult(result, services)
    case "current-herdr-workspace":
    case "new-herdr-tab":
    case "herdr-worktree-create":
    case "herdr-worktree-open":
      return executeHerdrResult(result, services)
    case "batch":
      writeGuideBatchSummary(result.result, services.write)
      return guideBatchExitCode(result.result)
    default:
      return unexpectedGuideResult(result)
  }
}
