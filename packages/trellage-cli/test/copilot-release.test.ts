import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  CopilotReleaseError,
  GitHubCopilotReleaseClient,
  resolveCopilotRelease,
  type CopilotReleaseClient,
} from "../src/copilot-release.js"

const digest = "sha256:0911f12dd816f612d27c4a360d4f00b62d933845a98d6c913e8d7400a69c6809"

const release = (overrides: Readonly<Record<string, unknown>> = {}): unknown => ({
  tag_name: "v1.0.75",
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "copilot-linux-arm64.tar.gz",
      browser_download_url:
        "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
      size: 106111479,
      digest,
      content_type: "application/gzip",
    },
  ],
  html_url: "https://github.com/github/copilot-cli/releases/tag/v1.0.75",
  ...overrides,
})

const client = (payload: unknown, selectors: Array<string> = []): CopilotReleaseClient => ({
  release: (selector) =>
    Effect.sync(() => {
      selectors.push(selector)
      return payload
    }),
})

const errorOf = (effect: Effect.Effect<unknown, CopilotReleaseError>) => Effect.runPromise(Effect.flip(effect))

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

describe("resolveCopilotRelease", () => {
  it("resolves latest to an exact stable arm64 release", async () => {
    await expect(Effect.runPromise(resolveCopilotRelease("latest", "linux/arm64", client(release())))).resolves.toEqual(
      {
        kind: "copilot",
        selector: "latest",
        version: "1.0.75",
        url: "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
        size: 106111479,
        integrity: digest,
      },
    )
  })

  it("maps amd64 to the x64 release asset", async () => {
    const x64 = release({
      assets: [
        {
          name: "copilot-linux-x64.tar.gz",
          browser_download_url:
            "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-x64.tar.gz",
          size: 106111479,
          digest,
        },
      ],
    })

    await expect(Effect.runPromise(resolveCopilotRelease("latest", "linux/amd64", client(x64)))).resolves.toMatchObject(
      {
        version: "1.0.75",
        url: "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-x64.tar.gz",
      },
    )
  })

  it("passes an explicit version unchanged to the release client", async () => {
    const selectors: Array<string> = []

    await Effect.runPromise(resolveCopilotRelease("1.0.75", "linux/arm64", client(release(), selectors)))

    expect(selectors).toEqual(["1.0.75"])
  })

  it.each([
    ["a prerelease", { prerelease: true }, /stable/],
    ["a draft", { draft: true }, /stable/],
    ["a malformed tag", { tag_name: "1.0.75" }, /tag/],
    ["a tag/version mismatch", { tag_name: "v1.0.76" }, /selector/],
    ["a missing platform asset", { assets: [] }, /asset/],
    [
      "a non-HTTPS URL",
      {
        assets: [
          {
            name: "copilot-linux-arm64.tar.gz",
            browser_download_url:
              "http://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
            size: 106111479,
            digest,
          },
        ],
      },
      /URL/,
    ],
    [
      "an unofficial URL",
      {
        assets: [
          {
            name: "copilot-linux-arm64.tar.gz",
            browser_download_url: "https://example.test/copilot-linux-arm64.tar.gz",
            size: 106111479,
            digest,
          },
        ],
      },
      /URL/,
    ],
    [
      "a missing digest",
      {
        assets: [
          {
            name: "copilot-linux-arm64.tar.gz",
            browser_download_url:
              "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
            size: 106111479,
          },
        ],
      },
      /digest/,
    ],
    [
      "a malformed SHA-256",
      {
        assets: [
          {
            name: "copilot-linux-arm64.tar.gz",
            browser_download_url:
              "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
            size: 106111479,
            digest: "sha256:not-a-digest",
          },
        ],
      },
      /digest/,
    ],
    [
      "a zero size",
      {
        assets: [
          {
            name: "copilot-linux-arm64.tar.gz",
            browser_download_url:
              "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
            size: 0,
            digest,
          },
        ],
      },
      /size/,
    ],
    [
      "a fractional size",
      {
        assets: [
          {
            name: "copilot-linux-arm64.tar.gz",
            browser_download_url:
              "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
            size: 1.5,
            digest,
          },
        ],
      },
      /size/,
    ],
  ] as const)("rejects %s", async (_label, overrides, message) => {
    const error = await errorOf(resolveCopilotRelease("1.0.75", "linux/arm64", client(release(overrides))))

    expect(error).toBeInstanceOf(CopilotReleaseError)
    expect(error.message).toMatch(message)
  })

  it.each([digest.replace("sha256:", "SHA256:"), `sha256:${digest.slice("sha256:".length).toUpperCase()}`])(
    "rejects noncanonical SHA-256 digest %j",
    async (noncanonical) => {
      const payload = release({
        assets: [
          {
            name: "copilot-linux-arm64.tar.gz",
            browser_download_url:
              "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
            size: 106111479,
            digest: noncanonical,
          },
        ],
      })

      await expect(errorOf(resolveCopilotRelease("latest", "linux/arm64", client(payload)))).resolves.toMatchObject({
        message: expect.stringMatching(/digest/),
      })
    },
  )
})

describe("GitHubCopilotReleaseClient", () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    ["latest", "https://api.github.com/repos/github/copilot-cli/releases/latest"],
    ["1.0.75", "https://api.github.com/repos/github/copilot-cli/releases/tags/v1.0.75"],
  ])("requests the %s API route with explicit headers", async (selector, expectedUrl) => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => githubResponse(expectedUrl))
    vi.stubGlobal("fetch", fetch)

    await Effect.runPromise(GitHubCopilotReleaseClient.release(selector))

    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(expectedUrl)
    expect(init).toMatchObject({
      redirect: "error",
      headers: expect.objectContaining({
        Accept: "application/vnd.github+json",
        "User-Agent": "sandbox-harness",
      }),
    })
  })

  it.each([
    [true, "https://api.github.com/repos/github/copilot-cli/releases/latest"],
    [false, "https://example.test/releases/latest"],
  ])("rejects redirected=%s final release URL %s", async (redirected, responseUrl) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => githubResponse(responseUrl, { redirected })),
    )

    await expect(Effect.runPromise(Effect.flip(GitHubCopilotReleaseClient.release("latest")))).resolves.toMatchObject({
      message: expect.stringMatching(/identity|redirect/),
    })
  })

  it("fails without exposing the response body", async () => {
    const response = new Response("secret response body", { status: 403 })
    Object.defineProperty(response, "url", {
      value: "https://api.github.com/repos/github/copilot-cli/releases/latest",
    })
    Object.defineProperty(response, "redirected", { value: false })
    const text = vi.spyOn(response, "text")
    const json = vi.spyOn(response, "json")
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    )

    const error = await Effect.runPromise(Effect.flip(GitHubCopilotReleaseClient.release("latest")))

    expect(text).not.toHaveBeenCalled()
    expect(json).not.toHaveBeenCalled()
    expect(String(error)).not.toContain("secret response body")
  })
})
