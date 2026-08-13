import { Effect } from "effect"

import { loadLock, loadProfile } from "./application.js"
import { lockIsReady } from "./lock.js"
import { productionPlatforms } from "./platform.js"
import type { ProfileChoice } from "./profile-discovery.js"

/**
 * Reports whether a profile has a current, production-ready lock — i.e. an
 * image build that `trellage build --locked` can reuse without re-resolving
 * sources. This only reads the profile document and its adjacent lock file
 * (no Docker daemon access), so it stays cheap enough to run for every
 * profile during `trellage list --json-full`.
 */
export const resolveProfileLocked = (choice: ProfileChoice): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    const platform = productionPlatforms.find((candidate) => choice.supported_platforms.includes(candidate))
    if (platform === undefined) return false
    const document = yield* loadProfile(choice.value)
    const lock = yield* loadLock(choice.value, platform)
    return lockIsReady(document, lock, platform)
  }).pipe(
    // A profile that can't be read/locked here (e.g. discovered from a
    // source that vanished between listing and this check) is simply not
    // locked; readiness is a best-effort signal and must not fail `list`.
    Effect.orElseSucceed(() => false),
  )

export const resolveProfilesLocked = (
  choices: ReadonlyArray<ProfileChoice>,
): Effect.Effect<ReadonlyArray<boolean>, never> => Effect.forEach(choices, resolveProfileLocked)
