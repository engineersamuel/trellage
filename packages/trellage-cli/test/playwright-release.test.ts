import { execFile } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"

const execFilePromise = promisify(execFile)
const mocks = vi.hoisted(() => ({
  coreArchive: "",
  playwrightDependency: "1.2.3",
  coreVersion: "1.2.3",
  browserUrls: [] as Array<string>,
}))

vi.mock("../src/npm-artifact.ts", async () => {
  const { Effect } = await import("effect")
  return {
    resolveNpmArtifact: (request: { readonly name: string; readonly artifactName: string }) => {
      const dependencies =
        request.name === "@playwright/mcp"
          ? { playwright: mocks.playwrightDependency }
          : request.name === "playwright"
            ? { "playwright-core": mocks.coreVersion }
            : {}
      return Effect.succeed({
        artifact: {
          name: request.artifactName,
          version: request.name === "playwright-core" ? mocks.coreVersion : "1.2.3",
          integrity: `sha256:${"a".repeat(64)}`,
          url: `https://registry.test/${request.artifactName}.tgz`,
          size: 1,
        },
        cached: {
          integrity: `sha256:${"a".repeat(64)}`,
          size: 1,
          path: request.name === "playwright-core" ? mocks.coreArchive : "/unused",
        },
        dependencies,
      })
    },
  }
})

vi.mock("../src/artifact-cache.ts", async () => {
  const { Effect } = await import("effect")
  return {
    cacheArtifact: (request: { readonly url: string }) => (
      mocks.browserUrls.push(request.url),
      Effect.succeed({
        integrity: request.url.includes("headless") ? `sha256:${"b".repeat(64)}` : `sha256:${"c".repeat(64)}`,
        size: request.url.includes("headless") ? 20 : 30,
        path: "/cached/browser",
      })
    ),
  }
})

import { resolvePlaywrightRelease } from "../src/playwright-release.ts"

describe("Playwright release resolution", () => {
  beforeEach(() => {
    mocks.playwrightDependency = "1.2.3"
    mocks.coreVersion = "1.2.3"
    mocks.browserUrls = []
  })

  it("locks stable MCP packages and hashes the selected browser revision", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-playwright-release-"))
    const packageRoot = path.join(root, "package")
    await mkdir(packageRoot)
    await writeFile(
      path.join(packageRoot, "browsers.json"),
      JSON.stringify({ browsers: [{ name: "chromium", revision: "1234" }] }),
    )
    mocks.coreArchive = path.join(root, "playwright-core.tgz")
    await execFilePromise("tar", ["-czf", mocks.coreArchive, "-C", root, "package"])

    const artifacts = await Effect.runPromise(
      resolvePlaywrightRelease({
        cacheHome: root,
        registry: "https://registry.test/",
        platform: "linux/arm64",
      }),
    )

    expect(artifacts.map(({ name, version }) => ({ name, version }))).toEqual([
      { name: "playwright-mcp", version: "1.2.3" },
      { name: "playwright", version: "1.2.3" },
      { name: "playwright-core", version: "1.2.3" },
      { name: "chromium", version: "1234" },
      { name: "chromium-headless-shell", version: "1234" },
    ])
    expect(artifacts.at(-1)).toMatchObject({ integrity: `sha256:${"b".repeat(64)}`, size: 20 })
    expect(mocks.browserUrls).toEqual([
      "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1234/chromium-linux-arm64.zip",
      "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1234/chromium-headless-shell-linux-arm64.zip",
    ])
  })

  it("uses Chrome for Testing URLs for current browser metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-playwright-cft-"))
    const packageRoot = path.join(root, "package")
    await mkdir(packageRoot)
    await writeFile(
      path.join(packageRoot, "browsers.json"),
      JSON.stringify({
        browsers: [
          { name: "chromium", revision: "1246", browserVersion: "154.0.8037.0", title: "Chrome for Testing" },
          {
            name: "chromium-headless-shell",
            revision: "1246",
            browserVersion: "154.0.8037.0",
            title: "Chrome Headless Shell",
          },
        ],
      }),
    )
    mocks.coreArchive = path.join(root, "playwright-core.tgz")
    await execFilePromise("tar", ["-czf", mocks.coreArchive, "-C", root, "package"])

    mocks.coreVersion = "1.59.0"
    await Effect.runPromise(
      resolvePlaywrightRelease({
        cacheHome: root,
        registry: "https://registry.test/",
        platform: "linux/arm64",
      }),
    )

    expect(mocks.browserUrls).toEqual([
      "https://cdn.playwright.dev/builds/cft/154.0.8037.0/linux-arm64/chrome-linux-arm64.zip",
      "https://cdn.playwright.dev/builds/cft/154.0.8037.0/linux-arm64/chrome-headless-shell-linux-arm64.zip",
    ])
  })

  it("keeps the legacy URL layout for Playwright 1.58 metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-playwright-legacy-cft-label-"))
    const packageRoot = path.join(root, "package")
    await mkdir(packageRoot)
    await writeFile(
      path.join(packageRoot, "browsers.json"),
      JSON.stringify({
        browsers: [
          { name: "chromium", revision: "1208", browserVersion: "145.0.7632.6", title: "Chrome for Testing" },
          {
            name: "chromium-headless-shell",
            revision: "1208",
            browserVersion: "145.0.7632.6",
            title: "Chrome Headless Shell",
          },
        ],
      }),
    )
    mocks.coreArchive = path.join(root, "playwright-core.tgz")
    mocks.coreVersion = "1.58.0"
    await execFilePromise("tar", ["-czf", mocks.coreArchive, "-C", root, "package"])

    await Effect.runPromise(
      resolvePlaywrightRelease({
        cacheHome: root,
        registry: "https://registry.test/",
        platform: "linux/arm64",
      }),
    )

    expect(mocks.browserUrls).toEqual([
      "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1208/chromium-linux-arm64.zip",
      "https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/1208/chromium-headless-shell-linux-arm64.zip",
    ])
  })

  it("rejects a non-exact Playwright dependency before resolving the bundle", async () => {
    mocks.playwrightDependency = "^1.2.3"

    await expect(
      Effect.runPromise(
        resolvePlaywrightRelease({
          cacheHome: "cache",
          registry: "https://registry.test/",
          platform: "linux/arm64",
        }),
      ),
    ).rejects.toThrow(/dependency is invalid/)
  })
})
