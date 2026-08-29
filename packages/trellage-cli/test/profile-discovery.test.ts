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

const primeProfile = `
schema = 1
name = "prime-agent"
description = "Prime Agent profile"
[harness]
kind = "prime"
version = "latest"
[harness.prime]
provider = "copilot-proxy-rs"
model = "claude-opus-5"
base_url = "http://copilot-proxy-rs:8080"
api = "anthropic-messages"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash", "gh", "git"]
`
const copilotProfile = `
schema = 1
name = "copilot-hve"
description = "Copilot profile"
[harness]
kind = "copilot"
version = "latest"
[harness.copilot]
auth = "host-or-login"
model = "gpt-5.6-sol"
[[plugins]]
adapter = "copilot-marketplace"
repository = "https://github.com/example/plugin.git"
ref = "v1"
marketplace = "example"
select = ["example"]
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash", "gh", "git"]
`

const piProfile = `
schema = 1
name = "pi-oh-my-pi"
description = "Pi profile"
[harness]
kind = "pi"
version = "latest"
[harness.pi]
implementation = "oh-my-pi"
provider = "github-copilot"
model = "gpt-5.6-terra"
auth = "host-or-login"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash", "gh", "git"]
`

const headlongProfile = `
schema = 1
name = "headlong"
description = "Headlong profile"
skill_bundles = ["sandbox-common"]
[harness]
kind = "headlong"
version = "latest"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "bash"
packages = ["bash", "gh", "git"]
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
    ).replace("schema = 1", 'schema = 1\nskill_bundles = ["sandbox-common"]')
    const document = await Effect.runPromise(parseProfile(source, "/profiles/detailed/profile.toml"))

    expect(projectProfileChoice(document)).toEqual({
      value: "/profiles/detailed/profile.toml",
      name: "detailed",
      description: "Detailed profile",
      supported_platforms: [],
      harness: { kind: "codex", version: "0.144.6", model: "gpt-5.5" },
      headlessRuntime: "codex",
      resolutionPolicy: "floating",
      skillBundles: ["sandbox-common"],
      skillsMode: "floating",
      skills: [],
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
  it("projects the Prime Agent model", async () => {
    const document = await Effect.runPromise(parseProfile(primeProfile, "/profiles/prime-agent/profile.toml"))

    expect(projectProfileChoice(document)).toMatchObject({
      name: "prime-agent",
      harness: { kind: "prime", version: "latest", model: "claude-opus-5" },
      headlessRuntime: "prime",
    })
  })
  it.each([
    ["Copilot", copilotProfile, "/profiles/copilot-hve/profile.toml", "copilot", "gpt-5.6-sol"],
    ["Pi", piProfile, "/profiles/pi-oh-my-pi/profile.toml", "pi", "gpt-5.6-terra"],
    ["Headlong", headlongProfile, "/profiles/headlong/profile.toml", "headlong", "claude-sonnet-5"],
  ])("projects the %s model", async (_label, source, profilePath, kind, expectedModel) => {
    const document = await Effect.runPromise(parseProfile(source, profilePath))

    expect(projectProfileChoice(document)).toMatchObject({
      harness: { kind, model: expectedModel },
      headlessRuntime: kind,
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

  it("projects compiler-supported development platforms without requiring release locks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-profile-platforms-"))
    const bundled = path.join(root, "profiles")
    await writeProfile(bundled, "portable", codexProfile("portable", "Portable profile"))

    const choices = await Effect.runPromise(discoverProfileChoices({ bundled }))

    expect(choices).toHaveLength(1)
    expect(choices[0]?.supported_platforms).toEqual(["linux/arm64"])
  })
})
