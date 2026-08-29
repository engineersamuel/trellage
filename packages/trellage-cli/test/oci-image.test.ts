import { createHash } from "node:crypto"

import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveOciImage } from "../src/oci-image.js"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const digest = (body: string): string => `sha256:${createHash("sha256").update(body).digest("hex")}`

describe("OCI image resolution", () => {
  it("resolves and verifies the selected Docker Hub platform manifest", async () => {
    const child = JSON.stringify({ schemaVersion: 2, config: { digest: `sha256:${"a".repeat(64)}` }, layers: [] })
    const childDigest = digest(child)
    const index = JSON.stringify({
      schemaVersion: 2,
      manifests: [
        { digest: `sha256:${"b".repeat(64)}`, platform: { os: "linux", architecture: "amd64" } },
        { digest: childDigest, platform: { os: "linux", architecture: "arm64" } },
      ],
    })
    const requests: Array<string> = []
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      requests.push(url)
      if (url.startsWith("https://auth.docker.io/")) return new Response(JSON.stringify({ token: "token" }))
      if (url.endsWith("/manifests/bookworm-slim")) return new Response(index)
      if (url.endsWith(`/manifests/${encodeURIComponent(childDigest)}`)) return new Response(child)
      return new Response("missing", { status: 404 })
    }) as typeof fetch

    await expect(Effect.runPromise(resolveOciImage("node:bookworm-slim", "linux/arm64"))).resolves.toEqual({
      reference: "node:bookworm-slim",
      digest: childDigest,
    })
    expect(requests).toContain(
      `https://registry-1.docker.io/v2/library/node/manifests/${encodeURIComponent(childDigest)}`,
    )
  })

  it("rejects an index without the requested platform", async () => {
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.startsWith("https://auth.docker.io/")) return new Response(JSON.stringify({ token: "token" }))
      return new Response(
        JSON.stringify({
          schemaVersion: 2,
          manifests: [{ digest: `sha256:${"b".repeat(64)}`, platform: { os: "linux", architecture: "amd64" } }],
        }),
      )
    }) as typeof fetch

    await expect(Effect.runPromise(resolveOciImage("node:bookworm-slim", "linux/arm64"))).rejects.toThrow(
      /OCI manifest is invalid/,
    )
  })
})
