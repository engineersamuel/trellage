import {
  CommandRunnerError,
  type CommandRunner,
  type NativeSelectedProfile,
  type SelectedProfile,
} from "./guide-launch.js"

export enum ProfileReadinessKind {
  Ready = "ready",
  Blocked = "blocked",
}

export interface ProfileReadyResult {
  readonly kind: ProfileReadinessKind.Ready
  readonly summary: string
}

export interface ProfileBlockedResult {
  readonly kind: ProfileReadinessKind.Blocked
  readonly summary: string
  readonly diagnostic: string
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
    inventory.schemaVersion !== 1 ||
    inventory.launcher !== selected.launcher ||
    inventory.profile !== selected.profile
  ) {
    throw new ProfilePreflightError("Native inventory identity does not match the selected profile")
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
): Promise<ProfileReadinessResult> => {
  let stdout: string
  try {
    stdout = (
      await runner.run(selected.commandPath, ["inventory", selected.profile, "--json"], {
        cwd,
        timeoutMs: 30_000,
      })
    ).stdout
  } catch (cause) {
    if (cause instanceof CommandRunnerError) {
      return {
        kind: ProfileReadinessKind.Blocked,
        summary: `${selected.launcher}/${selected.profile} failed its inventory check`,
        diagnostic: diagnosticFromError(cause),
      }
    }
    throw cause
  }
  const inventory = parseNativeInventory(stdout, selected)
  return inventory.readiness === "healthy"
    ? {
        kind: ProfileReadinessKind.Ready,
        summary: `${selected.launcher}/${selected.profile} is healthy`,
      }
    : {
        kind: ProfileReadinessKind.Blocked,
        summary: `${selected.launcher}/${selected.profile} is ${inventory.readiness}`,
        diagnostic:
          inventory.readiness === "not-setup"
            ? `Run ${selected.launcher} setup ${selected.profile}, then retry.`
            : inventory.readiness === "busy"
              ? `Wait for the current ${selected.launcher} operation to finish, then retry.`
            : `Run ${selected.launcher} doctor ${selected.profile} for details.`,
      }
}

const checkSandboxReadiness = async (
  runner: CommandRunner,
  selected: Extract<SelectedProfile, { readonly surface: "sandbox" }>,
  cwd: string,
): Promise<ProfileReadinessResult> => {
  try {
    await runner.run(selected.commandPath, ["validate", selected.profile], {
      cwd,
      timeoutMs: 30_000,
    })
    return {
      kind: ProfileReadinessKind.Ready,
      summary: `${selected.profile} is valid`,
    }
  } catch (cause) {
    if (cause instanceof CommandRunnerError) {
      return {
        kind: ProfileReadinessKind.Blocked,
        summary: `${selected.profile} failed validation`,
        diagnostic: diagnosticFromError(cause),
      }
    }
    throw cause
  }
}

export const checkSelectedProfileReadiness = (
  runner: CommandRunner,
  selected: SelectedProfile,
  cwd: string,
): Promise<ProfileReadinessResult> =>
  selected.surface === "native"
    ? checkNativeReadiness(runner, selected, cwd)
    : checkSandboxReadiness(runner, selected, cwd)
