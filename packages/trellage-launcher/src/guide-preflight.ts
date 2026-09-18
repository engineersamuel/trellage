import {
  CommandRunnerError,
  parseSelectedProfile,
  renderCommandPreview,
  type CommandRunner,
  type NativeSelectedProfile,
  type SelectedProfile,
} from "./guide-launch.ts"
import type { GuideGoalExecution } from "./guide-goal-execution.ts"
import { checkGuideGoalReadiness, type GuideGoalReadinessServices } from "./guide-goal-readiness.ts"
import { assertGuideGoalProfile } from "./guide-goal-transport.ts"
import {
  parseFirstmateFleetReadinessV1,
  parseFirstmatePrerequisiteInstallPlanV1,
  type FirstmateFleetReadinessV1,
  type FirstmatePrerequisiteInstallPlanV1,
} from "@trellage/guide-core"
import {
  firstmateInstanceControlArgs, firstmateInstanceSelectorArgs, selectedFirstmateInstance,
} from "./guide-firstmate-instance-selection.ts"

export enum ProfileReadinessKind {
  Ready = "ready",
  Blocked = "blocked",
}

export interface ProfileReadyResult {
  readonly kind: ProfileReadinessKind.Ready
  readonly summary: string
  readonly goalReadiness?: "checked"
  readonly fleet?: FirstmateFleetReadinessV1
}

export interface ProfileBlockedResult {
  readonly kind: ProfileReadinessKind.Blocked
  readonly summary: string
  readonly diagnostic: string
  readonly goalReadiness?: "blocked" | "unknown"
  readonly fleet?: FirstmateFleetReadinessV1
}

export type ProfileReadinessResult = ProfileReadyResult | ProfileBlockedResult

export class ProfilePreflightError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ProfilePreflightError"
  }
}

export class FirstmatePreparationError extends ProfilePreflightError {
  constructor(message: string, readonly fleet?: FirstmateFleetReadinessV1, options?: ErrorOptions) {
    super(message, options)
    this.name = "FirstmatePreparationError"
  }
}

export interface FirstmatePreparationApproval {
  readonly commandPath: string
  readonly profile: string
  readonly sourceRevision: string
  readonly installation: FirstmatePrerequisiteInstallPlanV1
  readonly firstmateInstance?: NativeSelectedProfile["firstmateInstance"]
  readonly firstmateInstanceContext?: NativeSelectedProfile["firstmateInstanceContext"]
  readonly configurationCwd?: string
}

interface NativeInventory {
  readonly readiness: "healthy" | "unhealthy" | "not-setup" | "busy"
  readonly fleet?: FirstmateFleetReadinessV1
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
  return {
    readiness: inventory.readiness,
    ...(selected.orchestration === undefined || inventory.fleet === undefined
      ? {}
      : { fleet: parseFirstmateFleetReadinessV1(inventory.fleet) }),
  }
}

const firstmateProfile = (selected: NativeSelectedProfile): NativeSelectedProfile => {
  const profile = parseSelectedProfile(selected)
  if (profile.surface !== "native" || profile.launcher !== "fmx" || profile.orchestration === undefined) {
    throw new ProfilePreflightError("Fleet readiness requires a Firstmate orchestration profile.")
  }
  return profile
}

const firstmateInventory = (
  stdout: string,
  selected: NativeSelectedProfile,
): FirstmateFleetReadinessV1 => {
  const fleet = parseNativeInventory(stdout, selected).fleet
  if (fleet === undefined) throw new ProfilePreflightError("Firstmate inventory did not provide its fleet readiness contract.")
  if (fleet.identity !== null && (
    fleet.identity.profile !== selected.profile ||
    fleet.identity.sourceRevision !== selected.orchestration?.sourceRevision
  )) {
    throw new ProfilePreflightError("Firstmate fleet identity does not match the selected profile and source revision.")
  }
  if (fleet.identity !== null) selectedFirstmateInstance(selected, fleet.identity)
  return fleet
}

export const inspectFirstmateReadiness = async (
  runner: CommandRunner,
  selected: NativeSelectedProfile,
  cwd: string,
  signal?: AbortSignal,
): Promise<FirstmateFleetReadinessV1> => {
  const profile = firstmateProfile(selected)
  const result = await runner.run(profile.commandPath, ["inventory", profile.profile, "--json", ...firstmateInstanceSelectorArgs(profile)], {
    cwd, timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }),
  })
  return firstmateInventory(result.stdout, profile)
}

const preparedFirstmateInventory = (stdout: string, selected: NativeSelectedProfile): FirstmateFleetReadinessV1 => {
  const fleet = firstmateInventory(stdout, selected)
  if (fleet.preparation === undefined) {
    throw new ProfilePreflightError("Firstmate prepare did not provide its advertised preparation result.")
  }
  return fleet
}

const failedPreparation = (cause: CommandRunnerError, selected: NativeSelectedProfile): FirstmatePreparationError => {
  let fleet: FirstmateFleetReadinessV1 | undefined
  try {
    fleet = preparedFirstmateInventory(cause.stdout, selected)
  } catch {
    // Failed commands may return a diagnostic instead of inventory JSON.
  }
  const diagnostic = cause.stderr.trim() || fleet?.preparation?.diagnostic || (
    fleet === undefined ? diagnosticFromError(cause) : cause.message
  )
  const status = cause.exitCode === null ? cause.kind : `exit ${cause.exitCode}`
  return new FirstmatePreparationError(`Firstmate preparation failed (${status}): ${diagnostic}`, fleet, { cause })
}

const validatePreparationApproval = (
  approval: FirstmatePreparationApproval, profile: NativeSelectedProfile, cwd: string,
): void => {
  if (approval.commandPath !== profile.commandPath || approval.profile !== profile.profile ||
      approval.sourceRevision !== profile.orchestration?.sourceRevision) {
    throw new ProfilePreflightError("The installation approval belongs to a different profile or source revision. Review the current plan again.")
  }
  if (JSON.stringify(approval.firstmateInstance) !== JSON.stringify(profile.firstmateInstance) ||
      JSON.stringify(approval.firstmateInstanceContext) !== JSON.stringify(profile.firstmateInstanceContext) ||
      (approval.configurationCwd !== undefined && approval.configurationCwd !== cwd) ||
      (profile.firstmateInstance?.mode === "named" && approval.configurationCwd === undefined)) {
    throw new ProfilePreflightError("The installation approval belongs to a different instance, control context, or configuration directory. Review the current plan again.")
  }
}

/** Only the action menu calls preparation. Saved requests and continuation use inventory instead. */
export const prepareFirstmateReadiness = async (
  runner: CommandRunner,
  selected: NativeSelectedProfile,
  cwd: string,
  options: { readonly signal?: AbortSignal; readonly approval?: FirstmatePreparationApproval } = {},
): Promise<FirstmateFleetReadinessV1> => {
  const profile = firstmateProfile(selected)
  const orchestration = profile.orchestration
  if (orchestration?.preparation?.schemaVersion !== 1) {
    throw new ProfilePreflightError("This Firstmate backend does not advertise safe preparation. Use inventory and the reported manual action.")
  }
  const args = ["prepare", profile.profile, "--json", "--expected-source-revision", orchestration.sourceRevision,
    ...firstmateInstanceControlArgs(profile)]
  if (options.approval !== undefined) {
    const approval = options.approval
    validatePreparationApproval(approval, profile, cwd)
    const plan = parseFirstmatePrerequisiteInstallPlanV1(approval.installation)
    args.push("--install-prerequisites", plan.identity)
  }
  options.signal?.throwIfAborted()
  let stdout: string
  try {
    stdout = (await runner.run(profile.commandPath, args, {
      cwd,
      timeoutMs: options.approval === undefined ? 5 * 60_000 : 20 * 60_000,
      terminationGraceMs: 10_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })).stdout
  } catch (cause) {
    if (cause instanceof CommandRunnerError) throw failedPreparation(cause, profile)
    throw cause
  }
  options.signal?.throwIfAborted()
  return preparedFirstmateInventory(stdout, profile)
}

export const firstmatePrerequisiteStatus = (
  fleet: FirstmateFleetReadinessV1,
  prerequisite: FirstmateFleetReadinessV1["prerequisites"][number],
): "ready" | "blocked" | "not-checked" =>
  prerequisite.status ?? (prerequisite.ready ? "ready" : fleet.runtime === "ready" ? "blocked" : "not-checked")

export const firstmateInstallationPlan = (
  fleet: FirstmateFleetReadinessV1,
): FirstmatePrerequisiteInstallPlanV1 | undefined =>
  fleet.preparation?.state === "needs-consent" &&
  fleet.runtime !== "unsafe" && fleet.runtime !== "busy" &&
  fleet.supervisor.state !== "running" && fleet.supervisor.state !== "unsafe" &&
  fleet.activeWorkers === 0
    ? fleet.preparation.installation ?? undefined
    : undefined

export const firstmateMaintenanceCommand = (
  selected: NativeSelectedProfile,
  action: "doctor" | "setup",
): string => renderCommandPreview({ executable: selected.commandPath, args: [action, selected.profile, ...firstmateInstanceSelectorArgs(selected)] })

const firstmateManualCheck = (selected: NativeSelectedProfile): string =>
  `Run ${firstmateMaintenanceCommand(selected, "doctor")}, then refresh.`

const firstmateStartupDiagnostic = (
  selected: NativeSelectedProfile,
  fleet: FirstmateFleetReadinessV1,
): string | undefined => {
  const missing = fleet.prerequisites.filter((item) => firstmatePrerequisiteStatus(fleet, item) === "blocked")
  if (missing.length > 0) {
    const next = firstmateInstallationPlan(fleet) === undefined
      ? firstmateManualCheck(selected)
      : "Review the managed-tool installation plan before approval."
    return `These prerequisites are not ready:\n${missing.map(({ id, description }) => `  ${id}: ${description}`).join("\n")}\n${next}`
  }
  if (fleet.backend === null) return `Firstmate requires an available Herdr or tmux backend. ${firstmateManualCheck(selected)}`
  if (fleet.consentRequired) {
    return `Setup consent is required. Run ${firstmateMaintenanceCommand(selected, "setup")}, then refresh. Setup consent does not approve managed-tool installation.`
  }
  const unchecked = fleet.prerequisites.filter((item) => firstmatePrerequisiteStatus(fleet, item) === "not-checked")
  return unchecked.length === 0 ? undefined : `Not checked: ${unchecked.map(({ id }) => id).join(", ")}. ${firstmateManualCheck(selected)}`
}

const firstmateAdmissionDiagnostic = (
  selected: NativeSelectedProfile,
  fleet: FirstmateFleetReadinessV1,
  action: keyof FirstmateFleetReadinessV1["actions"],
): string | undefined => {
  if (selected.launcher !== "fmx" || selected.orchestration === undefined) return "A supported Firstmate orchestration contract is required."
  if (fleet.identity === null) return `An owned Firstmate fleet identity is required. ${firstmateManualCheck(selected)}`
  if (fleet.identity.profile !== selected.profile || fleet.identity.sourceRevision !== selected.orchestration.sourceRevision) {
    return "The Firstmate fleet does not match the selected profile and source revision."
  }
  try {
    selectedFirstmateInstance(selected, fleet.identity)
  } catch (cause) {
    return cause instanceof Error ? cause.message : "The selected instance does not match the owned fleet."
  }
  if (fleet.runtime !== "ready") {
    return `The Firstmate runtime is ${fleet.runtime}; no fleet action is permitted. ${fleet.preparation?.diagnostic ?? firstmateManualCheck(selected)}`
  }
  if (fleet.supervisor.state === "unsafe") return "The Firstmate supervisor ownership is unsafe."
  return action === "submit" ? undefined : firstmateStartupDiagnostic(selected, fleet)
}

const distinctFirstmateDiagnostics = (messages: ReadonlyArray<string | undefined>): string =>
  [...new Set(messages.filter((message): message is string => message !== undefined))]
    .filter((message, _index, all) => !all.some((other) => other !== message && other.includes(message)))
    .join(" ")

export const firstmateActionReadiness = (
  selected: NativeSelectedProfile,
  fleet: FirstmateFleetReadinessV1,
  action: keyof FirstmateFleetReadinessV1["actions"],
): ProfileReadinessResult => {
  const permission = fleet.actions[action]
  const requiresSupervisor = action === "submit" && fleet.supervisor.state !== "running"
  const diagnostic = firstmateAdmissionDiagnostic(selected, fleet, action)
  const nativeReason = permission.allowed ? undefined : permission.reason ?? "Firstmate did not authorize this action."
  const genericReason = nativeReason !== undefined && /inventory never installs|existing tools, authentication/iu.test(nativeReason)
  if (diagnostic !== undefined || !permission.allowed || requiresSupervisor) {
    return {
      kind: ProfileReadinessKind.Blocked,
      summary: `${selected.launcher}/${selected.profile} cannot ${action}`,
      diagnostic: distinctFirstmateDiagnostics([
        diagnostic !== undefined && genericReason ? undefined : nativeReason,
        diagnostic,
        requiresSupervisor
          ? "Send work requires an existing owned supervisor. Choose Start fleet or Recover fleet explicitly."
          : undefined,
      ]),
      fleet,
    }
  }
  return {
    kind: ProfileReadinessKind.Ready,
    summary: `${selected.launcher}/${selected.profile} permits ${action}; runtime and task completion are separate`,
    fleet,
  }
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
      await runner.run(selected.commandPath, ["inventory", selected.profile, "--json"], {
        cwd,
        timeoutMs: 30_000,
        ...(signal === undefined ? {} : { signal }),
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
  allowRepair = true,
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
  if (!allowRepair) {
    return {
      kind: ProfileReadinessKind.Blocked,
      summary: `${selected.profile} is not ready for a goal launch`,
      diagnostic: `Development resolution: ${initial.developmentResolution}; image: ${initial.image}. Prepare the Sandbox separately, then retry. No automatic repair was run.`,
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

export const checkSelectedProfileReadiness = async (
  runner: CommandRunner,
  selected: SelectedProfile,
  cwd: string,
  signal?: AbortSignal,
  goalExecution?: GuideGoalExecution,
  goalServices?: GuideGoalReadinessServices,
): Promise<ProfileReadinessResult> => {
  if (goalExecution !== undefined) assertGuideGoalProfile(selected, goalExecution)
  const general = await (selected.surface === "native"
    ? checkNativeReadiness(runner, selected, cwd, signal)
    : checkSandboxReadiness(runner, selected, cwd, signal, goalExecution === undefined))
  if (general.kind === ProfileReadinessKind.Blocked || goalExecution === undefined) return general
  const goal = await checkGuideGoalReadiness(runner, selected, cwd, goalExecution, signal, goalServices)
  return goal.kind === "checked"
    ? { kind: ProfileReadinessKind.Ready, summary: `${goal.summary}. ${goal.diagnostic}`, goalReadiness: "checked" }
    : { kind: ProfileReadinessKind.Blocked, summary: goal.summary, diagnostic: goal.diagnostic, goalReadiness: goal.kind }
}
