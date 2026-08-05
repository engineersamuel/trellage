import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { ClaudeReleaseError, resolveClaudeRelease, type ClaudeReleaseClient } from "../src/claude-release.js"

const digest = "sha256:68c8d31e3cf81d4e0f608900c866b8bb2f0e2645e89d0917ce8a23f2ec277587"

const release = (overrides: Readonly<Record<string, unknown>> = {}): unknown => ({
  tag_name: "v2.1.222",
  draft: false,
  prerelease: false,
  assets: [
    {
      name: "claude-linux-arm64.tar.gz",
      browser_download_url:
        "https://github.com/anthropics/claude-code/releases/download/v2.1.222/claude-linux-arm64.tar.gz",
      size: 88123930,
      digest,
    },
  ],
  ...overrides,
})

const client = (payload: unknown): ClaudeReleaseClient => ({
  release: () => Effect.succeed(payload),
})

describe("resolveClaudeRelease", () => {
  it("resolves latest to the exact stable native arm64 release", async () => {
    await expect(Effect.runPromise(resolveClaudeRelease("latest", "linux/arm64", client(release())))).resolves.toEqual({
      kind: "claude",
      selector: "latest",
      version: "2.1.222",
      url: "https://github.com/anthropics/claude-code/releases/download/v2.1.222/claude-linux-arm64.tar.gz",
      size: 88123930,
      integrity: digest,
    })
  })

  it.each([
    ["a prerelease", { prerelease: true }, /stable/],
    ["a missing platform asset", { assets: [] }, /asset/],
    [
      "an invalid digest",
      { assets: [{ ...(release() as { assets: Array<object> }).assets[0], digest: "bad" }] },
      /digest/,
    ],
  ] as const)("rejects %s", async (_label, overrides, message) => {
    const error = await Effect.runPromise(
      Effect.flip(resolveClaudeRelease("latest", "linux/arm64", client(release(overrides)))),
    )

    expect(error).toBeInstanceOf(ClaudeReleaseError)
    expect(error.message).toMatch(message)
  })
})
