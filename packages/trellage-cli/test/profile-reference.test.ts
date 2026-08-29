import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveProfileReference } from "../src/profile-reference.js"
import { renderLock } from "../src/lock-file.js"
import type { ProfileLock } from "../src/lock.js"
import {
  createPythonConstraintsSidecar,
  renderResolutionSidecar,
  resolutionSidecarReference,
} from "../src/resolution-sidecar.js"
import { resolutionSidecarPath } from "../src/resolution-sidecar-storage.js"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("GitHub profile references", () => {
  it("fetches profile and selected release lock from one resolved commit", async () => {
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
        "release",
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

    const arm64 = await Effect.runPromise(resolveProfileReference(reference, "linux/arm64", root, "release"))
    const amd64 = await Effect.runPromise(resolveProfileReference(reference, "linux/amd64", root, "release"))

    expect(path.dirname(arm64)).not.toBe(path.dirname(amd64))
    await expect(readFile(path.join(path.dirname(arm64), "profile.linux-arm64.lock.toml"), "utf8")).resolves.toContain(
      'platform = "linux/arm64"',
    )
    await expect(readFile(path.join(path.dirname(amd64), "profile.linux-amd64.lock.toml"), "utf8")).resolves.toContain(
      'platform = "linux/amd64"',
    )
  })

  it("does not require an adjacent release lock for development references", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-profile-reference-development-"))
    const commit = "c".repeat(40)
    const requests: Array<string> = []
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      requests.push(url)
      if (url.includes("api.github.com")) return new Response(JSON.stringify({ sha: commit }))
      if (url.endsWith("profile.toml")) return new Response("schema = 1\n")
      return new Response("missing", { status: 404 })
    }) as typeof fetch

    const resolved = await Effect.runPromise(
      resolveProfileReference(
        "https://github.com/engineersamuel/trellage/blob/main/profiles/copilot-hve/profile.toml",
        "linux/arm64",
        root,
      ),
    )

    await expect(readFile(resolved, "utf8")).resolves.toBe("schema = 1\n")
    expect(requests.some((request) => request.endsWith(".lock.toml"))).toBe(false)
  })

  it("publishes one complete immutable development cache result for concurrent same-process callers", async () => {
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
    ).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("fetches a referenced release sidecar with the locked profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-profile-reference-sidecar-"))
    const commit = "d".repeat(40)
    const profileHash = `sha256:${"a".repeat(64)}`
    const sidecar = createPythonConstraintsSidecar(
      profileHash,
      "linux/arm64",
      `example==1.0.0 \\\n    --hash=sha256:${"f".repeat(64)}\n`,
    )
    const lock: ProfileLock = {
      schema: 1,
      platform: "linux/arm64",
      source_date_epoch: 1784379906,
      profile_hash: profileHash,
      sources: [],
      packages: {
        harness: {
          kind: "codex",
          selector: "1.0.0",
          version: "1.0.0",
          integrity: `sha256:${"b".repeat(64)}`,
          url: "https://example.test/codex.tar.gz",
          size: 1,
        },
        runtime: [],
      },
      sidecar: resolutionSidecarReference(sidecar),
      image: { base: "node:bookworm-slim", base_digest: `sha256:${"c".repeat(64)}` },
    }
    const lockSource = renderLock(lock)
    const sidecarSource = renderResolutionSidecar(sidecar)
    globalThis.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = String(input)
      if (url.includes("api.github.com")) return new Response(JSON.stringify({ sha: commit }))
      if (url.endsWith("profile.toml")) return new Response("schema = 1\n")
      if (url.endsWith(".lock.toml")) return new Response(lockSource)
      if (url.endsWith(".json")) return new Response(sidecarSource)
      return new Response("missing", { status: 404 })
    }) as typeof fetch

    const resolved = await Effect.runPromise(
      resolveProfileReference(
        "https://github.com/engineersamuel/trellage/blob/v1/profiles/example/profile.toml",
        "linux/arm64",
        root,
        "release",
      ),
    )
    const lockPath = path.join(path.dirname(resolved), "profile.linux-arm64.lock.toml")

    await expect(readFile(resolutionSidecarPath(lockPath, lock.sidecar!), "utf8")).resolves.toBe(sidecarSource)
  })
})
