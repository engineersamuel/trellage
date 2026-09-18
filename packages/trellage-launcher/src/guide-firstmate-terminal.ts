import path from "node:path"
import {
  FIRSTMATE_MAX_REQUEST_BYTES,
  canonicalFirstmateJson,
  parseFirstmateFleetIdentityV1,
  parseFirstmateSubmissionRequestV1,
  sameFirstmateFleet,
  type FirstmateFleetIdentityV1,
  type FirstmateFleetReadinessV1,
  type FirstmateSubmissionRequestV1,
} from "@trellage/guide-core"
import type { GuideBatchEntryResult } from "./guide-batch.ts"
import { firstmateOutcomeFromReceipt } from "./guide-firstmate.ts"
import type { GuideInteractiveExecutionServices } from "./guide-interactive-execution.ts"
import {
  CommandRunnerError,
  buildGuideLaunchCommand,
  parseSelectedProfile,
  runInteractiveCommand,
  type CommandSpec,
  type NativeSelectedProfile,
  type SelectedProfile,
} from "./guide-launch.ts"
import { firstmateActionReadiness, inspectFirstmateReadiness, ProfileReadinessKind } from "./guide-preflight.ts"
import { firstmateInstanceControlArgs, selectedFirstmateInstance } from "./guide-firstmate-instance-selection.ts"
import { firstmateJobInstanceKey, firstmateProfileInstanceKey } from "./guide-firstmate-group.ts"

const maximumFleetIdentityArgumentBytes = 65_536

export interface FirstmateTerminalHandoff {
  readonly kind: "current-terminal"
  readonly status: "handoff-ready"
  readonly expectedFleet: FirstmateFleetIdentityV1
  readonly profile: NativeSelectedProfile
  readonly action: "start" | "recover"
  readonly cwd: string
  readonly requestIds: ReadonlyArray<string>
}

type AcceptedEntry = Extract<GuideBatchEntryResult, { status: "accepted" }>

const describeError = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : "An unknown error occurred."

const firstmateProfile = (selected: SelectedProfile): NativeSelectedProfile => {
  const profile = parseSelectedProfile(selected)
  if (profile.surface !== "native" || profile.launcher !== "fmx" || profile.orchestration === undefined) {
    throw new Error("Firstmate supervisor startup requires an inbox-capable native fmx profile.")
  }
  return profile
}

/** Builds execution-only argv. Public command previews remain unchanged. */
export const buildFirstmateSupervisorCommand = (
  selected: NativeSelectedProfile,
  expectedFleet: FirstmateFleetIdentityV1,
): CommandSpec => {
  const profile = firstmateProfile(selected)
  const identity = parseFirstmateFleetIdentityV1(expectedFleet)
  if (!sameFirstmateFleet(identity, expectedFleet) ||
      identity.profile !== profile.profile || identity.sourceRevision !== profile.orchestration!.sourceRevision) {
    throw new Error("The confirmed fleet identity must match the selected Firstmate profile without changes.")
  }
  const encoded = JSON.stringify(identity)
  if (Buffer.byteLength(encoded, "utf8") > maximumFleetIdentityArgumentBytes) {
    throw new Error("The Firstmate startup identity exceeds its 65536-byte argument limit.")
  }
  selectedFirstmateInstance(profile, identity)
  const { firstmateInstance: _instance, firstmateInstanceContext: _context, ...unbound } = profile
  const command = buildGuideLaunchCommand(unbound).command
  return { ...command, args: [...command.args, ...firstmateInstanceControlArgs(profile), "--fmx-expected-fleet-json", encoded] }
}

const confirmedEntryRequest = (entry: AcceptedEntry): FirstmateSubmissionRequestV1 => {
  const context = entry.job.guideContext
  const submission = entry.job.firstmate
  if (context === undefined || submission?.expectedFleet === undefined) {
    throw new Error("The saved request has no confirmed original input and fleet identity.")
  }
  return {
    schemaVersion: 1,
    requestId: submission.requestId,
    expectedFleet: submission.expectedFleet,
    originalIntent: context.originalIntent,
    generatedSpec: entry.job.prompt,
    workflowId: context.workflowId,
    projectTarget: context.projectTarget,
  }
}

const validateSavedRequest = (
  entry: AcceptedEntry,
  handoff: FirstmateTerminalHandoff,
  requestId: string,
): void => {
  const request = parseFirstmateSubmissionRequestV1(entry.request)
  const serialized = canonicalFirstmateJson(request)
  if (request.requestId !== requestId || !sameFirstmateFleet(request.expectedFleet, handoff.expectedFleet) ||
      serialized !== canonicalFirstmateJson(entry.request) ||
      serialized !== canonicalFirstmateJson(confirmedEntryRequest(entry))) {
    throw new Error("The terminal handoff does not match the exact saved request IDs, fleet, and confirmed payloads.")
  }
  const limit = Math.min(FIRSTMATE_MAX_REQUEST_BYTES, handoff.profile.orchestration!.submission.maxRequestBytes)
  if (Buffer.byteLength(serialized, "utf8") > limit) {
    throw new Error("The saved Firstmate request exceeds the profile's canonical byte limit.")
  }
  const outcome = firstmateOutcomeFromReceipt(request, entry.receipt)
  if (outcome.status !== "accepted") {
    throw new Error("The terminal handoff requires a valid same-request saved receipt for every request.")
  }
}

const validateHandoffEntry = (
  entry: GuideBatchEntryResult,
  handoff: FirstmateTerminalHandoff,
  requestId: string,
): void => {
  if (entry.status !== "accepted") {
    throw new Error("Every request in the fleet group must be saved before the terminal handoff.")
  }
  if (entry.startupError !== undefined || entry.receipt.announcement === "failed" ||
      entry.receipt.supervisorState === "unsafe" || entry.supervisor === "unsafe" || entry.supervisor === "unknown") {
    throw new Error("The terminal handoff is blocked by an unresolved receipt or supervisor error.")
  }
  if (entry.job.placement.kind !== "current-terminal" || entry.job.firstmate?.action !== handoff.action ||
      entry.cwd !== handoff.cwd || JSON.stringify(firstmateProfile(entry.job.profile)) !== JSON.stringify(handoff.profile)) {
    throw new Error("The terminal handoff must retain the fleet group's shared profile, action, placement, and working directory.")
  }
  validateSavedRequest(entry, handoff, requestId)
}

const terminalGroupEntries = (
  handoff: FirstmateTerminalHandoff,
  entries: ReadonlyArray<GuideBatchEntryResult>,
): ReadonlyArray<GuideBatchEntryResult> => {
  const members = entries.filter(({ job }) =>
    firstmateJobInstanceKey(job) === firstmateProfileInstanceKey(handoff.profile, handoff.expectedFleet))
  if (members.length !== handoff.requestIds.length || members.length === 0 ||
      new Set(handoff.requestIds).size !== members.length) {
    throw new Error("The terminal handoff must name every saved request in one fleet group exactly once, in queue order.")
  }
  if (entries.some((entry) => entry.job.placement?.kind === "current-terminal" &&
      entry.job.profile.surface === "native" && entry.job.profile.launcher === "fmx" && !members.includes(entry))) {
    throw new Error("Different Firstmate fleets cannot share the current terminal.")
  }
  return members
}

export const validateFirstmateTerminalHandoff = (
  original: FirstmateTerminalHandoff,
  entries: ReadonlyArray<GuideBatchEntryResult>,
): FirstmateTerminalHandoff => {
  if (original.kind !== "current-terminal" || original.status !== "handoff-ready" ||
      (original.action !== "start" && original.action !== "recover") || !Array.isArray(original.requestIds)) {
    throw new Error("A current-terminal handoff requires an explicit Start or Recover action and saved request IDs.")
  }
  if (typeof original.cwd !== "string" || !path.isAbsolute(original.cwd) || /[\u0000-\u001f\u007f-\u009f]/u.test(original.cwd)) {
    throw new Error("A Firstmate terminal handoff requires an absolute working directory without control characters.")
  }
  const handoff: FirstmateTerminalHandoff = {
    kind: "current-terminal", status: "handoff-ready",
    expectedFleet: parseFirstmateFleetIdentityV1(original.expectedFleet),
    profile: firstmateProfile(original.profile),
    action: original.action, cwd: original.cwd, requestIds: [...original.requestIds],
  }
  buildFirstmateSupervisorCommand(handoff.profile, original.expectedFleet)
  terminalGroupEntries(handoff, entries).forEach((entry, index) => {
    validateHandoffEntry(entry, handoff, handoff.requestIds[index]!)
  })
  return handoff
}

const inspectHandoffReadiness = async (
  handoff: FirstmateTerminalHandoff,
  services: GuideInteractiveExecutionServices,
): Promise<FirstmateFleetReadinessV1> => {
  const fleet = await inspectFirstmateReadiness(services.runner, handoff.profile, handoff.cwd)
  if (fleet.identity === null || !sameFirstmateFleet(fleet.identity, handoff.expectedFleet)) {
    throw new Error("The owned Firstmate fleet identity changed. Saved requests still belong to the original confirmed fleet.")
  }
  if (!fleet.actions.submit.allowed) {
    throw new Error(`Firstmate cannot use the saved requests: ${fleet.actions.submit.reason ?? "submission is not permitted."}`)
  }
  const action = fleet.supervisor.state === "running" ? "submit" : handoff.action
  const readiness = firstmateActionReadiness(handoff.profile, fleet, action)
  if (readiness.kind === ProfileReadinessKind.Blocked) {
    throw new Error(`${readiness.summary}. ${readiness.diagnostic}`)
  }
  return fleet
}

const writeAlreadyRunning = (services: GuideInteractiveExecutionServices): void => {
  services.write(
    "The confirmed owned Firstmate supervisor is already running. No further startup or prompt delivery was attempted.\n" +
    "Requests remain saved. Dispatch and task completion are not confirmed.\n",
  )
}

const failedHandoff = (services: GuideInteractiveExecutionServices, diagnostic: string, exitCode = 1): number => {
  services.write(
    `Firstmate current-terminal handoff failed: ${diagnostic}\n` +
    "Saved receipts are preserved. No startup retry or repeat prompt delivery was attempted.\n",
  )
  return exitCode
}

const handleLaunchFailure = async (
  handoff: FirstmateTerminalHandoff,
  services: GuideInteractiveExecutionServices,
  error: unknown,
): Promise<number> => {
  if (!(error instanceof CommandRunnerError) || error.kind !== "exited") {
    return failedHandoff(services, describeError(error))
  }
  const exitCode = error.exitCode ?? 130
  let diagnostic = describeError(error)
  if (error.exitCode !== null && error.exitCode !== 0) {
    try {
      const fleet = await inspectHandoffReadiness(handoff, services)
      if (fleet.supervisor.state === "running") {
        writeAlreadyRunning(services)
        return 0
      }
      diagnostic += " The confirmed owned supervisor is not running."
    } catch (cause) {
      diagnostic += ` ${describeError(cause)}`
    }
  }
  return failedHandoff(services, diagnostic, exitCode === 0 ? 1 : exitCode)
}

/** Called only after Ink releases stdin. It never submits or pastes a request. */
export const executeFirstmateTerminalHandoff = async (
  original: FirstmateTerminalHandoff,
  entries: ReadonlyArray<GuideBatchEntryResult>,
  services: GuideInteractiveExecutionServices,
): Promise<number> => {
  try {
    const handoff = validateFirstmateTerminalHandoff(original, entries)
    const fleet = await inspectHandoffReadiness(handoff, services)
    services.write(`Firstmate requests saved: ${handoff.requestIds.join(", ")}. Current-terminal handoff ready.\n`)
    if (fleet.supervisor.state === "running") {
      writeAlreadyRunning(services)
      return 0
    }
    const command = buildFirstmateSupervisorCommand(handoff.profile, handoff.expectedFleet)
    services.write(
      "Handing the current terminal to one guarded Firstmate supervisor with a startup instruction.\n" +
      "Saved request bodies stay in the inbox; they will not be sent again.\n",
    )
    try {
      await (services.runInteractive ?? runInteractiveCommand)(command, {
        cwd: handoff.cwd, env: { ...process.env, TRELLAGE_AUTOMATION: "1" },
      })
    } catch (error) {
      return handleLaunchFailure(handoff, services, error)
    }
    services.write(
      "Current terminal handed off; the Firstmate foreground process has exited.\n" +
      "Requests remain saved. Dispatch and task completion are not confirmed.\n",
    )
    return 0
  } catch (error) {
    return failedHandoff(services, describeError(error))
  }
}
