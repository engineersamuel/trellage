import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { Data, Effect } from "effect"

import { cacheArtifact } from "./artifact-cache.js"
import type { ArtifactLock } from "./lock.js"
import { resolveNpmArtifact } from "./npm-artifact.js"
import type { Platform } from "./platform.js"

const execFilePromise = promisify(execFile)

export class PlaywrightReleaseError extends Data.TaggedError("PlaywrightReleaseError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

interface BrowserEntry {
  readonly name?: unknown
  readonly revision?: unknown
}

const exactDependency = (dependencies: Readonly<Record<string, string>>, name: string): string => {
  const version = dependencies[name]
  if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Playwright dependency is not exact: ${name}`)
  }
  return version
}

const readBrowsers = (archive: string): Effect.Effect<ReadonlyArray<BrowserEntry>, PlaywrightReleaseError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const { stdout } = await execFilePromise("tar", ["-xOf", archive, "package/browsers.json"], {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        signal,
      })
      const parsed = JSON.parse(stdout) as { readonly browsers?: unknown }
      if (!Array.isArray(parsed.browsers)) throw new Error("browsers array is missing")
      return parsed.browsers as ReadonlyArray<BrowserEntry>
    },
    catch: (cause) => new PlaywrightReleaseError({ message: "Playwright browser metadata is invalid", cause }),
  })

const browserRevision = (browsers: ReadonlyArray<BrowserEntry>, name: string): string => {
  const entry = browsers.find((candidate) => candidate.name === name)
  if (typeof entry?.revision !== "string" || !/^\d+$/.test(entry.revision)) {
    throw new Error(`Playwright browser revision is missing: ${name}`)
  }
  return entry.revision
}

export const resolvePlaywrightRelease = (request: {
  readonly cacheHome: string
  readonly registry: string
  readonly platform: Platform
}): Effect.Effect<ReadonlyArray<ArtifactLock>, PlaywrightReleaseError> =>
  Effect.gen(function* () {
    if (request.platform !== "linux/arm64") {
      return yield* Effect.fail(
        new PlaywrightReleaseError({ message: `Playwright artifacts are unavailable for ${request.platform}` }),
      )
    }
    const mcp = yield* resolveNpmArtifact({
      cacheHome: request.cacheHome,
      registry: request.registry,
      name: "@playwright/mcp",
      selector: "latest",
      artifactName: "playwright-mcp",
      requireStable: true,
    }).pipe(Effect.mapError((cause) => new PlaywrightReleaseError({ message: cause.message, cause })))
    const playwrightVersion = yield* Effect.try({
      try: () => exactDependency(mcp.dependencies, "playwright"),
      catch: (cause) => new PlaywrightReleaseError({ message: "Playwright MCP dependency is invalid", cause }),
    })
    const playwright = yield* resolveNpmArtifact({
      cacheHome: request.cacheHome,
      registry: request.registry,
      name: "playwright",
      selector: playwrightVersion,
      artifactName: "playwright",
      requireStable: false,
    }).pipe(Effect.mapError((cause) => new PlaywrightReleaseError({ message: cause.message, cause })))
    const coreVersion = yield* Effect.try({
      try: () => exactDependency(playwright.dependencies, "playwright-core"),
      catch: (cause) => new PlaywrightReleaseError({ message: "Playwright core dependency is invalid", cause }),
    })
    const core = yield* resolveNpmArtifact({
      cacheHome: request.cacheHome,
      registry: request.registry,
      name: "playwright-core",
      selector: coreVersion,
      artifactName: "playwright-core",
      requireStable: false,
    }).pipe(Effect.mapError((cause) => new PlaywrightReleaseError({ message: cause.message, cause })))
    const browsers = yield* readBrowsers(core.cached.path)
    const revision = yield* Effect.try({
      try: () => browserRevision(browsers, "chromium"),
      catch: (cause) => new PlaywrightReleaseError({ message: "Chromium revision is invalid", cause }),
    })
    const browserRequests = [
      {
        name: "chromium",
        url: `https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${revision}/chromium-linux-arm64.zip`,
      },
      {
        name: "chromium-headless-shell",
        url: `https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${revision}/chromium-headless-shell-linux-arm64.zip`,
      },
    ] as const
    const browserArtifacts = yield* Effect.forEach(
      browserRequests,
      (browser) =>
        cacheArtifact({ cacheHome: request.cacheHome, url: browser.url }).pipe(
          Effect.map((cached) => ({
            name: browser.name,
            version: revision,
            integrity: cached.integrity,
            url: browser.url,
            size: cached.size,
          })),
          Effect.mapError((cause) => new PlaywrightReleaseError({ message: `cannot cache ${browser.name}`, cause })),
        ),
      { concurrency: 2 },
    )
    return [mcp.artifact, playwright.artifact, core.artifact, ...browserArtifacts]
  })
