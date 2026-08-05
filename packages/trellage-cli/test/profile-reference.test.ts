import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveProfileReference } from "../src/profile-reference.js"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("GitHub profile references", () => {
  it("fetches profile and selected sibling lock from one resolved commit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-profile-reference-"))
    const commit = "a".repeat(40)
    const requests: Array<string> = []
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      requests.push(url)
      if (url.includes("api.github.com")) return new Response(JSON.stringify({ sha: commit }))
      if (url.endsWith("profile.toml")) return new Response("schema = 1\n")
      return new Response('schema = 1\nplatform = "linux/amd64"\n')
    }) as typeof fetch

    const resolved = await Effect.runPromise(
      resolveProfileReference(
        "https://github.com/engineersamuel/trellage/blob/v1.0.0/profiles/copilot-hve/profile.toml",
        "linux/amd64",
        root,
      ),
    )

    await expect(readFile(resolved, "utf8")).resolves.toBe("schema = 1\n")
    await expect(
      readFile(path.join(path.dirname(resolved), "profile.linux-amd64.lock.toml"), "utf8"),
    ).resolves.toContain('platform = "linux/amd64"')
    expect(requests).toContain(
      `https://raw.githubusercontent.com/engineersamuel/trellage/${commit}/profiles/copilot-hve/profile.toml`,
    )
    expect(requests).toContain(
      `https://raw.githubusercontent.com/engineersamuel/trellage/${commit}/profiles/copilot-hve/profile.linux-amd64.lock.toml`,
    )
  })

  it("isolates cached profile resources by selected platform", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-profile-reference-platform-"))
    const commit = "b".repeat(40)
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes("api.github.com")) return new Response(JSON.stringify({ sha: commit }))
      if (url.endsWith("profile.toml")) return new Response("schema = 1\n")
      const platform = url.includes("linux-amd64") ? "linux/amd64" : "linux/arm64"
      return new Response(`schema = 1\nplatform = "${platform}"\n`)
    }) as typeof fetch
    const reference = "https://github.com/engineersamuel/trellage/blob/main/profiles/copilot-hve/profile.toml"

    const arm64 = await Effect.runPromise(resolveProfileReference(reference, "linux/arm64", root))
    const amd64 = await Effect.runPromise(resolveProfileReference(reference, "linux/amd64", root))

    expect(path.dirname(arm64)).not.toBe(path.dirname(amd64))
    await expect(readFile(path.join(path.dirname(arm64), "profile.linux-arm64.lock.toml"), "utf8")).resolves.toContain(
      'platform = "linux/arm64"',
    )
    await expect(readFile(path.join(path.dirname(amd64), "profile.linux-amd64.lock.toml"), "utf8")).resolves.toContain(
      'platform = "linux/amd64"',
    )
  })

  it("publishes one complete immutable cache result for concurrent same-process callers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-profile-reference-concurrent-"))
    const commit = "c".repeat(40)
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes("api.github.com")) return new Response(JSON.stringify({ sha: commit }))
      if (url.endsWith("profile.toml")) return new Response("schema = 1\n")
      return new Response('schema = 1\nplatform = "linux/arm64"\n')
    }) as typeof fetch
    const reference = "https://github.com/engineersamuel/trellage/blob/main/profiles/copilot-hve/profile.toml"

    const resolved = await Promise.all(
      Array.from({ length: 8 }, () => Effect.runPromise(resolveProfileReference(reference, "linux/arm64", root))),
    )

    expect(new Set(resolved).size).toBe(1)
    await expect(readFile(resolved[0]!, "utf8")).resolves.toBe("schema = 1\n")
    await expect(
      readFile(path.join(path.dirname(resolved[0]!), "profile.linux-arm64.lock.toml"), "utf8"),
    ).resolves.toContain('platform = "linux/arm64"')
  })
})
