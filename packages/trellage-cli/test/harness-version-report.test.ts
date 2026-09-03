import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

import type { ClaudeReleaseClient } from "../src/claude-release.js"
import type { CodexReleaseClient } from "../src/codex-release.js"
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

const fakeClaudeClient = (payload: unknown): ClaudeReleaseClient => ({ release: () => Effect.succeed(payload) })
const fakeCodexClient = (payload: unknown): CodexReleaseClient => ({ release: () => Effect.succeed(payload) })

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

  it("falls back to the release lock when no development receipt exists", async () => {
    setup({ document: claudeDocument(), release: claudeLock("2.1.100"), ready: true })

    const result = await Effect.runPromise(
      harnessVersionReport("/profiles/claude/profile.toml", "linux/arm64", "/cache", {
        claude: fakeClaudeClient(claudeReleasePayload("2.1.230")),
      }),
    )

    expect(result.installed).toBe("2.1.100")
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

    expect(result).toEqual({
      schemaVersion: 1,
      harness: "claude",
      installed: "2.1.222",
      latest: null,
      latestKnown: false,
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

    expect(result).toEqual({
      schemaVersion: 1,
      harness: "codex",
      installed: "0.146.1",
      latest: null,
      latestKnown: false,
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

  it("never resolves a latest version for a sandbox harness kind with no known release lookup", async () => {
    const claudeClient = fakeClaudeClient(claudeReleasePayload("2.1.230"))
    const codexClient = fakeCodexClient(codexReleasePayload("0.152.1"))
    const claudeSpy = vi.spyOn(claudeClient, "release")
    const codexSpy = vi.spyOn(codexClient, "release")
    setup({ document: copilotDocument(), receipt: copilotLock("1.0.82"), ready: true })

    const result = await Effect.runPromise(
      harnessVersionReport("/profiles/copilot/profile.toml", "linux/arm64", "/cache", {
        claude: claudeClient,
        codex: codexClient,
      }),
    )

    expect(result).toEqual({
      schemaVersion: 1,
      harness: "copilot",
      installed: "1.0.82",
      latest: null,
      latestKnown: false,
    })
    expect(claudeSpy).not.toHaveBeenCalled()
    expect(codexSpy).not.toHaveBeenCalled()
  })
})
