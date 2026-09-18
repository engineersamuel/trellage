import path from "node:path"
import {
  FIRSTMATE_MAX_RESPONSE_BYTES,
  firstmateInstanceCli,
  parseFirstmateFleetReadinessV1,
  sameFirstmateFleet,
  validateFirstmateInstanceControlContextV1,
  validateFirstmateInstanceFleet,
  type FirstmateFleetIdentityV1,
  type FirstmateFleetReadinessV1,
  type FirstmateInstanceDescriptorV1,
} from "@trellage/guide-core"
import { isAdminFirstmate, type AdminProfileEntry } from "./admin-model.ts"
import {
  createFirstmateInstanceContext,
  firstmateInstanceControlArgs,
  firstmateInstanceSelectorArgs,
} from "./guide-firstmate-instance-selection.ts"
import type { CommandSpec, NativeSelectedProfile } from "./guide-launch.ts"

export const adminDiagnosticScopeLines = (
  instance: FirstmateInstanceDescriptorV1 | undefined,
  command: CommandSpec | undefined,
): ReadonlyArray<string> => [
  ...(instance === undefined ? [] : [
    `Firstmate instance: ${instance.name} (${instance.mode}); template: ${instance.profile}; UUID: ${instance.reference?.instanceId ?? "missing identity"}.`,
    `Owned root: ${instance.root}`,
    `Association: ${instance.worktree.status}${instance.mode === "named" ? `; worktree: ${instance.worktree.evidence.locators.worktree}` : ""}.`,
    "Keep this exact instance selector. Do not replace it with an unqualified Firstmate profile.",
    "This diagnostic task does not authorize fleet creation, setup, rebinding, or package installation.",
  ]),
  ...(command === undefined ? [] : [`Read-only doctor argument vector: ${JSON.stringify([command.executable, ...command.args])}`]),
]

export const adminNativeSelectedProfile = (entry: AdminProfileEntry): NativeSelectedProfile => ({
  surface: "native",
  launcher: entry.launcher ?? "",
  commandPath: entry.commandPath,
  profile: entry.name,
  headlessPrompt: false,
  ...(entry.orchestration === undefined ? {} : { orchestration: entry.orchestration }),
  ...(entry.firstmateInstance === undefined ? {} : { firstmateInstance: entry.firstmateInstance }),
  ...(entry.firstmateInstanceContext === undefined ? {} : { firstmateInstanceContext: entry.firstmateInstanceContext }),
})

export const adminInstanceSelectorArgs = (entry: AdminProfileEntry): ReadonlyArray<string> => {
  if (!isAdminFirstmate(entry)) return []
  if (entry.firstmateDiscovery === "pending" || entry.firstmateDiscovery === "failed") {
    throw new Error(entry.firstmateDiscoveryDiagnostic ?? "Firstmate instance discovery is incomplete.")
  }
  // A missing legacy identity is still inspectable. It is not a new UUID.
  if (entry.orchestration?.instances !== undefined && entry.firstmateInstanceDescriptor?.reference === null) {
    return [firstmateInstanceCli.selector, "legacy"]
  }
  return firstmateInstanceSelectorArgs(adminNativeSelectedProfile(entry))
}

const descriptorStateBlockReason = (entry: AdminProfileEntry): string | undefined => {
  const descriptor = entry.firstmateInstanceDescriptor
  if (descriptor === undefined) {
    return entry.firstmateInstance === undefined && entry.firstmateDiscovery === undefined
      ? undefined
      : "The selected Firstmate instance has no verified descriptor. Refresh the instance list."
  }
  if (descriptor.reference === null || descriptor.creationState !== "published") {
    return `Instance ${descriptor.name} has ${descriptor.creationState} state. Recover the same identity; Admin does not create or finish fleets.`
  }
  if (descriptor.mode === "named" && descriptor.runtime.state === "unsafe") {
    return `Instance ${descriptor.name} has unsafe runtime state. Inspect it before maintenance.`
  }
  if (descriptor.mode === "named" && descriptor.runtime.required.sourceRevision !== entry.orchestration?.sourceRevision) {
    return "The instance runtime requirement differs from this profile's catalog source. Inspect it before maintenance."
  }
  return undefined
}

const firstmateStateBlockReason = (entry: AdminProfileEntry): string | undefined => {
  if (!isAdminFirstmate(entry)) return undefined
  if (entry.firstmateDiscovery === "pending" || entry.firstmateDiscovery === "failed") {
    return entry.firstmateDiscoveryDiagnostic ?? "Firstmate instance discovery is incomplete."
  }
  if (entry.firstmateFleet?.runtime === "unsafe" || entry.firstmateFleet?.supervisor.state === "unsafe") {
    return "Firstmate reports unsafe fleet state. Inspect this instance before maintenance."
  }
  return descriptorStateBlockReason(entry)
}

/** Builds an approval from the displayed descriptor, never from a new discovery or cwd lookup. */
export const adminFirstmateControlProfile = (entry: AdminProfileEntry): NativeSelectedProfile => {
  const reason = firstmateStateBlockReason(entry)
  if (reason !== undefined) throw new Error(reason)
  const selected = adminNativeSelectedProfile(entry)
  const descriptor = entry.firstmateInstanceDescriptor
  if (descriptor === undefined) return selected
  const context = entry.firstmateInstanceContext ?? createFirstmateInstanceContext(descriptor, null, "confirmed-join")
  validateFirstmateInstanceControlContextV1(context, descriptor)
  const profile = {
    ...selected,
    firstmateInstanceContext: context,
  }
  firstmateInstanceControlArgs(profile)
  return profile
}

export const adminFirstmateMutationBlockReason = (entry: AdminProfileEntry): string | undefined => {
  if (!isAdminFirstmate(entry)) return undefined
  try {
    adminFirstmateControlProfile(entry)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export const adminInstanceControlArgs = (entry: AdminProfileEntry): ReadonlyArray<string> =>
  isAdminFirstmate(entry) ? firstmateInstanceControlArgs(adminFirstmateControlProfile(entry)) : []

export const adminFirstmatePreparationBlockReason = (entry: AdminProfileEntry): string | undefined => {
  const reason = adminFirstmateMutationBlockReason(entry)
  if (reason !== undefined) return reason
  if (entry.orchestration?.preparation === undefined) {
    return "This Firstmate backend does not advertise safe preparation. Use doctor; Admin will not run setup."
  }
  if (entry.firstmateInstanceDescriptor === undefined && entry.firstmateFleet?.identity == null) {
    return "Safe preparation requires an existing verified fleet identity. Inspect the legacy fleet; Admin will not create one."
  }
  return undefined
}

const firstmateInventoryPayload = (stdout: string, entry: AdminProfileEntry): unknown => {
  if (Buffer.byteLength(stdout, "utf8") > FIRSTMATE_MAX_RESPONSE_BYTES) {
    throw new Error("Firstmate inventory exceeded its output limit.")
  }
  const value: unknown = JSON.parse(stdout)
  if (typeof value !== "object" || value === null || !("schemaVersion" in value) || value.schemaVersion !== 1 ||
      !("launcher" in value) || value.launcher !== "fmx" || !("profile" in value) || value.profile !== entry.name ||
      !("fleet" in value)) {
    throw new Error("Firstmate inventory does not identify the selected profile and fleet.")
  }
  return value.fleet
}

const validateInventoryIdentity = (identity: FirstmateFleetIdentityV1, entry: AdminProfileEntry): void => {
  if (identity.profile !== entry.name) throw new Error("Firstmate inventory belongs to another profile.")
  if (entry.firstmateInstance !== undefined) validateFirstmateInstanceFleet(entry.firstmateInstance, identity)
  const descriptor = entry.firstmateInstanceDescriptor
  if (descriptor !== undefined && identity.home !== path.join(descriptor.root, "home")) {
    throw new Error("Firstmate inventory belongs to another instance home.")
  }
}

export const parseAdminFirstmateInventory = (stdout: string, entry: AdminProfileEntry): FirstmateFleetReadinessV1 => {
  const fleet = parseFirstmateFleetReadinessV1(firstmateInventoryPayload(stdout, entry))
  const descriptor = entry.firstmateInstanceDescriptor
  if (descriptor?.creationState === "published" && fleet.identity === null) {
    throw new Error("Firstmate inventory is missing the published instance identity. Recover it without creating a fleet.")
  }
  if (descriptor?.reference === null && fleet.identity !== null) {
    throw new Error("Legacy identity changed after discovery. Refresh before selecting it.")
  }
  if (fleet.identity !== null) validateInventoryIdentity(fleet.identity, entry)
  return fleet
}

export const adminFirstmatePreparationDiagnostic = (entry: AdminProfileEntry, stdout: string): string | undefined => {
  try {
    const fleet = parseAdminFirstmateInventory(stdout, entry)
    if (fleet.identity === null || fleet.identity.sourceRevision !== entry.orchestration?.sourceRevision) {
      return "Firstmate preparation did not retain the selected fleet and expected source."
    }
    if (entry.firstmateFleet?.identity != null && !sameFirstmateFleet(entry.firstmateFleet.identity, fleet.identity)) {
      return "Firstmate preparation changed the previously selected fleet identity."
    }
    if (fleet.preparation === undefined) return "Firstmate prepare returned no preparation result."
    if (fleet.preparation.state !== "ready") {
      return `Firstmate preparation ${fleet.preparation.state}: ${fleet.preparation.diagnostic ?? "operator review required"}. No setup or installation was authorized.`
    }
    if (fleet.runtime !== "ready") return `Firstmate runtime remains ${fleet.runtime}. Inspect this instance.`
    return undefined
  } catch (error) {
    return `Firstmate preparation returned invalid evidence: ${error instanceof Error ? error.message : String(error)}`
  }
}
