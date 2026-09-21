import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { Data, Effect } from "effect"

import { cacheArtifact } from "./artifact-cache.ts"
import type { ArtifactLock } from "./lock.ts"
import { resolveNpmArtifact } from "./npm-artifact.ts"
import type { Platform } from "./platform.ts"

const execFilePromise = promisify(execFile)

export class PlaywrightReleaseError extends Data.TaggedError("PlaywrightReleaseError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

interface BrowserEntry {
  readonly name?: unknown
  readonly revision?: unknown
  readonly browserVersion?: unknown
  readonly title?: unknown
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

const browserEntry = (browsers: ReadonlyArray<BrowserEntry>, name: string): BrowserEntry => {
  const entry = browsers.find((candidate) => candidate.name === name)
  if (entry === undefined || typeof entry.revision !== "string" || !/^\d+$/.test(entry.revision)) {
    throw new Error(`Playwright browser revision is missing: ${name}`)
  }
  return entry
}

const usesChromeForTestingUrls = (version: string): boolean => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version)
  if (match === null) return false
  const [, major, minor] = match
  return Number(major) > 1 || (Number(major) === 1 && Number(minor) >= 59)
}

const browserDownload = (
  entry: BrowserEntry,
  name: "chromium" | "chromium-headless-shell",
  useChromeForTestingUrls: boolean,
) => {
  if (typeof entry.revision !== "string" || !/^\d+$/.test(entry.revision)) {
    throw new Error(`Playwright browser revision is missing: ${name}`)
  }
  if (useChromeForTestingUrls) {
    if (typeof entry.browserVersion !== "string" || !/^\d+\.\d+\.\d+\.\d+$/.test(entry.browserVersion)) {
      throw new Error(`Playwright browser version is missing: ${name}`)
    }
    const archiveName = name === "chromium" ? "chrome-linux-arm64.zip" : "chrome-headless-shell-linux-arm64.zip"
    return {
      revision: entry.revision,
      url: `https://cdn.playwright.dev/builds/cft/${entry.browserVersion}/linux-arm64/${archiveName}`,
    }
  }
  const archiveName = name === "chromium" ? "chromium-linux-arm64.zip" : "chromium-headless-shell-linux-arm64.zip"
  return {
    revision: entry.revision,
    url: `https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${entry.revision}/${archiveName}`,
  }
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
    const chromium = yield* Effect.try({
      try: () => browserDownload(browserEntry(browsers, "chromium"), "chromium", usesChromeForTestingUrls(coreVersion)),
      catch: (cause) => new PlaywrightReleaseError({ message: "Chromium revision is invalid", cause }),
    })
    const headless = yield* Effect.try({
      try: () =>
        browserDownload(
          browsers.find((candidate) => candidate.name === "chromium-headless-shell") ??
            browserEntry(browsers, "chromium"),
          "chromium-headless-shell",
          usesChromeForTestingUrls(coreVersion),
        ),
      catch: (cause) => new PlaywrightReleaseError({ message: "Chromium headless shell revision is invalid", cause }),
    })
    const browserRequests = [
      {
        name: "chromium",
        url: chromium.url,
        revision: chromium.revision,
      },
      {
        name: "chromium-headless-shell",
        url: headless.url,
        revision: headless.revision,
      },
    ] as const
    const browserArtifacts = yield* Effect.forEach(
      browserRequests,
      (browser) =>
        cacheArtifact({ cacheHome: request.cacheHome, url: browser.url }).pipe(
          Effect.map((cached) => ({
            name: browser.name,
            version: browser.revision,
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
