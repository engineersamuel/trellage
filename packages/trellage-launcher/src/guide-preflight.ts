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

interface SandboxDoctor {
  readonly developmentResolution: boolean
  readonly image: SandboxImageState
}

type SandboxImageState = "available" | "absent" | "stale" | "error"

const sandboxDoctorTimeoutMs = 5 * 60_000
const sandboxBuildTimeoutMs = 30 * 60_000

const diagnosticFromError = (error: CommandRunnerError): string => {
  const diagnostic = error.stderr.trim() || error.stdout.trim()
  return diagnostic.length > 0 ? diagnostic : error.message
}

const parseSandboxImageState = (value: string | undefined): SandboxImageState => {
  if (value === "available" || value === "absent" || value === "stale" || value === "error") return value
  throw new ProfilePreflightError("Sandbox doctor returned an unsupported image status")
}

const parseSandboxDoctor = (source: string, selectedProfile: string): SandboxDoctor => {
  const profile = /^profile: ([^ ]+) \(.+\)$/mu.exec(source)?.[1]
  const developmentResolution = /^development resolution: (true|false)$/mu.exec(source)?.[1]
  const image = /^image: .+ \((available|absent|stale|error)\)$/mu.exec(source)?.[1]
  if (profile !== selectedProfile || developmentResolution === undefined) {
    throw new ProfilePreflightError("Sandbox doctor returned an unsupported status")
  }
  return {
    developmentResolution: developmentResolution === "true",
    image: parseSandboxImageState(image),
  }
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
  signal?: AbortSignal,
): Promise<ProfileReadinessResult> => {
  const options = (timeoutMs: number, outputOverflow?: "terminate" | "truncate") => ({
    cwd,
    timeoutMs,
    ...(signal === undefined ? {} : { signal }),
    ...(outputOverflow === undefined ? {} : { outputOverflow }),
  })
  const doctor = async (): Promise<SandboxDoctor> =>
    parseSandboxDoctor(
      (
        await runner.run(selected.commandPath, ["doctor", "--profile", selected.profile], {
          ...options(sandboxDoctorTimeoutMs),
        })
      ).stdout,
      selected.profile,
    )

  let initial: SandboxDoctor
  try {
    initial = await doctor()
  } catch (cause) {
    if (cause instanceof CommandRunnerError) {
      return {
        kind: ProfileReadinessKind.Blocked,
        summary: `${selected.profile} status check failed`,
        diagnostic: diagnosticFromError(cause),
      }
    }
    throw cause
  }
  if (initial.developmentResolution && initial.image === "available") {
    return {
      kind: ProfileReadinessKind.Ready,
      summary: `${selected.profile} is ready`,
    }
  }

  try {
    await runner.run(selected.commandPath, ["build", selected.profile], {
      ...options(sandboxBuildTimeoutMs, "truncate"),
    })
    const repaired = await doctor()
    if (!repaired.developmentResolution || repaired.image !== "available") {
      return {
        kind: ProfileReadinessKind.Blocked,
        summary: `${selected.profile} remains unavailable after automatic repair`,
        diagnostic: `Development resolution: ${repaired.developmentResolution}; image: ${repaired.image}.`,
      }
    }
    return {
      kind: ProfileReadinessKind.Ready,
      summary: `${selected.profile} was repaired and is ready`,
    }
  } catch (cause) {
    if (cause instanceof CommandRunnerError) {
      return {
        kind: ProfileReadinessKind.Blocked,
        summary: `${selected.profile} automatic repair failed`,
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
  signal?: AbortSignal,
): Promise<ProfileReadinessResult> =>
  selected.surface === "native"
    ? checkNativeReadiness(runner, selected, cwd)
    : checkSandboxReadiness(runner, selected, cwd, signal)
