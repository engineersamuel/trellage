import { createHash } from "node:crypto"

import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  PrimeReleaseError,
  PrimeReleaseHttpClient,
  resolvePrimeRelease,
  type PrimeReleaseClient,
} from "../src/prime-release.js"

const version = "0.7.0"
const stableUrl = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/stable"
const releaseRoot = "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.0"
const checksumUrl = `${releaseRoot}/SHA256SUMS`
const artifactUrl = `${releaseRoot}/prime-agent-0.7.0.tgz`
const digest = "88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b"
const checksum = `${digest}  prime-agent-0.7.0.tgz\n7cdbb3e835f48dd103325f7a351ce540b27af4d161aeb9c7b9bdcc12fe7909af  prime-agent-ai-0.7.0.tgz\n0313373089831d9a2ce06e874fab8b9c05762c0094ff9fc202908cf7db7f99cd  prime-agent-core-0.7.0.tgz\n3225f7f92e87db80fe2c9005d1f7770735ae625c32935ef2283688fc9bd33951  prime-agent-tui-0.7.0.tgz\n`

interface FixtureOptions {
  readonly stable?: string
  readonly checksums?: string
  readonly size?: number
}

const fixtureClient = (
  options: FixtureOptions = {},
  textRequests: Array<string> = [],
  artifactRequests: Array<{ readonly url: string; readonly digest: string }> = [],
): PrimeReleaseClient => ({
  text: (url) =>
    Effect.sync(() => {
      textRequests.push(url)
      if (url === stableUrl) return options.stable ?? "v0.7.0\n"
      if (url === checksumUrl) return options.checksums ?? checksum
      throw new Error(`unexpected URL: ${url}`)
    }),
  artifactSize: (url, expectedSha256) =>
    Effect.sync(() => {
      artifactRequests.push({ url, digest: expectedSha256 })
      return options.size ?? 9323789
    }),
})

const response = (url: string, body: BodyInit | null, init: ResponseInit = {}): Response => {
  const result = new Response(body, init)
  Object.defineProperty(result, "url", { value: url })
  return result
}

const errorOf = (effect: Effect.Effect<unknown, PrimeReleaseError>) => Effect.runPromise(Effect.flip(effect))

describe("resolvePrimeRelease", () => {
  it("resolves the stable channel to the exact verified tarball", async () => {
    const textRequests: Array<string> = []
    const artifactRequests: Array<{ readonly url: string; readonly digest: string }> = []

    await expect(
      Effect.runPromise(
        resolvePrimeRelease("latest", "linux/arm64", fixtureClient({}, textRequests, artifactRequests)),
      ),
    ).resolves.toEqual({
      kind: "prime",
      selector: "latest",
      version,
      url: artifactUrl,
      integrity: `sha256:${digest}`,
      size: 9323789,
    })
    expect(textRequests).toEqual([stableUrl, checksumUrl])
    expect(artifactRequests).toEqual([{ url: artifactUrl, digest }])
  })

  it("skips the mutable channel for an explicit stable version", async () => {
    const textRequests: Array<string> = []

    await Effect.runPromise(resolvePrimeRelease(version, "linux/amd64", fixtureClient({}, textRequests)))

    expect(textRequests).toEqual([checksumUrl])
  })

  it.each(["preview", "1.2", "v0.7.0", "0.7.0-beta.1", "01.7.0"])("rejects non-exact selector %j", async (selector) => {
    const error = await errorOf(resolvePrimeRelease(selector, "linux/arm64", fixtureClient()))

    expect(error.message).toMatch(/selector|version/i)
  })

  it.each([
    ["empty channel", { stable: "\n" }, /channel|version/i],
    ["prerelease channel", { stable: "v0.7.0-beta.1\n" }, /channel|version/i],
    ["uppercase checksum", { checksums: `${digest.toUpperCase()}  prime-agent-0.7.0.tgz\n` }, /checksum/i],
    ["duplicate checksum", { checksums: `${checksum}${checksum}` }, /checksum/i],
    ["wrong checksum filename", { checksums: `${digest}  prime-agent-other.tgz\n` }, /checksum/i],
    ["malformed checksum row", { checksums: `${digest} *prime-agent-0.7.0.tgz\n` }, /checksum/i],
    ["zero artifact size", { size: 0 }, /size/i],
    ["fractional artifact size", { size: 1.5 }, /size/i],
  ] as const)("rejects %s", async (_label, options, message) => {
    const error = await errorOf(resolvePrimeRelease("latest", "linux/arm64", fixtureClient(options)))

    expect(error).toBeInstanceOf(PrimeReleaseError)
    expect(error.message).toMatch(message)
  })
})

describe("PrimeReleaseHttpClient", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("uses a redirect-rejecting HEAD request when Content-Length is valid", async () => {
    const fetchMock = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(async () =>
      response(artifactUrl, null, { headers: { "Content-Length": "9323789" } }),
    )
    vi.stubGlobal("fetch", fetchMock)

    await expect(Effect.runPromise(PrimeReleaseHttpClient.artifactSize(artifactUrl, digest))).resolves.toBe(9323789)
    expect(fetchMock).toHaveBeenCalledWith(artifactUrl, { method: "HEAD", redirect: "error" })
  })

  it("streams one bounded GET and verifies its digest when HEAD is unsupported", async () => {
    const bytes = new TextEncoder().encode("prime-agent fixture")
    const expectedDigest = createHash("sha256").update(bytes).digest("hex")
    const fetchMock = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(response(artifactUrl, null, { status: 405 }))
      .mockResolvedValueOnce(response(artifactUrl, bytes))
    vi.stubGlobal("fetch", fetchMock)

    await expect(Effect.runPromise(PrimeReleaseHttpClient.artifactSize(artifactUrl, expectedDigest))).resolves.toBe(
      bytes.byteLength,
    )
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["HEAD", "GET"])
  })

  it("rejects a fallback body whose digest differs from SHA256SUMS", async () => {
    const fetchMock = vi
      .fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(response(artifactUrl, null, { status: 405 }))
      .mockResolvedValueOnce(response(artifactUrl, "tampered"))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      Effect.runPromise(Effect.flip(PrimeReleaseHttpClient.artifactSize(artifactUrl, digest))),
    ).resolves.toMatchObject({
      message: expect.stringMatching(/digest/i),
    })
  })

  it("rejects substituted text response identities", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response("https://example.test/stable", "v0.7.0\n")),
    )

    await expect(Effect.runPromise(Effect.flip(PrimeReleaseHttpClient.text(stableUrl)))).resolves.toMatchObject({
      message: expect.stringMatching(/identity/i),
    })
  })
})
