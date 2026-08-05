import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { assertProductionPlatform, parseDockerPlatform, platformLockPath } from "../src/platform.js"

describe("Docker server platform", () => {
  it.each([
    ["linux/aarch64", "linux/arm64"],
    ["linux/arm64", "linux/arm64"],
    ["linux/x86_64", "linux/amd64"],
    ["linux/amd64", "linux/amd64"],
  ] as const)("normalizes server architecture %s", async (reported, expected) => {
    await expect(Effect.runPromise(parseDockerPlatform(reported))).resolves.toBe(expected)
  })

  it.each(["darwin/arm64", "windows/amd64", "linux/riscv64", ""])(
    "rejects unsupported server platform %j",
    async (reported) => {
      await expect(Effect.runPromise(parseDockerPlatform(reported))).rejects.toThrow(
        /unsupported Docker server platform/,
      )
    },
  )

  it("selects sibling locks by Docker platform", () => {
    expect(platformLockPath("/profiles/copilot-hve/profile.toml", "linux/arm64")).toBe(
      "/profiles/copilot-hve/profile.linux-arm64.lock.toml",
    )
    expect(platformLockPath("/profiles/copilot-hve/profile.toml", "linux/amd64")).toBe(
      "/profiles/copilot-hve/profile.linux-amd64.lock.toml",
    )
  })

  it("recognizes AMD64 but rejects it before production work", async () => {
    await expect(Effect.runPromise(parseDockerPlatform("linux/amd64"))).resolves.toBe("linux/amd64")
    await expect(Effect.runPromise(assertProductionPlatform("linux/amd64"))).rejects.toThrow(
      /production artifacts are unavailable for linux\/amd64/,
    )
  })
})
