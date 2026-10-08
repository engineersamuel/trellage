import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Effect } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { loadProfile } from "../src/application.ts"

const profilePath = fileURLToPath(new URL("../../../profiles/prime-agent/profile.toml", import.meta.url))
afterEach(() => vi.unstubAllEnvs())

it("uses the explicit TOML skill policy and preserves its pin in Sandbox metadata", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trellage-skill-policy-"))
  const config = path.join(directory, "config.toml")
  try {
    await writeFile(
      config,
      `
[skills]
schema = 1
[skills.sources.custom]
repository = "https://github.com/example/skills.git"
select = ["review"]
commit = "${"a".repeat(40)}"
[skills.bundles]
sandbox-common = ["custom"]
`,
      { mode: 0o600 },
    )
    vi.stubEnv("TRELLAGE_CONFIG", config)
    const document = await Effect.runPromise(loadProfile(profilePath))
    const policy = JSON.parse(document.floatingSkillPolicy!)
    expect(policy.bundles).toEqual(["sandbox-common"])
    expect(policy.sources).toHaveLength(1)
    expect(policy.sources[0]).toEqual([
      "custom",
      expect.objectContaining({
        select: ["review"],
        commit: "a".repeat(40),
      }),
    ])
    await writeFile(config, "[environment]\nenabled = false\n")
    await expect(Effect.runPromise(loadProfile(profilePath))).rejects.toThrow("cannot read skill configuration")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
