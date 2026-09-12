import { mkdtemp } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveGitHubArtifactRelease } from "../src/github-artifact-release.ts"

afterEach(() => {
  vi.restoreAllMocks()
})

describe("GitHub artifact release resolution", () => {
  it("downloads and hashes an asset when GitHub omits its digest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-github-artifact-"))
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input)
      if (url.endsWith("/releases/latest")) {
        return new Response(
          JSON.stringify({
            tag_name: "v1.2.3",
            prerelease: false,
            draft: false,
            assets: [
              {
                name: "tool-linux-arm64",
                browser_download_url: "https://github.com/example/tool/releases/download/v1.2.3/tool-linux-arm64",
                size: 999,
              },
            ],
          }),
        )
      }
      if (url.endsWith("/tool-linux-arm64")) return new Response("tool bytes")
      return new Response("missing", { status: 404 })
    })

    const artifact = await Effect.runPromise(
      resolveGitHubArtifactRelease({
        cacheHome: root,
        name: "tool",
        repository: "example/tool",
        platform: "linux/arm64",
        versionFromTag: (tag) => /^v(\d+\.\d+\.\d+)$/.exec(tag)?.[1],
        assetName: () => "tool-linux-arm64",
      }),
    )

    expect(artifact).toMatchObject({
      name: "tool",
      version: "1.2.3",
      size: 10,
      url: "https://github.com/example/tool/releases/download/v1.2.3/tool-linux-arm64",
    })
    expect(artifact.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})
