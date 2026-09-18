import {
  firstmateInstanceKey,
  parseFirstmateInstanceReferenceV1,
  type FirstmateFleetIdentityV1,
} from "@trellage/guide-core"
import type { QueuedGuideJob } from "./guide-batch.ts"
import type { NativeSelectedProfile } from "./guide-launch.ts"

export const firstmateProfileInstanceKey = (
  profile: NativeSelectedProfile, expectedFleet?: FirstmateFleetIdentityV1,
): string | undefined => {
  const reference = profile.firstmateInstance ?? (expectedFleet === undefined ? undefined : {
    schemaVersion: 1, profile: expectedFleet.profile, mode: "legacy", instanceId: expectedFleet.instanceId,
  })
  if (reference === undefined) return undefined
  // Admission checks run after grouping, so conflicting controls cannot split one UUID into two executions.
  return firstmateInstanceKey(parseFirstmateInstanceReferenceV1(reference))
}

export const firstmateJobInstanceKey = (job: QueuedGuideJob): string | undefined =>
  job.profile.surface === "native" && job.profile.launcher === "fmx"
    ? firstmateProfileInstanceKey(job.profile, job.firstmate?.expectedFleet)
    : undefined

export const sameFirstmateJobInstance = (left: QueuedGuideJob, right: QueuedGuideJob): boolean => {
  const key = firstmateJobInstanceKey(left)
  return key !== undefined && key === firstmateJobInstanceKey(right)
}

export const firstmateInstanceLabel = (profile: NativeSelectedProfile): string =>
  `${profile.launcher}/${profile.profile}; ${profile.firstmateInstance === undefined
    ? "legacy shared fleet" : `${profile.firstmateInstance.mode} instance ${profile.firstmateInstance.instanceId}`}`
