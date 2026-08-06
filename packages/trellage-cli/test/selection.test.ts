import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { selectProfilePath } from "../src/selection.js"

describe("profile precedence", () => {
  const paths = new Set([
    "/work/.harness.toml",
    "/home/.config/harness/profile.toml",
    "/repo/profiles/claude-hyperresearch/profile.toml",
    "/work/profiles/prime-agent/profile.toml",
    "/repo/profiles/prime-agent/profile.toml",
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

  it("prefers a bare profile name from the current worktree", async () => {
    await expect(Effect.runPromise(selectProfilePath({ ...base, explicit: "prime-agent" }))).resolves.toBe(
      "/work/profiles/prime-agent/profile.toml",
    )
  })

  it("resolves a bare explicit profile name from the bundled profiles directory", async () => {
    await expect(Effect.runPromise(selectProfilePath({ ...base, explicit: "claude-hyperresearch" }))).resolves.toBe(
      "/repo/profiles/claude-hyperresearch/profile.toml",
    )
  })

  it("fails a missing bare profile name with every searched path", async () => {
    await expect(Effect.runPromise(selectProfilePath({ ...base, explicit: "missing-profile" }))).rejects.toThrow(
      'profile "missing-profile" not found; searched: /work/profiles/missing-profile/profile.toml, /repo/profiles/missing-profile/profile.toml',
    )
  })

  it("preserves a GitHub blob profile reference", async () => {
    const reference = "https://github.com/engineersamuel/trellage/blob/v1.0.0/profiles/copilot-hve/profile.toml"

    await expect(Effect.runPromise(selectProfilePath({ ...base, explicit: reference }))).resolves.toBe(reference)
  })
})
