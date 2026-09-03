/**
 * Read-only `harness-version` report for one sandbox profile, emitting the
 * same JSON envelope (`{schemaVersion, harness, installed, latest,
 * latestKnown, latestDiagnostic?}`) every native launcher's
 * `LAUNCHER harness-version`
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
 * a ready development resolution receipt from a prior `trellage
 * build`/`trellage lock`, mirroring `profileMetadata`'s own
 * `resolved_version` derivation. A checked-in release lock describes what
 * can be built, not what is installed. Never fabricated: when no receipt
 * is ready, `installed` is `null`, exactly like a native
 * launcher's `installed: null` for a harness it could not determine.
 *
 * "Latest" is resolved for every harness kind that has a known GitHub
 * source already used by Trellage itself: Claude, Codex, Copilot, Oh My
 * Pi, Prime, and Headlong's Git ref. Unsupported kinds report
 * `latestKnown: false` without a diagnostic. A failed supported lookup
 * reports `latestKnown: false` with `latestDiagnostic`, so callers can
 * distinguish an intentional unknown from a retryable failure while
 * preserving `installed`.
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

import { ApplicationError, loadProfile } from "./application.js"
import { GitHubClaudeReleaseClient, resolveClaudeRelease, type ClaudeReleaseClient } from "./claude-release.js"
import { GitHubCodexReleaseClient, resolveCodexRelease, type CodexReleaseClient } from "./codex-release.js"
import { GitHubCopilotReleaseClient, resolveCopilotRelease, type CopilotReleaseClient } from "./copilot-release.js"
import { NodeGitClient, type GitClient } from "./github-cache.js"
import {
  cachedLatestVersion,
  harnessLatestVersionCachePath,
  loadHarnessLatestVersionCache,
  recordLatestVersion,
} from "./harness-latest-version-cache.js"
import { harnessPackageRevision, lockIsReady, type ProfileLock } from "./lock.js"
import { GitHubPiReleaseClient, resolvePiRelease, type PiReleaseClient } from "./pi-release.js"
import type { Platform } from "./platform.js"
import { PrimeReleaseHttpClient, resolvePrimeRelease, type PrimeReleaseClient } from "./prime-release.js"
import type { ProfileDocument } from "./profile.js"
import { loadResolutionReceipt } from "./resolution-receipt.js"

export interface HarnessVersionReport {
  readonly schemaVersion: 1
  readonly harness: string
  readonly installed: string | null
  readonly latest: string | null
  readonly latestKnown: boolean
  readonly latestDiagnostic?: string
}

export interface HarnessVersionReleaseClients {
  readonly claude?: ClaudeReleaseClient
  readonly codex?: CodexReleaseClient
  readonly copilot?: CopilotReleaseClient
  readonly pi?: PiReleaseClient
  readonly prime?: PrimeReleaseClient
  readonly git?: GitClient
}

export interface HarnessVersionReportOptions {
  readonly refreshLatest?: boolean
}

const resolveInstalledVersion = (
  document: ProfileDocument,
  current: ProfileLock | undefined,
  platform: Platform,
): string | undefined =>
  lockIsReady(document, current, platform) && current?.packages.harness.kind === document.profile.harness.kind
    ? harnessPackageRevision(current.packages.harness)
    : undefined

type LatestVersionResolution =
  | { readonly kind: "known"; readonly version: string }
  | { readonly kind: "unsupported" }
  | { readonly kind: "failed"; readonly diagnostic: string }

const latestVersionFailure = (harnessKind: string, cause: unknown): LatestVersionResolution => {
  const detail = cause instanceof Error ? cause.message : "lookup failed"
  const normalized = detail.replace(/\s+/g, " ").trim().slice(0, 400)
  return {
    kind: "failed",
    diagnostic: `${harnessKind} latest-version lookup failed${normalized.length > 0 ? `: ${normalized}` : ""}`,
  }
}

const resolveKnownVersion = <A>(
  harnessKind: string,
  effect: Effect.Effect<A, unknown>,
  revision: (value: A) => string,
): Effect.Effect<LatestVersionResolution> =>
  effect.pipe(
    Effect.map((value): LatestVersionResolution => ({ kind: "known", version: revision(value) })),
    Effect.catchAll((cause) => Effect.succeed(latestVersionFailure(harnessKind, cause))),
  )

const latestVersionHarnessKinds = new Set(["claude", "codex", "copilot", "headlong", "pi", "prime"])

/** Resolves one authoritative latest source and preserves unsupported versus failed states. */
const fetchLatestVersion = (
  harnessKind: string,
  platform: Platform,
  clients: Required<HarnessVersionReleaseClients>,
): Effect.Effect<LatestVersionResolution> => {
  if (harnessKind === "claude") {
    return resolveKnownVersion(harnessKind, resolveClaudeRelease("latest", platform, clients.claude), (lock) =>
      harnessPackageRevision(lock),
    )
  }
  if (harnessKind === "codex") {
    return resolveKnownVersion(harnessKind, resolveCodexRelease("latest", platform, clients.codex), (lock) =>
      harnessPackageRevision(lock.harness),
    )
  }
  if (harnessKind === "copilot") {
    return resolveKnownVersion(harnessKind, resolveCopilotRelease("latest", platform, clients.copilot), (lock) =>
      harnessPackageRevision(lock),
    )
  }
  if (harnessKind === "pi") {
    return resolveKnownVersion(harnessKind, resolvePiRelease("latest", platform, clients.pi), (lock) =>
      harnessPackageRevision(lock),
    )
  }
  if (harnessKind === "prime") {
    return resolveKnownVersion(harnessKind, resolvePrimeRelease("latest", platform, clients.prime), (lock) =>
      harnessPackageRevision(lock),
    )
  }
  if (harnessKind === "headlong") {
    return resolveKnownVersion(
      harnessKind,
      clients.git
        .resolveRef("https://github.com/laude-institute/headlong.git", "refs/heads/main")
        .pipe(
          Effect.flatMap((commit) =>
            /^[0-9a-f]{40}$/.test(commit) ? Effect.succeed(commit) : Effect.fail(new Error("ref did not resolve")),
          ),
        ),
      (commit) => commit,
    )
  }
  return Effect.succeed({ kind: "unsupported" })
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
  refreshLatest: boolean,
): Effect.Effect<LatestVersionResolution> =>
  Effect.gen(function* () {
    if (!latestVersionHarnessKinds.has(harnessKind)) return { kind: "unsupported" as const }
    const cachePath = harnessLatestVersionCachePath(xdgCacheHome)
    const now = Date.now()
    if (!refreshLatest) {
      const record = yield* Effect.promise(() => loadHarnessLatestVersionCache(cachePath))
      const cached = cachedLatestVersion(record, harnessKind, platform, now)
      if (cached !== undefined) return { kind: "known" as const, version: cached }
    }
    const resolved = yield* fetchLatestVersion(harnessKind, platform, clients)
    if (resolved.kind === "known") {
      yield* Effect.promise(() => recordLatestVersion(xdgCacheHome, harnessKind, platform, resolved.version, now))
    }
    return resolved
  })

export const harnessVersionReport = (
  profilePath: string,
  platform: Platform,
  xdgCacheHome: string,
  releaseClients: HarnessVersionReleaseClients = {},
  options: HarnessVersionReportOptions = {},
): Effect.Effect<HarnessVersionReport, ApplicationError> =>
  Effect.gen(function* () {
    const document = yield* loadProfile(profilePath)
    const receipt = yield* loadResolutionReceipt(document, platform, xdgCacheHome).pipe(
      Effect.mapError((cause) => new ApplicationError({ message: cause.message, cause })),
    )
    const installed = resolveInstalledVersion(document, receipt, platform) ?? null
    const harnessKind = document.profile.harness.kind
    const latestResolution = yield* resolveLatestVersion(
      harnessKind,
      platform,
      {
        claude: releaseClients.claude ?? GitHubClaudeReleaseClient,
        codex: releaseClients.codex ?? GitHubCodexReleaseClient,
        copilot: releaseClients.copilot ?? GitHubCopilotReleaseClient,
        pi: releaseClients.pi ?? GitHubPiReleaseClient,
        prime: releaseClients.prime ?? PrimeReleaseHttpClient,
        git: releaseClients.git ?? NodeGitClient,
      },
      xdgCacheHome,
      options.refreshLatest ?? false,
    )
    return {
      schemaVersion: 1 as const,
      harness: harnessKind,
      installed,
      latest: latestResolution.kind === "known" ? latestResolution.version : null,
      latestKnown: latestResolution.kind === "known",
      ...(latestResolution.kind === "failed" ? { latestDiagnostic: latestResolution.diagnostic } : {}),
    }
  })
