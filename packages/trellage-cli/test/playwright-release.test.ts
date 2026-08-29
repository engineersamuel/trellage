import { execFile } from "node:child_process"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { Effect } from "effect"
import { beforeEach, describe, expect, it, vi } from "vitest"

const execFilePromise = promisify(execFile)
const mocks = vi.hoisted(() => ({ coreArchive: "", playwrightDependency: "1.2.3" }))

vi.mock("../src/npm-artifact.js", async () => {
  const { Effect } = await import("effect")
  return {
    resolveNpmArtifact: (request: { readonly name: string; readonly artifactName: string }) => {
      const dependencies =
        request.name === "@playwright/mcp"
          ? { playwright: mocks.playwrightDependency }
          : request.name === "playwright"
            ? { "playwright-core": "1.2.3" }
            : {}
      return Effect.succeed({
        artifact: {
          name: request.artifactName,
          version: "1.2.3",
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

vi.mock("../src/artifact-cache.js", async () => {
  const { Effect } = await import("effect")
  return {
    cacheArtifact: (request: { readonly url: string }) =>
      Effect.succeed({
        integrity: request.url.includes("headless") ? `sha256:${"b".repeat(64)}` : `sha256:${"c".repeat(64)}`,
        size: request.url.includes("headless") ? 20 : 30,
        path: "/cached/browser",
      }),
  }
})

import { resolvePlaywrightRelease } from "../src/playwright-release.js"

describe("Playwright release resolution", () => {
  beforeEach(() => {
    mocks.playwrightDependency = "1.2.3"
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
