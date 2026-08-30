import {
  CommandRunnerError,
  GuideLaunchError,
  createHerdrWorktreeAndHandoff,
  handoffToCurrentHerdrWorkspace,
  openHerdrWorktreeAndHandoff,
  runInteractiveCommand,
  type CommandRunner,
  type CommandSpec,
} from "./guide-launch.js"
import type { GuideUiResult } from "./guide-ui.js"

const startupTimeoutMs = 60_000
const promptTimeoutMs = 60_000

export interface GuideInteractiveExecutionServices {
  readonly runner: CommandRunner
  readonly write: (text: string) => void
  readonly runInteractive?: (command: CommandSpec, options: { readonly cwd: string }) => Promise<void>
}

const writePrompt = (write: GuideInteractiveExecutionServices["write"], prompt: string, instruction: string): void => {
  write(`${instruction}\n\n${prompt}\n`)
}

const writeRecoveryPrompt = (services: GuideInteractiveExecutionServices, prompt: string): void =>
  writePrompt(services.write, prompt, "Automatic prompt delivery failed. Use this prompt manually:")

const writeIncompleteLaunchPrompt = (services: GuideInteractiveExecutionServices, prompt: string): void =>
  writePrompt(services.write, prompt, "Profile launch did not complete. Selected prompt:")

const unexpectedGuideResult = (result: never): never => {
  const action =
    typeof result === "object" && result !== null && "action" in result
      ? String((result as { readonly action: unknown }).action)
      : "missing"
  throw new Error(`interactive guide returned an unsupported action: ${action}`)
}

const executeHerdrResult = async (
  result: Exclude<GuideUiResult, { readonly action: "cancel" | "print" | "current-terminal" }>,
  services: GuideInteractiveExecutionServices,
): Promise<void> => {
  try {
    switch (result.action) {
      case "current-herdr-workspace":
        await handoffToCurrentHerdrWorkspace(services.runner, {
          callerPaneId: result.callerPaneId,
          cwd: result.cwd,
          direction: result.direction,
          command: result.command,
          prompt: result.prompt,
          promptDelivery: result.promptDelivery,
          timeoutMs: startupTimeoutMs,
          promptTimeoutMs,
        })
        return
      case "herdr-worktree-create":
        await createHerdrWorktreeAndHandoff(services.runner, {
          primaryCheckoutPath: result.primaryCheckoutPath,
          branch: result.branch,
          baseRef: result.baseRef,
          command: result.command,
          prompt: result.prompt,
          promptDelivery: result.promptDelivery,
          timeoutMs: startupTimeoutMs,
          promptTimeoutMs,
        })
        return
      case "herdr-worktree-open":
        await openHerdrWorktreeAndHandoff(services.runner, {
          primaryCheckoutPath: result.primaryCheckoutPath,
          path: result.path,
          command: result.command,
          prompt: result.prompt,
          promptDelivery: result.promptDelivery,
          timeoutMs: startupTimeoutMs,
          promptTimeoutMs,
        })
        return
      default:
        unexpectedGuideResult(result)
    }
  } catch (error) {
    if (error instanceof GuideLaunchError && error.paneId !== undefined) {
      writeRecoveryPrompt(services, result.prompt)
    } else {
      writeIncompleteLaunchPrompt(services, result.prompt)
    }
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
      writePrompt(services.write, result.prompt, "Selected prompt:")
      return 0
    case "current-terminal":
      if (result.promptHandling === "manual-paste") {
        writePrompt(services.write, result.prompt, "Paste this prompt after the profile starts:")
      }
      try {
        await (services.runInteractive ?? runInteractiveCommand)(result.command, {
          cwd: result.cwd,
        })
        return 0
      } catch (error) {
        if (error instanceof CommandRunnerError && error.kind === "exited") {
          return error.exitCode ?? 130
        }
        throw error
      }
    case "current-herdr-workspace":
    case "herdr-worktree-create":
    case "herdr-worktree-open":
      await executeHerdrResult(result, services)
      return 0
    default:
      return unexpectedGuideResult(result)
  }
}
