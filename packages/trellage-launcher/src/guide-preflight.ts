import {
  CommandRunnerError,
  parseSelectedProfile,
  type CommandRunner,
  type NativeSelectedProfile,
  type SelectedProfile,
} from "./guide-launch.ts"
import type { GuideGoalExecution } from "./guide-goal-execution.ts"
import { checkGuideGoalReadiness, type GuideGoalReadinessServices } from "./guide-goal-readiness.ts"
import { assertGuideGoalProfile } from "./guide-goal-transport.ts"
export enum ProfileReadinessKind {
  Ready = "ready",
  Blocked = "blocked",
}

export interface ProfileReadyResult {
  readonly kind: ProfileReadinessKind.Ready
  readonly summary: string
  readonly goalReadiness?: "checked"
}

export interface ProfileBlockedResult {
  readonly kind: ProfileReadinessKind.Blocked
  readonly summary: string
  readonly diagnostic: string
  readonly goalReadiness?: "blocked" | "unknown"
}

export type ProfileReadinessResult = ProfileReadyResult | ProfileBlockedResult

export class ProfilePreflightError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ProfilePreflightError"
  }
}

interface NativeInventory {
  readonly readiness: "healthy" | "unhealthy" | "not-setup" | "busy"
}

const diagnosticFromError = (error: CommandRunnerError): string => {
  const diagnostic = error.stderr.trim() || error.stdout.trim()
  return diagnostic.length > 0 ? diagnostic : error.message
}

const parseNativeInventory = (source: string, selected: NativeSelectedProfile): NativeInventory => {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (cause) {
    throw new ProfilePreflightError("Native inventory did not return valid JSON", { cause })
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProfilePreflightError("Native inventory must return a JSON object")
  }
  const inventory = value as Record<string, unknown>
  if (
    inventory.schemaVersion !== 2 ||
    inventory.harness !== selected.harness ||
    !Array.isArray(inventory.profiles) ||
    JSON.stringify(inventory.profiles) !== JSON.stringify(selected.profiles)
  ) {
    throw new ProfilePreflightError("Native inventory identity does not match the selected composition")
  }
  if (
    inventory.readiness !== "healthy" &&
    inventory.readiness !== "unhealthy" &&
    inventory.readiness !== "not-setup" &&
    inventory.readiness !== "busy"
  ) {
    throw new ProfilePreflightError("Native inventory returned an unsupported readiness value")
  }
  return { readiness: inventory.readiness }
}

const checkNativeReadiness = async (
  runner: CommandRunner,
  selected: NativeSelectedProfile,
  cwd: string,
  signal?: AbortSignal,
): Promise<ProfileReadinessResult> => {
  let stdout: string
  try {
    stdout = (
      await runner.run(selected.commandPath, ["inventory", selected.harness, ...selected.profiles, "--json"], {
        cwd,
        timeoutMs: 30_000,
        ...(signal === undefined ? {} : { signal }),
      })
    ).stdout
  } catch (cause) {
    if (cause instanceof CommandRunnerError) {
      return {
        kind: ProfileReadinessKind.Blocked,
        summary: `${selected.harness}/${selected.profiles.join("+")} failed its inventory check`,
        diagnostic: diagnosticFromError(cause),
      }
    }
    throw cause
  }
  const inventory = parseNativeInventory(stdout, selected)
  return inventory.readiness === "healthy"
    ? {
        kind: ProfileReadinessKind.Ready,
        summary: `${selected.harness}/${selected.profiles.join("+")} is healthy`,
      }
    : {
        kind: ProfileReadinessKind.Blocked,
        summary: `${selected.harness}/${selected.profiles.join("+")} is ${inventory.readiness}`,
        diagnostic:
          inventory.readiness === "not-setup"
            ? `Run trx setup ${selected.harness} ${selected.profiles.join(" ")}, then retry.`
            : inventory.readiness === "busy"
              ? `Wait for the current ${selected.harness} operation to finish, then retry.`
              : `Run trx doctor ${selected.harness} ${selected.profiles.join(" ")} for details.`,
      }
}

const validateInteractiveCheck = (stdout: string, selected: NativeSelectedProfile): void => {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch (cause) {
    throw new ProfilePreflightError("Workflow check did not return valid JSON", { cause })
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProfilePreflightError("Workflow check must return an object")
  }
  const check = value as Record<string, unknown>
  const identity = [check.schemaVersion, check.harness, check.profiles, check.mode, check.agent, check.requiredSkills]
  const expected = [2, selected.harness, selected.profiles, "interactive", selected.agent, selected.interaction?.requiredSkills]
  if (JSON.stringify(identity) !== JSON.stringify(expected) ||
      typeof check.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(check.manifestSha256)) {
    throw new ProfilePreflightError("Workflow check does not match the selected interactive agent and skills")
  }
}

const checkInteractiveReadiness = async (
  runner: CommandRunner, selected: NativeSelectedProfile, cwd: string, signal?: AbortSignal,
): Promise<ProfileReadinessResult> => {
  const interaction = selected.interaction
  if (interaction === undefined || selected.agent === undefined) {
    throw new ProfilePreflightError("Interactive workflow requirements are missing")
  }
  let stdout: string
  try {
    stdout = (await runner.run(selected.commandPath, [
      "workflow-check", selected.harness, ...selected.profiles, "--agent", selected.agent,
      ...interaction.requiredSkills.flatMap((skill) => ["--require-skill", skill]),
    ], { cwd, timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }) })).stdout
  } catch (cause) {
    if (!(cause instanceof CommandRunnerError)) throw cause
    return {
      kind: ProfileReadinessKind.Blocked,
      summary: "This customer workflow is unavailable",
      diagnostic: `${diagnosticFromError(cause)}\nUse an updated trx router and an HVE installation with the required agent and skills. No workflow was started.`,
    }
  }
  validateInteractiveCheck(stdout, selected)
  return {
    kind: ProfileReadinessKind.Ready,
    summary: `${selected.agent} is available. This session asks questions and requires human decisions.`,
  }
}

export const checkSelectedProfileReadiness = async (
  runner: CommandRunner,
  selected: SelectedProfile,
  cwd: string,
  signal?: AbortSignal,
  goalExecution?: GuideGoalExecution,
  goalServices?: GuideGoalReadinessServices,
): Promise<ProfileReadinessResult> => {
  selected = parseSelectedProfile(selected)
  if (goalExecution !== undefined) assertGuideGoalProfile(selected, goalExecution)
  const general = await checkNativeReadiness(runner, selected, cwd, signal)
  if (general.kind === ProfileReadinessKind.Blocked) return general
  if (selected.interaction !== undefined) {
    return checkInteractiveReadiness(runner, selected, cwd, signal)
  }
  if (goalExecution === undefined) return general
  const goal = await checkGuideGoalReadiness(runner, selected, cwd, goalExecution, signal, goalServices)
  return goal.kind === "checked"
    ? { kind: ProfileReadinessKind.Ready, summary: `${goal.summary}. ${goal.diagnostic}`, goalReadiness: "checked" }
    : { kind: ProfileReadinessKind.Blocked, summary: goal.summary, diagnostic: goal.diagnostic, goalReadiness: goal.kind }
}
