import { createHash } from "node:crypto"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { cacheArtifact } from "../src/artifact-cache.js"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("artifact content cache", () => {
  it("hashes and atomically reuses downloaded content", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-artifact-cache-"))
    const content = "verified artifact\n"
    const integrity = `sha256:${createHash("sha256").update(content).digest("hex")}`
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(content))
    globalThis.fetch = fetchMock

    const first = await Effect.runPromise(
      cacheArtifact({ cacheHome: root, url: "https://example.test/artifact.tar.gz" }),
    )
    const second = await Effect.runPromise(
      cacheArtifact({
        cacheHome: root,
        url: "https://example.test/artifact.tar.gz",
        expectedIntegrity: integrity,
        expectedSize: Buffer.byteLength(content),
      }),
    )

    expect(first).toEqual(second)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await expect(readFile(first.path, "utf8")).resolves.toBe(content)
  })

  it("rejects downloaded bytes that do not match an expected digest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-artifact-cache-mismatch-"))
    globalThis.fetch = vi.fn<typeof fetch>(async () => new Response("wrong")) as typeof fetch

    await expect(
      Effect.runPromise(
        cacheArtifact({
          cacheHome: root,
          url: "https://example.test/artifact.tar.gz",
          expectedIntegrity: `sha256:${"a".repeat(64)}`,
        }),
      ),
    ).rejects.toThrow(/cannot cache artifact/)
  })
})
