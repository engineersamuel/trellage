import {
  canonicalFirstmateInstanceJson,
  firstmateInstanceCli,
  firstmateRuntimeVariantDigest,
  firstmateWorktreeBindingDigest,
  parseFirstmateFleetIdentityV1,
  parseFirstmateInstanceControlContextV1,
  parseFirstmateInstanceReferenceV1,
  parseFirstmateOrchestrationV1,
  sameFirstmateInstance,
  validateFirstmateInstanceControlContextV1,
  validateFirstmateInstanceFleet,
  type FirstmateFleetIdentityV1,
  type FirstmateInstanceControlContextV1,
  type FirstmateInstanceDescriptorV1,
  type FirstmateInstanceReferenceV1,
  type FirstmateWorktreeEvidenceV1,
} from "@trellage/guide-core"
import type { NativeSelectedProfile } from "./guide-launch.ts"

const instanceReference = (profile: NativeSelectedProfile): FirstmateInstanceReferenceV1 | undefined => {
  if (profile.firstmateInstance === undefined) {
    if (profile.firstmateInstanceContext !== undefined) {
      throw new Error("Firstmate instance context requires an explicit instance reference.")
    }
    return undefined
  }
  if (profile.surface !== "native" || profile.launcher !== "fmx" || profile.orchestration === undefined) {
    throw new Error("Firstmate instance selection requires a supported Native fmx profile.")
  }
  const capability = parseFirstmateOrchestrationV1(profile.orchestration)
  const reference = parseFirstmateInstanceReferenceV1(profile.firstmateInstance)
  if (reference.profile !== profile.profile) {
    throw new Error("Firstmate instance selection does not match the selected profile.")
  }
  if (reference.mode === "named" && capability.instances === undefined) {
    throw new Error("This Firstmate backend does not support named fleet instances. Update the Native components.")
  }
  return reference
}

export const firstmateInstanceSelectorArgs = (profile: NativeSelectedProfile): ReadonlyArray<string> => {
  const reference = instanceReference(profile)
  if (reference === undefined || profile.orchestration?.instances === undefined) return []
  return [firstmateInstanceCli.selector, reference.mode === "legacy" ? "legacy" : reference.instanceId]
}

export const firstmateInstanceControlArgs = (profile: NativeSelectedProfile): ReadonlyArray<string> => {
  const selector = firstmateInstanceSelectorArgs(profile)
  const reference = instanceReference(profile)
  if (reference === undefined) return selector
  if (profile.firstmateInstanceContext === undefined) {
    if (reference.mode === "named") {
      throw new Error("Named Firstmate control requires a confirmed instance context. Refresh and confirm the instance.")
    }
    return selector
  }
  const context = parseFirstmateInstanceControlContextV1(profile.firstmateInstanceContext)
  if (!sameFirstmateInstance(reference, context.reference)) {
    throw new Error("Firstmate control context belongs to another instance.")
  }
  if (profile.orchestration?.instances === undefined) return selector
  return [...selector, firstmateInstanceCli.context, canonicalFirstmateInstanceJson(context)]
}

export const createFirstmateInstanceContext = (
  descriptor: FirstmateInstanceDescriptorV1,
  entryWorktree: FirstmateWorktreeEvidenceV1 | null,
  selection: FirstmateInstanceControlContextV1["selection"],
): FirstmateInstanceControlContextV1 => {
  if (descriptor.reference === null) {
    throw new Error("This Firstmate fleet has no verified setup identity. Inspect it before selecting an instance.")
  }
  const context = parseFirstmateInstanceControlContextV1({
    schemaVersion: 1,
    reference: descriptor.reference,
    expectedBindingDigest: descriptor.mode === "named" ? firstmateWorktreeBindingDigest(descriptor.worktree.evidence) : null,
    expectedRuntimeDigest: descriptor.mode === "named" ? firstmateRuntimeVariantDigest(descriptor.runtime.required) : null,
    entryWorktree,
    selection,
  })
  validateFirstmateInstanceControlContextV1(context, descriptor)
  return context
}

export const selectedFirstmateInstance = (
  profile: NativeSelectedProfile,
  expectedFleet: FirstmateFleetIdentityV1,
): FirstmateInstanceReferenceV1 => {
  if (profile.launcher !== "fmx") throw new Error("Only Firstmate profiles can select a fleet instance.")
  const fleet = parseFirstmateFleetIdentityV1(expectedFleet)
  const reference = instanceReference(profile) ?? parseFirstmateInstanceReferenceV1({
    schemaVersion: 1,
    profile: profile.profile,
    mode: "legacy",
    instanceId: fleet.instanceId,
  })
  validateFirstmateInstanceFleet(reference, fleet)
  return reference
}
