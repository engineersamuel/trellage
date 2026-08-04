import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { GitHubPiReleaseClient, PiReleaseError, resolvePiRelease, type PiReleaseClient } from "../src/pi-release.js"

const digest = "sha256:65cd7f5e7d537b0b41f277191c1b95b53d509f8147c3d1bd508503dc048f1453"

const release = (overrides: Readonly<Record<string, unknown>> = {}): unknown => ({
  tag_name: "v17.2.6",
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "omp-linux-arm64",
      browser_download_url: "https://github.com/can1357/oh-my-pi/releases/download/v17.2.6/omp-linux-arm64",
      size: 157526160,
      digest,
    },
  ],
  ...overrides,
})

const client = (payload: unknown, selectors: Array<string> = []): PiReleaseClient => ({
  release: (selector) =>
    Effect.sync(() => {
      selectors.push(selector)
      return payload
    }),
})

const errorOf = (effect: Effect.Effect<unknown, PiReleaseError>) => Effect.runPromise(Effect.flip(effect))

const githubResponse = (
  url: string,
  overrides: Partial<Pick<Response, "ok" | "status" | "redirected">> = {},
): Response =>
  ({
    ok: true,
    status: 200,
    redirected: false,
    url,
    json: async () => release(),
    ...overrides,
  }) as Response

const releaseAsset = (): Readonly<Record<string, unknown>> => ({
  name: "omp-linux-arm64",
  browser_download_url: "https://github.com/can1357/oh-my-pi/releases/download/v17.2.6/omp-linux-arm64",
  size: 157526160,
  digest,
})

describe("resolvePiRelease", () => {
  it("resolves latest to an exact stable arm64 release", async () => {
    await expect(Effect.runPromise(resolvePiRelease("latest", "linux/arm64", client(release())))).resolves.toEqual({
      kind: "pi",
      selector: "latest",
      version: "17.2.6",
      url: "https://github.com/can1357/oh-my-pi/releases/download/v17.2.6/omp-linux-arm64",
      size: 157526160,
      integrity: digest,
    })
  })

  it("maps amd64 to the x64 raw executable", async () => {
    const x64 = release({
      assets: [
        {
          name: "omp-linux-x64",
          browser_download_url: "https://github.com/can1357/oh-my-pi/releases/download/v17.2.6/omp-linux-x64",
          size: 188016768,
          digest,
        },
      ],
    })

    await expect(Effect.runPromise(resolvePiRelease("latest", "linux/amd64", client(x64)))).resolves.toMatchObject({
      version: "17.2.6",
      url: "https://github.com/can1357/oh-my-pi/releases/download/v17.2.6/omp-linux-x64",
    })
  })

  it("passes an explicit version unchanged to the release client", async () => {
    const selectors: Array<string> = []

    await Effect.runPromise(resolvePiRelease("17.2.6", "linux/arm64", client(release(), selectors)))

    expect(selectors).toEqual(["17.2.6"])
  })

  it.each([
    ["a prerelease", { prerelease: true }, /stable/],
    ["a draft", { draft: true }, /stable/],
    ["a malformed tag", { tag_name: "17.2.6" }, /tag/],
    ["a tag/version mismatch", { tag_name: "v17.2.7" }, /selector/],
    ["a missing platform asset", { assets: [] }, /asset/],
    ["an ambiguous platform asset", { assets: [releaseAsset(), releaseAsset()] }, /ambiguous/],
    [
      "an unofficial URL",
      { assets: [{ ...releaseAsset(), browser_download_url: "https://example.test/omp-linux-arm64" }] },
      /URL/,
    ],
    ["a missing digest", { assets: [{ ...releaseAsset(), digest: undefined }] }, /digest/],
    ["a malformed SHA-256", { assets: [{ ...releaseAsset(), digest: "sha256:not-a-digest" }] }, /digest/],
    ["a zero size", { assets: [{ ...releaseAsset(), size: 0 }] }, /size/],
    ["a fractional size", { assets: [{ ...releaseAsset(), size: 1.5 }] }, /size/],
  ] as const)("rejects %s", async (_label, overrides, message) => {
    const error = await errorOf(resolvePiRelease("17.2.6", "linux/arm64", client(release(overrides))))

    expect(error).toBeInstanceOf(PiReleaseError)
    expect(error.message).toMatch(message)
  })
})

describe("GitHubPiReleaseClient", () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ["latest", "https://api.github.com/repos/can1357/oh-my-pi/releases/latest"],
    ["17.2.6", "https://api.github.com/repos/can1357/oh-my-pi/releases/tags/v17.2.6"],
  ])("requests the %s API route with explicit headers", async (selector, expectedUrl) => {
    const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
      async (_input, _init) => githubResponse(expectedUrl),
    )
    vi.stubGlobal("fetch", fetchMock)

    await Effect.runPromise(GitHubPiReleaseClient.release(selector))

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(fetchMock.mock.calls[0]).toEqual([
      expectedUrl,
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({
          Accept: "application/vnd.github+json",
          "User-Agent": "trellage",
        }),
      }),
    ])
  })

  it("rejects redirected or substituted release responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => githubResponse("https://example.test/releases/latest", { redirected: true })),
    )

    await expect(Effect.runPromise(Effect.flip(GitHubPiReleaseClient.release("latest")))).resolves.toMatchObject({
      message: expect.stringMatching(/identity|redirect/),
    })
  })
})
