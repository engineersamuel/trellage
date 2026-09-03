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
 * "Latest" is resolved for every harness kind that has a known GitHub
 * Releases lookup already used by `trellage lock` itself to resolve a
 * floating `version = "latest"` selector: `claude`
 * (`resolveClaudeRelease`/`claude-release.ts`, `anthropics/claude-code`)
 * and `codex` (`resolveCodexRelease`/`codex-release.ts`,
 * `openai/codex`, `rust-vX.Y.Z` tags). Every other sandbox harness kind
 * reports `latestKnown: false` with a `null` `latest` — exactly like
 * `cpx`/`grx`/`cldx` today, since no npm-registry or GitHub-release lookup
 * exists anywhere in this codebase for those harness CLIs. A lookup
 * failure (network, rate limit, malformed response) for a supported kind
 * also reports `latestKnown: false` rather than fabricating a value;
 * `installed` is unaffected either way.
 *
 * A successfully-resolved "latest" version is cached on disk per harness
 * kind for 24 hours (`harness-latest-version-cache.ts`), so once any
 * profile of a given harness kind (e.g. one of several Claude profiles)
 * has resolved "latest", every other profile sharing that harness kind
 * reuses the cached value for the remainder of the TTL instead of
 * repeating an identical GitHub Releases lookup. A lookup failure is
 * never cached, so the next check retries rather than being stuck.
 */
import { Effect } from "effect"

import { ApplicationError, loadProfile, loadReleaseLock } from "./application.js"
import { GitHubClaudeReleaseClient, resolveClaudeRelease, type ClaudeReleaseClient } from "./claude-release.js"
import { GitHubCodexReleaseClient, resolveCodexRelease, type CodexReleaseClient } from "./codex-release.js"
import {
  cachedLatestVersion,
  harnessLatestVersionCachePath,
  loadHarnessLatestVersionCache,
  recordLatestVersion,
} from "./harness-latest-version-cache.js"
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

export interface HarnessVersionReleaseClients {
  readonly claude?: ClaudeReleaseClient
  readonly codex?: CodexReleaseClient
}

const resolveInstalledVersion = (
  document: ProfileDocument,
  current: ProfileLock | undefined,
  platform: Platform,
): string | undefined =>
  lockIsReady(document, current, platform) && current?.packages.harness.kind === document.profile.harness.kind
    ? harnessPackageRevision(current.packages.harness)
    : undefined

/** Resolves the latest version for a harness kind with a known GitHub Releases lookup, or `undefined` when the kind has none or the lookup fails. Never throws: every failure path is absorbed into `undefined`. */
const fetchLatestVersion = (
  harnessKind: string,
  platform: Platform,
  clients: Required<HarnessVersionReleaseClients>,
): Effect.Effect<string | undefined> => {
  if (harnessKind === "claude") {
    return resolveClaudeRelease("latest", platform, clients.claude).pipe(
      Effect.map((lock): string | undefined => harnessPackageRevision(lock)),
      Effect.orElseSucceed((): string | undefined => undefined),
    )
  }
  if (harnessKind === "codex") {
    return resolveCodexRelease("latest", platform, clients.codex).pipe(
      Effect.map((lock): string | undefined => harnessPackageRevision(lock.harness)),
      Effect.orElseSucceed((): string | undefined => undefined),
    )
  }
  return Effect.succeed(undefined)
}

/**
 * Resolves the latest version for a harness kind, checking the shared
 * on-disk `harness-latest-version-cache.json` first so that once any
 * profile of a given harness kind (e.g. one of several Claude profiles)
 * has resolved "latest" within the last 24 hours, every other profile of
 * that same harness kind reuses the cached value instead of repeating an
 * identical GitHub Releases lookup. Only a successful lookup is cached;
 * a lookup failure is never persisted, so the next check retries rather
 * than being stuck on a stale failure.
 */
const resolveLatestVersion = (
  harnessKind: string,
  platform: Platform,
  clients: Required<HarnessVersionReleaseClients>,
  xdgCacheHome: string,
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const cachePath = harnessLatestVersionCachePath(xdgCacheHome)
    const record = yield* Effect.promise(() => loadHarnessLatestVersionCache(cachePath))
    const now = Date.now()
    const cached = cachedLatestVersion(record, harnessKind, platform, now)
    if (cached !== undefined) return cached
    const resolved = yield* fetchLatestVersion(harnessKind, platform, clients)
    if (resolved !== undefined) {
      yield* Effect.promise(() => recordLatestVersion(xdgCacheHome, harnessKind, platform, resolved, now))
    }
    return resolved
  })

export const harnessVersionReport = (
  profilePath: string,
  platform: Platform,
  xdgCacheHome: string,
  releaseClients: HarnessVersionReleaseClients = {},
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
    const latest = yield* resolveLatestVersion(
      harnessKind,
      platform,
      {
        claude: releaseClients.claude ?? GitHubClaudeReleaseClient,
        codex: releaseClients.codex ?? GitHubCodexReleaseClient,
      },
      xdgCacheHome,
    )
    return {
      schemaVersion: 1 as const,
      harness: harnessKind,
      installed,
      latest: latest ?? null,
      latestKnown: latest !== undefined,
    }
  })
