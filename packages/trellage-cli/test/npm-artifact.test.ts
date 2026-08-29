import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { npmTarballUrl, resolveNpmArtifact } from "../src/npm-artifact.js"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("npm artifact resolution", () => {
  it("resolves metadata and hashes the exact tarball into XDG cache", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-npm-artifact-"))
    const requests: Array<string> = []
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      requests.push(url)
      if (url === "https://packagefeedproxy.microsoft.io/npm/@playwright%2fmcp") {
        return new Response(
          JSON.stringify({
            name: "@playwright/mcp",
            "dist-tags": { latest: "1.2.3" },
            versions: {
              "1.2.3": {
                name: "@playwright/mcp",
                version: "1.2.3",
                dependencies: { playwright: "1.2.3" },
                dist: { tarball: "https://registry.npmjs.org/@playwright/mcp/-/mcp-1.2.3.tgz" },
              },
            },
          }),
        )
      }
      if (url === "https://packagefeedproxy.microsoft.io/npm/@playwright%2fmcp/-/mcp-1.2.3.tgz") {
        return new Response("package bytes")
      }
      return new Response("missing", { status: 404 })
    }) as typeof fetch

    const resolved = await Effect.runPromise(
      resolveNpmArtifact({
        cacheHome: root,
        registry: "https://packagefeedproxy.microsoft.io/npm/",
        name: "@playwright/mcp",
        selector: "latest",
        artifactName: "playwright-mcp",
        requireStable: true,
      }),
    )

    expect(resolved.artifact).toMatchObject({
      name: "playwright-mcp",
      version: "1.2.3",
      size: 13,
      url: "npm:%40playwright%2Fmcp@1.2.3",
    })
    expect(resolved.artifact.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(resolved.dependencies).toEqual({ playwright: "1.2.3" })
    expect(requests).toContain("https://packagefeedproxy.microsoft.io/npm/@playwright%2fmcp")
    expect(requests.some((url) => url.endsWith("/latest"))).toBe(false)
    expect(requests.some((url) => url.startsWith("https://registry.npmjs.org/"))).toBe(false)
  })

  it("rejects prerelease versions from the stable channel", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-npm-prerelease-"))
    globalThis.fetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            name: "@playwright/mcp",
            "dist-tags": { latest: "1.2.3-beta.1" },
            versions: {
              "1.2.3-beta.1": {
                name: "@playwright/mcp",
                version: "1.2.3-beta.1",
                dependencies: {},
                dist: { tarball: "https://registry.test/mcp.tgz" },
              },
            },
          }),
        ),
    ) as typeof fetch

    await expect(
      Effect.runPromise(
        resolveNpmArtifact({
          cacheHome: root,
          registry: "https://registry.test/",
          name: "@playwright/mcp",
          selector: "latest",
          artifactName: "playwright-mcp",
          requireStable: true,
        }),
      ),
    ).rejects.toThrow(/metadata is invalid/)
  })

  it("resolves an exact dependency-free package from a CFS-style full packument", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-npm-exact-"))
    const requests: Array<string> = []
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      requests.push(url)
      if (url === "https://packagefeedproxy.microsoft.io/npm/playwright-core") {
        return new Response(
          JSON.stringify({
            name: "playwright-core",
            "dist-tags": { latest: "2.0.0" },
            versions: {
              "1.2.3": {
                name: "playwright-core",
                version: "1.2.3",
                dist: { tarball: "https://registry.npmjs.org/playwright-core/-/playwright-core-1.2.3.tgz" },
              },
            },
          }),
        )
      }
      if (url === "https://packagefeedproxy.microsoft.io/npm/playwright-core/-/playwright-core-1.2.3.tgz") {
        return new Response("core bytes")
      }
      return new Response("missing", { status: 404 })
    }) as typeof fetch

    const resolved = await Effect.runPromise(
      resolveNpmArtifact({
        cacheHome: root,
        registry: "https://packagefeedproxy.microsoft.io/npm/",
        name: "playwright-core",
        selector: "1.2.3",
        artifactName: "playwright-core",
        requireStable: false,
      }),
    )

    expect(resolved.artifact).toMatchObject({
      name: "playwright-core",
      version: "1.2.3",
      url: "npm:playwright-core@1.2.3",
    })
    expect(resolved.dependencies).toEqual({})
    expect(requests).toContain("https://packagefeedproxy.microsoft.io/npm/playwright-core")
    expect(requests.some((url) => url.endsWith("/1.2.3"))).toBe(false)
  })

  it("rejects present dependency maps with non-string requirements", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-npm-dependencies-"))
    globalThis.fetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            name: "playwright-core",
            "dist-tags": { latest: "1.2.3" },
            versions: {
              "1.2.3": {
                name: "playwright-core",
                version: "1.2.3",
                dependencies: { invalid: 123 },
                dist: { tarball: "https://registry.test/core.tgz" },
              },
            },
          }),
        ),
    ) as typeof fetch

    await expect(
      Effect.runPromise(
        resolveNpmArtifact({
          cacheHome: root,
          registry: "https://registry.test/",
          name: "playwright-core",
          selector: "1.2.3",
          artifactName: "playwright-core",
          requireStable: false,
        }),
      ),
    ).rejects.toThrow(/dependencies are invalid|metadata is invalid/)
  })

  it("constructs exact package downloads through the discovered host registry", () => {
    expect(npmTarballUrl("https://packagefeedproxy.microsoft.io/npm/", "@playwright/mcp", "1.2.3")).toBe(
      "https://packagefeedproxy.microsoft.io/npm/@playwright%2fmcp/-/mcp-1.2.3.tgz",
    )
  })
})
