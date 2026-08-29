import os from "node:os"
import path from "node:path"

import { Effect } from "effect"

import { adjacentLockPath, loadProfile, loadReleaseLock } from "./application.js"
import { harnessPackageRevision, lockIsReady } from "./lock.js"
import { productionPlatforms } from "./platform.js"
import type { ProfileChoice } from "./profile-discovery.js"
import { loadResolutionReceipt } from "./resolution-receipt.js"
import { loadResolutionSidecar } from "./resolution-sidecar-storage.js"

export interface ProfileReadiness {
  readonly resolutionPolicy: "floating"
  readonly locallyResolved: boolean
  readonly releaseLockAvailable: boolean
  /** Compatibility alias for locallyResolved. */
  readonly locked: boolean
  readonly resolvedVersion: string | null
}

const unavailable = (): ProfileReadiness => ({
  resolutionPolicy: "floating",
  locallyResolved: false,
  releaseLockAvailable: false,
  locked: false,
  resolvedVersion: null,
})

export const resolveProfileReadiness = (
  choice: ProfileChoice,
  xdgCacheHome: string = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
): Effect.Effect<ProfileReadiness, never> =>
  Effect.gen(function* () {
    const platform = productionPlatforms.find((candidate) => choice.supported_platforms.includes(candidate))
    if (platform === undefined) return unavailable()
    const document = yield* loadProfile(choice.value)
    const [receipt, release] = yield* Effect.all(
      [loadResolutionReceipt(document, platform, xdgCacheHome), loadReleaseLock(choice.value, platform)],
      { concurrency: 2 },
    )
    const locallyResolved = lockIsReady(document, receipt, platform)
    const releaseSidecarReady =
      release?.sidecar === undefined
        ? true
        : yield* loadResolutionSidecar(adjacentLockPath(choice.value, platform), release).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          )
    const releaseLockAvailable = lockIsReady(document, release, platform) && releaseSidecarReady
    return {
      resolutionPolicy: document.profile.resolution,
      locallyResolved,
      releaseLockAvailable,
      locked: locallyResolved,
      resolvedVersion:
        locallyResolved && receipt?.packages.harness.kind === document.profile.harness.kind
          ? harnessPackageRevision(receipt.packages.harness)
          : null,
    }
  }).pipe(Effect.orElseSucceed(unavailable))

export const resolveProfileLocked = (choice: ProfileChoice, xdgCacheHome?: string): Effect.Effect<boolean, never> =>
  resolveProfileReadiness(choice, xdgCacheHome).pipe(Effect.map(({ locked }) => locked))

export const resolveProfilesLocked = (
  choices: ReadonlyArray<ProfileChoice>,
  xdgCacheHome?: string,
): Effect.Effect<ReadonlyArray<boolean>, never> =>
  Effect.forEach(choices, (choice) => resolveProfileLocked(choice, xdgCacheHome))

export const resolveProfilesReadiness = (
  choices: ReadonlyArray<ProfileChoice>,
  xdgCacheHome?: string,
): Effect.Effect<ReadonlyArray<ProfileReadiness>, never> =>
  Effect.forEach(choices, (choice) => resolveProfileReadiness(choice, xdgCacheHome))
