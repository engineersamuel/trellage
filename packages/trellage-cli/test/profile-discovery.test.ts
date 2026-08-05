import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { discoverProfileChoices, projectProfileChoice } from "../src/profile-discovery.js"
import { parseProfile } from "../src/profile.js"

const codexProfile = (name: string, description: string, model = "gpt-5.5", extra = "") => `
schema = 1
name = "${name}"
description = "${description}"
[harness]
kind = "codex"
version = "0.144.6"
[harness.codex]
model = "${model}"
reasoning_effort = "medium"
model_provider = "proxy"
[harness.codex.providers.proxy]
base_url = "http://proxy:8080/v1"
wire_api = "responses"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
${extra}
`

const writeProfile = async (root: string, directory: string, source: string): Promise<string> => {
  const profileDirectory = path.join(root, directory)
  await mkdir(profileDirectory, { recursive: true })
  const profilePath = path.join(profileDirectory, "profile.toml")
  await writeFile(profilePath, source)
  return profilePath
}

describe("profile choice projection", () => {
  it("derives harness, source, plugin, and MCP details without secret values", async () => {
    const source = codexProfile(
      "detailed",
      "Detailed profile",
      "gpt-5.5",
      `
[[skills]]
repository = "https://github.com/example/skills.git"
ref = "v1"
select = ["review"]
[[plugins]]
adapter = "codex-native"
repository = "https://github.com/example/plugins.git"
ref = "v2"
select = ["planner"]
[[mcps]]
name = "docs"
transport = "http"
url = "https://example.test/mcp"
required = true
tools = { allow = ["search"], deny = ["delete"] }
`,
    )
    const document = await Effect.runPromise(parseProfile(source, "/profiles/detailed/profile.toml"))

    expect(projectProfileChoice(document)).toEqual({
      value: "/profiles/detailed/profile.toml",
      name: "detailed",
      description: "Detailed profile",
      supported_platforms: [],
      harness: { kind: "codex", version: "0.144.6", model: "gpt-5.5" },
      skills: [
        {
          repository: "https://github.com/example/skills.git",
          ref: "v1",
          select: ["review"],
        },
      ],
      plugins: [
        {
          adapter: "codex-native",
          repository: "https://github.com/example/plugins.git",
          ref: "v2",
          select: ["planner"],
        },
      ],
      mcps: [
        {
          name: "docs",
          transport: "http",
          required: true,
          url: "https://example.test/mcp",
          tools: { allow: ["search"], deny: ["delete"] },
        },
      ],
    })
  })
})

describe("profile discovery", () => {
  it("skips invalid profiles, canonicalizes paths, and lets worktree names override bundled names", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-profile-discovery-"))
    const bundled = path.join(root, "bundled")
    const worktree = path.join(root, "worktree")
    const bundledShared = await writeProfile(bundled, "shared", codexProfile("shared", "Bundled shared", "gpt-5.5"))
    await writeProfile(bundled, "alpha", codexProfile("alpha", "Bundled alpha"))
    await writeProfile(bundled, "invalid", codexProfile("invalid", "").replace('description = ""\n', ""))
    const worktreeShared = await writeProfile(
      worktree,
      "shared-local",
      codexProfile("shared", "Worktree shared", "gpt-5.6"),
    )
    await writeProfile(worktree, "beta", codexProfile("beta", "Worktree beta"))

    const choices = await Effect.runPromise(discoverProfileChoices({ bundled, worktree }))
    const canonicalBundledShared = await realpath(bundledShared)

    expect(choices.map(({ name }) => name)).toEqual(["alpha", "beta", "shared"])
    expect(choices.find(({ name }) => name === "shared")).toMatchObject({
      value: await realpath(worktreeShared),
      description: "Worktree shared",
      harness: { model: "gpt-5.6" },
    })
    expect(choices.some(({ value }) => value === canonicalBundledShared)).toBe(false)
  })

  it("deduplicates roots and profiles by canonical path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-profile-canonical-"))
    const bundled = path.join(root, "profiles")
    const alias = path.join(root, "profiles-alias")
    await writeProfile(bundled, "only", codexProfile("only", "Only profile"))
    await symlink(bundled, alias)

    const choices = await Effect.runPromise(discoverProfileChoices({ bundled, worktree: alias }))

    expect(choices).toHaveLength(1)
    expect(choices[0]?.name).toBe("only")
  })

  it("projects one profile with its platform-lock inventory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-profile-platforms-"))
    const bundled = path.join(root, "profiles")
    const profilePath = await writeProfile(bundled, "portable", codexProfile("portable", "Portable profile"))
    await writeFile(path.join(path.dirname(profilePath), "profile.linux-arm64.lock.toml"), "")
    await writeFile(path.join(path.dirname(profilePath), "profile.linux-amd64.lock.toml"), "")

    const choices = await Effect.runPromise(discoverProfileChoices({ bundled }))

    expect(choices).toHaveLength(1)
    expect(choices[0]?.supported_platforms).toEqual(["linux/arm64", "linux/amd64"])
  })
})
