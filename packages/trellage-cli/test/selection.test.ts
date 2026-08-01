import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { selectProfilePath } from "../src/selection.js"

describe("profile precedence", () => {
  const paths = new Set([
    "/work/.harness.toml",
    "/home/.config/harness/profile.toml",
    "/repo/profiles/claude-hyperresearch/profile.toml",
  ])
  const exists = (candidate: string) => Effect.succeed(paths.has(candidate))
  const base = {
    cwd: "/work/subdir",
    worktree: "/work",
    home: "/home",
    bundled: "/bundle/profile.toml",
    profiles: "/repo/profiles",
    exists,
  }

  it("prefers flag, environment, worktree, user default, then bundled", async () => {
    await expect(
      Effect.runPromise(selectProfilePath({ ...base, explicit: "flag.toml", environment: "env.toml" })),
    ).resolves.toBe("/work/subdir/flag.toml")
    await expect(Effect.runPromise(selectProfilePath({ ...base, environment: "env.toml" }))).resolves.toBe(
      "/work/subdir/env.toml",
    )
    await expect(Effect.runPromise(selectProfilePath(base))).resolves.toBe("/work/.harness.toml")
    paths.delete("/work/.harness.toml")
    await expect(Effect.runPromise(selectProfilePath(base))).resolves.toBe("/home/.config/harness/profile.toml")
    paths.delete("/home/.config/harness/profile.toml")
    await expect(Effect.runPromise(selectProfilePath(base))).resolves.toBe("/bundle/profile.toml")
  })

  it("resolves a bare explicit profile name from the bundled profiles directory", async () => {
    await expect(Effect.runPromise(selectProfilePath({ ...base, explicit: "claude-hyperresearch" }))).resolves.toBe(
      "/repo/profiles/claude-hyperresearch/profile.toml",
    )
  })

  it("fails a missing bare profile name with the exact searched path", async () => {
    await expect(Effect.runPromise(selectProfilePath({ ...base, explicit: "missing-profile" }))).rejects.toThrow(
      'profile "missing-profile" not found; searched: /repo/profiles/missing-profile/profile.toml',
    )
  })
})
