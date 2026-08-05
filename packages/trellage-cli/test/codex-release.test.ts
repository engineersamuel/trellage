import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { CodexReleaseError, resolveCodexRelease, type CodexReleaseClient } from "../src/codex-release.js"

const digest = "sha256:05de65ee7b6bd02038e720cc313941d5ec6794718e4261bd28fd83b93fe34d43"

const release = (overrides: Readonly<Record<string, unknown>> = {}): unknown => ({
  tag_name: "rust-v0.146.1",
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "codex-aarch64-unknown-linux-musl.tar.gz",
      browser_download_url:
        "https://github.com/openai/codex/releases/download/rust-v0.146.1/codex-aarch64-unknown-linux-musl.tar.gz",
      size: 105647055,
      digest,
    },
  ],
  ...overrides,
})

const client = (payload: unknown): CodexReleaseClient => ({
  release: () => Effect.succeed(payload),
})

describe("resolveCodexRelease", () => {
  it("resolves latest to the exact stable native arm64 release", async () => {
    await expect(Effect.runPromise(resolveCodexRelease("latest", "linux/arm64", client(release())))).resolves.toEqual({
      kind: "codex",
      selector: "latest",
      version: "0.146.1",
      url: "https://github.com/openai/codex/releases/download/rust-v0.146.1/codex-aarch64-unknown-linux-musl.tar.gz",
      size: 105647055,
      integrity: digest,
    })
  })

  it.each([
    ["a prerelease", { prerelease: true }, /stable/],
    ["a malformed tag", { tag_name: "v0.146.1" }, /tag/],
    ["a missing platform asset", { assets: [] }, /asset/],
  ] as const)("rejects %s", async (_label, overrides, message) => {
    const error = await Effect.runPromise(
      Effect.flip(resolveCodexRelease("latest", "linux/arm64", client(release(overrides)))),
    )

    expect(error).toBeInstanceOf(CodexReleaseError)
    expect(error.message).toMatch(message)
  })
})
