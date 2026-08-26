import { Effect } from "effect"

import { loadLock, loadProfile } from "./application.js"
import { harnessPackageRevision, lockIsReady } from "./lock.js"
import { productionPlatforms } from "./platform.js"
import type { ProfileChoice } from "./profile-discovery.js"

export interface ProfileReadiness {
  readonly locked: boolean
  readonly resolvedVersion: string | null
}

/**
 * Reports whether a profile has a current, production-ready lock — i.e. an
 * image build that `trellage build --locked` can reuse without re-resolving
 * sources. This only reads the profile document and its adjacent lock file
 * (no Docker daemon access), so it stays cheap enough to run for every
 * profile during `trellage list --json-full`.
 */
export const resolveProfileReadiness = (choice: ProfileChoice): Effect.Effect<ProfileReadiness, never> =>
  Effect.gen(function* () {
    const platform = productionPlatforms.find((candidate) => choice.supported_platforms.includes(candidate))
    if (platform === undefined) return { locked: false, resolvedVersion: null }
    const document = yield* loadProfile(choice.value)
    const lock = yield* loadLock(choice.value, platform)
    const locked = lockIsReady(document, lock, platform)
    return {
      locked,
      resolvedVersion:
        locked && lock?.packages.harness.kind === document.profile.harness.kind
          ? harnessPackageRevision(lock.packages.harness)
          : null,
    }
  }).pipe(
    // A profile that can't be read/locked here (e.g. discovered from a
    // source that vanished between listing and this check) is simply not
    // locked; readiness is a best-effort signal and must not fail `list`.
    Effect.orElseSucceed(() => ({ locked: false, resolvedVersion: null })),
  )

export const resolveProfileLocked = (choice: ProfileChoice): Effect.Effect<boolean, never> =>
  resolveProfileReadiness(choice).pipe(Effect.map(({ locked }) => locked))

export const resolveProfilesLocked = (
  choices: ReadonlyArray<ProfileChoice>,
): Effect.Effect<ReadonlyArray<boolean>, never> => Effect.forEach(choices, resolveProfileLocked)

export const resolveProfilesReadiness = (
  choices: ReadonlyArray<ProfileChoice>,
): Effect.Effect<ReadonlyArray<ProfileReadiness>, never> => Effect.forEach(choices, resolveProfileReadiness)
