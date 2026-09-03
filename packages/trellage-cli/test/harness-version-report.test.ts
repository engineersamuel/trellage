import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ClaudeReleaseClient } from "../src/claude-release.js"
import type { CodexReleaseClient } from "../src/codex-release.js"
import type { CopilotReleaseClient } from "../src/copilot-release.js"
import type { GitClient } from "../src/github-cache.js"
import type { PiReleaseClient } from "../src/pi-release.js"
import type { PrimeReleaseClient } from "../src/prime-release.js"
import type { loadProfile as loadProfileType, loadReleaseLock as loadReleaseLockType } from "../src/application.js"
import type { lockIsReady as lockIsReadyType, ProfileLock } from "../src/lock.js"
import type { loadResolutionReceipt as loadResolutionReceiptType } from "../src/resolution-receipt.js"
import type { ProfileDocument } from "../src/profile.js"

const application = vi.hoisted(() => ({
  loadProfile: vi.fn<typeof loadProfileType>(),
  loadReleaseLock: vi.fn<typeof loadReleaseLockType>(),
}))
const resolutionReceipt = vi.hoisted(() => ({ loadResolutionReceipt: vi.fn<typeof loadResolutionReceiptType>() }))
const lockModule = vi.hoisted(() => ({ lockIsReady: vi.fn<typeof lockIsReadyType>() }))

vi.mock("../src/application.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/application.js")>()
  return { ...actual, loadProfile: application.loadProfile, loadReleaseLock: application.loadReleaseLock }
})
vi.mock("../src/resolution-receipt.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/resolution-receipt.js")>()
  return { ...actual, loadResolutionReceipt: resolutionReceipt.loadResolutionReceipt }
})
vi.mock("../src/lock.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lock.js")>()
  return { ...actual, lockIsReady: lockModule.lockIsReady }
})

const { harnessVersionReport } = await import("../src/harness-version-report.js")

const claudeDocument = (): ProfileDocument =>
  ({ profile: { harness: { kind: "claude" } } }) as unknown as ProfileDocument

const codexDocument = (): ProfileDocument => ({ profile: { harness: { kind: "codex" } } }) as unknown as ProfileDocument

const copilotDocument = (): ProfileDocument =>
  ({ profile: { harness: { kind: "copilot" } } }) as unknown as ProfileDocument

const piDocument = (): ProfileDocument => ({ profile: { harness: { kind: "pi" } } }) as unknown as ProfileDocument

const primeDocument = (): ProfileDocument => ({ profile: { harness: { kind: "prime" } } }) as unknown as ProfileDocument

const headlongDocument = (): ProfileDocument =>
  ({ profile: { harness: { kind: "headlong" } } }) as unknown as ProfileDocument

const unsupportedDocument = (): ProfileDocument =>
  ({ profile: { harness: { kind: "unsupported" } } }) as unknown as ProfileDocument

const claudeLock = (version: string): ProfileLock =>
  ({
    packages: { harness: { kind: "claude", selector: "latest", version, integrity: "sha256:x", url: "x", size: 1 } },
  }) as unknown as ProfileLock

const codexLock = (version: string): ProfileLock =>
  ({
    packages: { harness: { kind: "codex", selector: "latest", version, integrity: "sha256:x", url: "x", size: 1 } },
  }) as unknown as ProfileLock

const copilotLock = (version: string): ProfileLock =>
  ({
    packages: { harness: { kind: "copilot", selector: "latest", version, integrity: "sha256:x", url: "x", size: 1 } },
  }) as unknown as ProfileLock

const piLock = (version: string): ProfileLock =>
  ({
    packages: { harness: { kind: "pi", selector: "latest", version, integrity: "sha256:x", url: "x", size: 1 } },
  }) as unknown as ProfileLock

const primeLock = (version: string): ProfileLock =>
  ({
    packages: { harness: { kind: "prime", selector: "latest", version, integrity: "sha256:x", url: "x", size: 1 } },
  }) as unknown as ProfileLock

const headlongLock = (commit: string): ProfileLock =>
  ({
    packages: { harness: { kind: "headlong", selector: "main", commit, integrity: "sha256:x" } },
  }) as unknown as ProfileLock

const fakeClaudeClient = (payload: unknown): ClaudeReleaseClient => ({ release: () => Effect.succeed(payload) })
const fakeCodexClient = (payload: unknown): CodexReleaseClient => ({ release: () => Effect.succeed(payload) })
const fakeCopilotClient = (payload: unknown): CopilotReleaseClient => ({ release: () => Effect.succeed(payload) })
const fakePiClient = (payload: unknown): PiReleaseClient => ({ release: () => Effect.succeed(payload) })

const fakePrimeClient = (version: string): PrimeReleaseClient => ({
  text: (url) => Effect.succeed(url.endsWith("/stable") ? version : `${"a".repeat(64)}  prime-agent-${version}.tgz`),
  artifactSize: () => Effect.succeed(1),
})

const fakeGitClient = (commit: string): GitClient => ({
  resolveRef: () => Effect.succeed(commit),
  checkout: () => Effect.void,
})

const claudeReleasePayload = (version: string) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "claude-linux-arm64.tar.gz",
      browser_download_url: `https://github.com/anthropics/claude-code/releases/download/v${version}/claude-linux-arm64.tar.gz`,
      size: 1,
      digest: `sha256:${"a".repeat(64)}`,
    },
  ],
})

const codexReleasePayload = (version: string) => ({
  tag_name: `rust-v${version}`,
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "codex-aarch64-unknown-linux-musl.tar.gz",
      browser_download_url: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-aarch64-unknown-linux-musl.tar.gz`,
      size: 1,
      digest: `sha256:${"a".repeat(64)}`,
    },
    {
      name: "codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
      browser_download_url: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz`,
      size: 1,
      digest: `sha256:${"b".repeat(64)}`,
    },
  ],
})

const copilotReleasePayload = (version: string) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "copilot-linux-arm64.tar.gz",
      browser_download_url: `https://github.com/github/copilot-cli/releases/download/v${version}/copilot-linux-arm64.tar.gz`,
      size: 1,
      digest: `sha256:${"a".repeat(64)}`,
    },
  ],
})

const piReleasePayload = (version: string) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "omp-linux-arm64",
      browser_download_url: `https://github.com/can1357/oh-my-pi/releases/download/v${version}/omp-linux-arm64`,
      size: 1,
      digest: `sha256:${"a".repeat(64)}`,
    },
  ],
})

const setup = (options: {
  readonly document: ProfileDocument
  readonly receipt?: ProfileLock
  readonly release?: ProfileLock
  readonly ready: boolean
}) => {
  application.loadProfile.mockReturnValue(Effect.succeed(options.document))
  application.loadReleaseLock.mockReturnValue(Effect.succeed(options.release))
  resolutionReceipt.loadResolutionReceipt.mockReturnValue(Effect.succeed(options.receipt))
  lockModule.lockIsReady.mockReturnValue(options.ready)
}

describe("harnessVersionReport", () => {
  it("reports the resolved installed version and latest release for a ready Claude profile", async () => {
    setup({ document: claudeDocument(), receipt: claudeLock("2.1.222"), ready: true })

    await expect(
      Effect.runPromise(
        harnessVersionReport("/profiles/claude/profile.toml", "linux/arm64", "/cache", {
          claude: fakeClaudeClient(claudeReleasePayload("2.1.230")),
        }),
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      harness: "claude",
      installed: "2.1.222",
      latest: "2.1.230",
      latestKnown: true,
    })
  })

  it("prefers the development receipt over the release lock when both are ready", async () => {
    setup({ document: claudeDocument(), receipt: claudeLock("2.1.222"), release: claudeLock("2.1.100"), ready: true })

    const result = await Effect.runPromise(
      harnessVersionReport("/profiles/claude/profile.toml", "linux/arm64", "/cache", {
        claude: fakeClaudeClient(claudeReleasePayload("2.1.230")),
      }),
    )

    expect(result.installed).toBe("2.1.222")
  })

  it("does not treat a release lock as installed when no development receipt exists", async () => {
    setup({ document: claudeDocument(), release: claudeLock("2.1.100"), ready: true })

    const result = await Effect.runPromise(
      harnessVersionReport("/profiles/claude/profile.toml", "linux/arm64", "/cache", {
        claude: fakeClaudeClient(claudeReleasePayload("2.1.230")),
      }),
    )

    expect(result.installed).toBeNull()
  })

  it("never fabricates an installed version when no lock is ready", async () => {
    setup({ document: claudeDocument(), receipt: claudeLock("2.1.222"), ready: false })

    const result = await Effect.runPromise(
      harnessVersionReport("/profiles/claude/profile.toml", "linux/arm64", "/cache", {
        claude: fakeClaudeClient(claudeReleasePayload("2.1.230")),
      }),
    )

    expect(result.installed).toBeNull()
  })

  it("reports an unknown latest version when the GitHub release lookup fails, without losing the installed version", async () => {
    setup({ document: claudeDocument(), receipt: claudeLock("2.1.222"), ready: true })

    const result = await Effect.runPromise(
      harnessVersionReport("/profiles/claude/profile.toml", "linux/arm64", "/cache", {
        claude: { release: () => Effect.fail(new Error("network down")) },
      }),
    )

    expect(result).toMatchObject({
      schemaVersion: 1,
      harness: "claude",
      installed: "2.1.222",
      latest: null,
      latestKnown: false,
      latestDiagnostic: expect.stringContaining("claude latest-version lookup failed"),
    })
  })

  it("reports the resolved installed version and latest release for a ready Codex profile", async () => {
    setup({ document: codexDocument(), receipt: codexLock("0.146.1"), ready: true })

    const result = await Effect.runPromise(
      harnessVersionReport("/profiles/codex/profile.toml", "linux/arm64", "/cache", {
        codex: fakeCodexClient(codexReleasePayload("0.152.1")),
      }),
    )

    expect(result).toEqual({
      schemaVersion: 1,
      harness: "codex",
      installed: "0.146.1",
      latest: "0.152.1",
      latestKnown: true,
    })
  })

  it("reports an unknown latest Codex version when the GitHub release lookup fails, without losing the installed version", async () => {
    setup({ document: codexDocument(), receipt: codexLock("0.146.1"), ready: true })

    const result = await Effect.runPromise(
      harnessVersionReport("/profiles/codex/profile.toml", "linux/arm64", "/cache", {
        codex: { release: () => Effect.fail(new Error("network down")) },
      }),
    )

    expect(result).toMatchObject({
      schemaVersion: 1,
      harness: "codex",
      installed: "0.146.1",
      latest: null,
      latestKnown: false,
      latestDiagnostic: expect.stringContaining("codex latest-version lookup failed"),
    })
  })

  it("never resolves a Claude release for a Codex profile, and vice versa", async () => {
    const claudeClient = fakeClaudeClient(claudeReleasePayload("2.1.230"))
    const claudeSpy = vi.spyOn(claudeClient, "release")
    setup({ document: codexDocument(), receipt: codexLock("0.146.1"), ready: true })

    await Effect.runPromise(
      harnessVersionReport("/profiles/codex/profile.toml", "linux/arm64", "/cache", {
        claude: claudeClient,
        codex: fakeCodexClient(codexReleasePayload("0.152.1")),
      }),
    )

    expect(claudeSpy).not.toHaveBeenCalled()
  })

  it("reports the latest Copilot release through the existing validated resolver", async () => {
    setup({ document: copilotDocument(), receipt: copilotLock("1.0.82"), ready: true })

    await expect(
      Effect.runPromise(
        harnessVersionReport("/profiles/copilot/profile.toml", "linux/arm64", "/cache", {
          copilot: fakeCopilotClient(copilotReleasePayload("1.0.90")),
        }),
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      harness: "copilot",
      installed: "1.0.82",
      latest: "1.0.90",
      latestKnown: true,
    })
  })

  it("reports the latest Oh My Pi release through the existing validated resolver", async () => {
    setup({ document: piDocument(), receipt: piLock("18.1.1"), ready: true })

    await expect(
      Effect.runPromise(
        harnessVersionReport("/profiles/pi/profile.toml", "linux/arm64", "/cache", {
          pi: fakePiClient(piReleasePayload("18.1.3")),
        }),
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      harness: "pi",
      installed: "18.1.1",
      latest: "18.1.3",
      latestKnown: true,
    })
  })

  it("reports the latest Prime release through the existing validated resolver", async () => {
    setup({ document: primeDocument(), receipt: primeLock("0.8.1"), ready: true })

    await expect(
      Effect.runPromise(
        harnessVersionReport("/profiles/prime/profile.toml", "linux/arm64", "/cache", {
          prime: fakePrimeClient("0.9.1"),
        }),
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      harness: "prime",
      installed: "0.8.1",
      latest: "0.9.1",
      latestKnown: true,
    })
  })

  it("reports the latest Headlong main commit through the existing Git client", async () => {
    const installed = "1".repeat(40)
    const latest = "2".repeat(40)
    setup({ document: headlongDocument(), receipt: headlongLock(installed), ready: true })

    await expect(
      Effect.runPromise(
        harnessVersionReport("/profiles/headlong/profile.toml", "linux/arm64", "/cache", {
          git: fakeGitClient(latest),
        }),
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      harness: "headlong",
      installed,
      latest,
      latestKnown: true,
    })
  })

  it("rejects a malformed Headlong ref as a retryable latest failure", async () => {
    setup({ document: headlongDocument(), receipt: headlongLock("1".repeat(40)), ready: true })

    const result = await Effect.runPromise(
      harnessVersionReport("/profiles/headlong/profile.toml", "linux/arm64", "/cache", {
        git: fakeGitClient("not-a-commit"),
      }),
    )

    expect(result).toMatchObject({
      installed: "1".repeat(40),
      latest: null,
      latestKnown: false,
      latestDiagnostic: expect.stringContaining("headlong latest-version lookup failed"),
    })
  })

  it("reports an unsupported latest kind without a retryable diagnostic", async () => {
    const claudeClient = fakeClaudeClient(claudeReleasePayload("2.1.230"))
    const codexClient = fakeCodexClient(codexReleasePayload("0.152.1"))
    const claudeSpy = vi.spyOn(claudeClient, "release")
    const codexSpy = vi.spyOn(codexClient, "release")
    setup({ document: unsupportedDocument(), ready: false })

    const result = await Effect.runPromise(
      harnessVersionReport("/profiles/unsupported/profile.toml", "linux/arm64", "/cache", {
        claude: claudeClient,
        codex: codexClient,
      }),
    )

    expect(result).toEqual({
      schemaVersion: 1,
      harness: "unsupported",
      installed: null,
      latest: null,
      latestKnown: false,
    })
    expect(claudeSpy).not.toHaveBeenCalled()
    expect(codexSpy).not.toHaveBeenCalled()
  })
})

describe("harnessVersionReport latest-version caching", () => {
  const temporaryRoots: string[] = []

  const temporaryXdgCacheHome = async (): Promise<string> => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-harness-version-report-test-"))
    temporaryRoots.push(root)
    return root
  }

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it("reuses a cached latest version across two profiles of the same harness kind, never calling the release client twice", async () => {
    const xdgCacheHome = await temporaryXdgCacheHome()
    const claudeClient = fakeClaudeClient(claudeReleasePayload("2.1.259"))
    const releaseSpy = vi.spyOn(claudeClient, "release")

    setup({ document: claudeDocument(), receipt: claudeLock("2.1.252"), ready: true })
    const first = await Effect.runPromise(
      harnessVersionReport("/profiles/claude-blog/profile.toml", "linux/arm64", xdgCacheHome, {
        claude: claudeClient,
      }),
    )

    setup({ document: claudeDocument(), receipt: claudeLock("2.1.251"), ready: true })
    const second = await Effect.runPromise(
      harnessVersionReport("/profiles/claude-council/profile.toml", "linux/arm64", xdgCacheHome, {
        claude: claudeClient,
      }),
    )

    expect(first).toEqual({
      schemaVersion: 1,
      harness: "claude",
      installed: "2.1.252",
      latest: "2.1.259",
      latestKnown: true,
    })
    expect(second).toEqual({
      schemaVersion: 1,
      harness: "claude",
      installed: "2.1.251",
      latest: "2.1.259",
      latestKnown: true,
    })
    expect(releaseSpy).toHaveBeenCalledTimes(1)
  })

  it("bypasses a fresh latest cache entry when refreshLatest is true and republishes the result", async () => {
    const xdgCacheHome = await temporaryXdgCacheHome()
    const initialClient = fakeClaudeClient(claudeReleasePayload("2.1.259"))
    setup({ document: claudeDocument(), receipt: claudeLock("2.1.252"), ready: true })
    await Effect.runPromise(
      harnessVersionReport("/profiles/claude-blog/profile.toml", "linux/arm64", xdgCacheHome, {
        claude: initialClient,
      }),
    )

    const refreshedClient = fakeClaudeClient(claudeReleasePayload("2.1.260"))
    const refreshSpy = vi.spyOn(refreshedClient, "release")
    const refreshed = await Effect.runPromise(
      harnessVersionReport(
        "/profiles/claude-blog/profile.toml",
        "linux/arm64",
        xdgCacheHome,
        { claude: refreshedClient },
        { refreshLatest: true },
      ),
    )

    expect(refreshed.latest).toBe("2.1.260")
    expect(refreshSpy).toHaveBeenCalledTimes(1)

    const cachedClient = fakeClaudeClient(claudeReleasePayload("2.1.999"))
    const cachedSpy = vi.spyOn(cachedClient, "release")
    const cached = await Effect.runPromise(
      harnessVersionReport("/profiles/claude-blog/profile.toml", "linux/arm64", xdgCacheHome, {
        claude: cachedClient,
      }),
    )
    expect(cached.latest).toBe("2.1.260")
    expect(cachedSpy).not.toHaveBeenCalled()
  })

  it("keeps a cached Codex latest version isolated from a cached Claude latest version", async () => {
    const xdgCacheHome = await temporaryXdgCacheHome()
    const claudeClient = fakeClaudeClient(claudeReleasePayload("2.1.259"))
    const codexClient = fakeCodexClient(codexReleasePayload("0.153.0"))

    setup({ document: claudeDocument(), receipt: claudeLock("2.1.252"), ready: true })
    await Effect.runPromise(
      harnessVersionReport("/profiles/claude-blog/profile.toml", "linux/arm64", xdgCacheHome, { claude: claudeClient }),
    )

    setup({ document: codexDocument(), receipt: codexLock("0.146.1"), ready: true })
    const codexResult = await Effect.runPromise(
      harnessVersionReport("/profiles/codex-superpowers/profile.toml", "linux/arm64", xdgCacheHome, {
        codex: codexClient,
      }),
    )

    expect(codexResult).toEqual({
      schemaVersion: 1,
      harness: "codex",
      installed: "0.146.1",
      latest: "0.153.0",
      latestKnown: true,
    })
  })

  it("never caches a lookup failure, so the next profile of the same harness kind retries", async () => {
    const xdgCacheHome = await temporaryXdgCacheHome()

    setup({ document: claudeDocument(), receipt: claudeLock("2.1.252"), ready: true })
    const failed = await Effect.runPromise(
      harnessVersionReport("/profiles/claude-blog/profile.toml", "linux/arm64", xdgCacheHome, {
        claude: { release: () => Effect.fail(new Error("network down")) },
      }),
    )
    expect(failed.latestKnown).toBe(false)

    setup({ document: claudeDocument(), receipt: claudeLock("2.1.251"), ready: true })
    const succeeded = await Effect.runPromise(
      harnessVersionReport("/profiles/claude-council/profile.toml", "linux/arm64", xdgCacheHome, {
        claude: fakeClaudeClient(claudeReleasePayload("2.1.259")),
      }),
    )
    expect(succeeded).toEqual({
      schemaVersion: 1,
      harness: "claude",
      installed: "2.1.251",
      latest: "2.1.259",
      latestKnown: true,
    })
  })
})
