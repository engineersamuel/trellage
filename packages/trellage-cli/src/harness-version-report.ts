/**
 * Read-only `harness-version` report for one sandbox profile, emitting the
 * same JSON envelope (`{schemaVersion, harness, installed, latest,
 * latestKnown}`) every native launcher's `LAUNCHER harness-version`
 * subcommand emits, so the Admin UI's existing
 * `packages/trellage-launcher/src/admin-harness-version.ts`
 * `parseHarnessVersionOutput`/`harnessVersionColumnsFor`/scheduler/cache
 * machinery can be reused unchanged for sandbox profiles rather than
 * building a parallel version-check pipeline.
 *
 * Unlike a native launcher (one host-installed binary shared by every
 * profile using it), a sandbox profile's harness is baked into that
 * specific profile's locked/built image and can genuinely differ per
 * profile (e.g. two Claude profiles pinned to different releases via
 * `[harness].version`). "Installed" is therefore resolved per-profile from
 * whichever locally-known lock is ready — the development resolution
 * receipt from a prior `trellage build`/`trellage lock` (preferred, as the
 * most recently resolved state; see `resolution-receipt.ts`) or the
 * checked-in release lock adjacent to `profile.toml` (`loadReleaseLock`) —
 * mirroring `profileMetadata`'s own `resolved_version` derivation
 * (`application.ts`'s `metadataResolvedVersion`). Never fabricated: when
 * neither lock is ready, `installed` is `null`, exactly like a native
 * launcher's `installed: null` for a harness it could not determine.
 *
 * "Latest" is only ever resolved for the `claude` harness kind, via the
 * same `resolveClaudeRelease("latest", ...)` GitHub Releases lookup
 * `trellage lock` itself uses to resolve a floating `version = "latest"`
 * selector (`claude-release.ts`). Every other sandbox harness kind reports
 * `latestKnown: false` with a `null` `latest` — exactly like
 * `cpx`/`cdx`/`grx`/`cldx` today, since no npm-registry or GitHub-release
 * lookup exists anywhere in this codebase for those harness CLIs either.
 */
import { Effect } from "effect"

import { ApplicationError, loadProfile, loadReleaseLock } from "./application.js"
import { GitHubClaudeReleaseClient, resolveClaudeRelease, type ClaudeReleaseClient } from "./claude-release.js"
import { harnessPackageRevision, lockIsReady, type ProfileLock } from "./lock.js"
import type { Platform } from "./platform.js"
import type { ProfileDocument } from "./profile.js"
import { loadResolutionReceipt } from "./resolution-receipt.js"

export interface HarnessVersionReport {
  readonly schemaVersion: 1
  readonly harness: string
  readonly installed: string | null
  readonly latest: string | null
  readonly latestKnown: boolean
}

const resolveInstalledVersion = (
  document: ProfileDocument,
  current: ProfileLock | undefined,
  platform: Platform,
): string | undefined =>
  lockIsReady(document, current, platform) && current?.packages.harness.kind === document.profile.harness.kind
    ? harnessPackageRevision(current.packages.harness)
    : undefined

export const harnessVersionReport = (
  profilePath: string,
  platform: Platform,
  xdgCacheHome: string,
  claudeReleaseClient: ClaudeReleaseClient = GitHubClaudeReleaseClient,
): Effect.Effect<HarnessVersionReport, ApplicationError> =>
  Effect.gen(function* () {
    const document = yield* loadProfile(profilePath)
    const release = yield* loadReleaseLock(profilePath, platform)
    const receipt = yield* loadResolutionReceipt(document, platform, xdgCacheHome).pipe(
      Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
    )
    const current = receipt ?? release
    const installed = resolveInstalledVersion(document, current, platform) ?? null
    const harnessKind = document.profile.harness.kind
    if (harnessKind !== "claude") {
      return { schemaVersion: 1 as const, harness: harnessKind, installed, latest: null, latestKnown: false }
    }
    const latest = yield* resolveClaudeRelease("latest", platform, claudeReleaseClient).pipe(
      Effect.map((lock): string | undefined => harnessPackageRevision(lock)),
      Effect.orElseSucceed((): string | undefined => undefined),
    )
    return {
      schemaVersion: 1 as const,
      harness: harnessKind,
      installed,
      latest: latest ?? null,
      latestKnown: latest !== undefined,
    }
  })
