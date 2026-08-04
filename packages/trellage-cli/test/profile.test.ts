import { mkdtemp, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { profileHash } from "../src/lock.js"
import { isClaudeProfile, isCodexProfile, isCopilotProfile, parseProfile } from "../src/profile.js"

const profile = (extra = "") => `
schema = 1
name = "codex-superpowers"
description = "Codex test profile"

[harness]
kind = "codex"
version = "0.144.6"
args = ["--dangerously-bypass-approvals-and-sandbox"]

[harness.codex]
model = "gpt-5.5"
reasoning_effort = "medium"
model_provider = "copilot_proxy"

[harness.codex.providers.copilot_proxy]
base_url = "http://copilot-proxy-rs:8080/v1"
wire_api = "responses"

[image]
platform = "linux/arm64"
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash", "fish", "git"]

[secrets]
provider = "env"
required = ["DOCS_TOKEN"]

${extra}
`

const copilotPlugin = `[[plugins]]
adapter = "copilot-marketplace"
repository = "https://github.com/microsoft/hve-core.git"
ref = "main"
marketplace = "hve-core"
select = ["hve-core"]
`

const copilotProfile = (extra = "") => `
schema = 1
name = "copilot-hve"
description = "Copilot test profile"
[harness]
kind = "copilot"
version = "latest"
args = ["--allow-all"]
[harness.copilot]
auth = "host-or-login"
[image]
platform = "linux/arm64"
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash", "fish", "git", "jq"]
${copilotPlugin}
${extra}
`

const claudeProfile = (extra = "") => `
schema = 1
name = "claude-hyperresearch"
description = "Claude test profile"
[harness]
kind = "claude"
version = "2.1.218"
[harness.claude]
default_auth = "proxy"
model = "claude-opus-5"
gateway = "http://copilot-proxy-rs:8080"
[image]
platform = "linux/arm64"
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash", "ca-certificates", "curl", "git", "jq"]
[[plugins]]
adapter = "hyperresearch"
repository = "https://github.com/jordan-gibbs/hyperresearch.git"
ref = "main"
select = ["full"]
${extra}
`

const decode = (source: string) => Effect.runPromise(parseProfile(source, "/profiles/example/profile.toml"))

describe("parseProfile", () => {
  it.each([
    ["missing", profile().replace('description = "Codex test profile"\n', "")],
    ["empty", profile().replace('description = "Codex test profile"', 'description = ""')],
  ])("rejects a %s profile description", async (_label, input) => {
    await expect(decode(input)).rejects.toThrow(/description|length/i)
  })

  it("decodes a strict Codex profile", async () => {
    const result = await decode(profile())

    expect(result.profile.name).toBe("codex-superpowers")
    expect(isCodexProfile(result.profile)).toBe(true)
    if (!isCodexProfile(result.profile)) throw new Error("expected Codex profile")
    expect(result.profile.harness.codex.providers.copilot_proxy?.wire_api).toBe("responses")
    expect(result.directory).toBe("/profiles/example")
  })

  it("defaults the runtime tmpfs size", async () => {
    const result = await decode(profile())

    expect(result.profile.runtime).toEqual({ tmpfs_size: "256m" })
  })

  it("decodes an explicit runtime tmpfs size", async () => {
    const result = await decode(claudeProfile('[runtime]\ntmpfs_size = "2g"'))

    expect(result.profile.runtime).toEqual({ tmpfs_size: "2g" })
  })

  it.each(["0m", "256", "2G", "1.5g", "2g,exec", "-1g"])("rejects invalid runtime tmpfs size %s", async (tmpfsSize) => {
    await expect(decode(profile(`[runtime]\ntmpfs_size = "${tmpfsSize}"`))).rejects.toThrow(/tmpfs_size|pattern/i)
  })

  it("rejects unknown runtime fields", async () => {
    await expect(decode(profile('[runtime]\ntmpfs_size = "256m"\nunexpected = true'))).rejects.toThrow(/unexpected/)
  })

  it("decodes the Copilot HVE profile", async () => {
    const result = await decode(copilotProfile())

    expect(result.profile.harness.kind).toBe("copilot")
    expect(isCopilotProfile(result.profile)).toBe(true)
    if (!isCopilotProfile(result.profile)) throw new Error("expected Copilot profile")
    expect(result.profile.harness.copilot.auth).toBe("host-or-login")
    expect(result.profile.plugins[0]).toMatchObject({
      adapter: "copilot-marketplace",
      marketplace: "hve-core",
      select: ["hve-core"],
    })
  })

  it("decodes a strict Claude Hyperresearch profile", async () => {
    const result = await decode(claudeProfile())

    expect(isClaudeProfile(result.profile)).toBe(true)
    if (!isClaudeProfile(result.profile)) throw new Error("expected Claude profile")
    expect(result.profile.harness.claude).toEqual({
      default_auth: "proxy",
      model: "claude-opus-5",
      gateway: "http://copilot-proxy-rs:8080",
    })
    expect(result.profile.plugins).toEqual([
      expect.objectContaining({
        adapter: "hyperresearch",
        select: ["full"],
      }),
    ])
  })

  it.each([
    ["wrong adapter", claudeProfile().replace('adapter = "hyperresearch"', 'adapter = "codex-native"')],
    ["wrong gear", claudeProfile().replace('select = ["full"]', 'select = ["light"]')],
    [
      "two plugins",
      claudeProfile(
        `[[plugins]]\nadapter = "hyperresearch"\nrepository = "https://github.com/jordan-gibbs/hyperresearch.git"\nref = "main"\nselect = ["full"]`,
      ),
    ],
    ["wrong repository", claudeProfile().replace("jordan-gibbs/hyperresearch", "example/hyperresearch")],
  ])("rejects unsupported Claude Hyperresearch shape: %s", async (_label, input) => {
    await expect(decode(input)).rejects.toThrow(/Claude|Hyperresearch|adapter|plugin/i)
  })

  it("rejects Claude-only sections on Codex", async () => {
    await expect(
      decode(profile('[harness.claude]\ndefault_auth = "proxy"\nmodel = "claude-opus-5"\ngateway = "http://proxy"')),
    ).rejects.toThrow(/claude/i)
  })

  it.each([
    ["Codex section", '[harness.codex]\nmodel = "gpt-5.5"'],
    [
      "standalone skills",
      '[[skills]]\nrepository = "https://github.com/example/skills.git"\nref = "main"\nselect = ["one"]',
    ],
    ["MCPs", '[[mcps]]\nname = "docs"\ntransport = "http"\nurl = "https://example.test/mcp"'],
    ["declared secrets", '[secrets]\nprovider = "env"\nrequired = ["TOKEN"]'],
  ])("rejects Copilot profiles with unsupported %s", async (_label, extra) => {
    await expect(decode(copilotProfile(extra))).rejects.toThrow()
  })

  it.each([
    ["standalone skills", "skills = []", /standalone skills/i],
    ["MCPs", "mcps = []", /do not support MCPs/i],
    ["declared secrets", '[secrets]\nprovider = "env"\nrequired = []', /declared secrets/i],
  ])("rejects an explicitly empty Copilot %s section", async (_label, declaration, error) => {
    const input = copilotProfile().replace('name = "copilot-hve"', `name = "copilot-hve"\n${declaration}`)

    await expect(decode(input)).rejects.toThrow(error)
  })

  it("rejects adapters used with the wrong harness kind", async () => {
    await expect(decode(copilotProfile().replace("copilot-marketplace", "codex-native"))).rejects.toThrow(
      /adapter.*copilot/i,
    )
  })

  it.each(["preview", "1.2", "v1.2.3"])("rejects invalid Copilot version %s", async (version) => {
    await expect(decode(copilotProfile().replace('version = "latest"', `version = "${version}"`))).rejects.toThrow(
      /Copilot version/i,
    )
  })

  it("accepts an exact Copilot version", async () => {
    const result = await decode(copilotProfile().replace('version = "latest"', 'version = "1.2.3"'))

    expect(result.profile.harness.version).toBe("1.2.3")
  })

  it("rejects unsupported Copilot auth", async () => {
    await expect(decode(copilotProfile().replace('auth = "host-or-login"', 'auth = "token"'))).rejects.toThrow(/auth/)
  })

  it("rejects a Copilot section in a Codex profile", async () => {
    await expect(decode(profile('[harness.copilot]\nauth = "host-or-login"'))).rejects.toThrow(/copilot/i)
  })

  it.each([
    ["zero plugins", copilotProfile().replace(copilotPlugin, ""), /exactly one marketplace plugin/i],
    ["two marketplace plugins", copilotProfile(copilotPlugin), /exactly one marketplace plugin/i],
    ["empty select", copilotProfile().replace('select = ["hve-core"]', "select = []"), /exactly one plugin selection/i],
    [
      "duplicate select",
      copilotProfile().replace('select = ["hve-core"]', 'select = ["hve-core", "hve-core"]'),
      /duplicate selected asset: hve-core/i,
    ],
  ])("enforces Copilot marketplace boundary: %s", async (_label, input, error) => {
    await expect(decode(input)).rejects.toThrow(error)
  })

  it("rejects Copilot adapters in Codex profiles", async () => {
    await expect(
      decode(
        profile(`
[[plugins]]
adapter = "copilot-marketplace"
repository = "https://github.com/microsoft/hve-core.git"
ref = "main"
marketplace = "hve-core"
select = ["hve-core"]
`),
      ),
    ).rejects.toThrow(/adapter.*copilot/i)
  })

  it("rejects unknown fields", async () => {
    await expect(decode(profile("unexpected = true"))).rejects.toThrow(/unexpected/)
  })

  it("rejects duplicate TOML keys", async () => {
    await expect(decode(profile().replace("schema = 1", "schema = 1\nschema = 1"))).rejects.toThrow(/duplicate/i)
  })

  it("rejects profile-relative path escape", async () => {
    await expect(
      decode(
        profile().replace(
          'args = ["--dangerously-bypass-approvals-and-sandbox"]',
          'args = ["--dangerously-bypass-approvals-and-sandbox"]\ninitial_prompt = "../prompt.md"',
        ),
      ),
    ).rejects.toThrow(/escapes profile directory/)
  })

  it("rejects unsupported plugin adapters", async () => {
    await expect(
      decode(
        profile(`
[[plugins]]
adapter = "unknown"
repository = "https://github.com/example/plugin.git"
ref = "main"
select = ["one"]
`),
      ),
    ).rejects.toThrow(/adapter/)
  })

  it("rejects credential-bearing GitHub repository URLs", async () => {
    await expect(
      decode(
        profile(`
[[skills]]
repository = "https://token@github.com/example/skills.git"
ref = "v1"
select = ["one"]
`),
      ),
    ).rejects.toThrow(/credential/i)
  })

  it("rejects unsafe selected asset paths", async () => {
    await expect(
      decode(
        profile(`
[[skills]]
repository = "https://github.com/example/skills.git"
ref = "v1"
select = ["../outside"]
`),
      ),
    ).rejects.toThrow(/unsafe selected asset/)
  })

  it("rejects duplicate MCP names", async () => {
    await expect(
      decode(
        profile(`
[[mcps]]
name = "docs"
transport = "http"
url = "https://example.test/mcp"

[[mcps]]
name = "docs"
transport = "stdio"
command = "docs-mcp"
`),
      ),
    ).rejects.toThrow(/duplicate MCP name: docs/)
  })

  it("rejects transport-incompatible MCP fields", async () => {
    await expect(
      decode(
        profile(`
[[mcps]]
name = "docs"
transport = "http"
url = "https://example.test/mcp"
command = "docs-mcp"
`),
      ),
    ).rejects.toThrow(/command/)
  })

  it("rejects undeclared MCP secret references", async () => {
    await expect(
      decode(
        profile(`
[[mcps]]
name = "docs"
transport = "http"
url = "https://example.test/mcp"
bearer_token_env = "OTHER_TOKEN"
`),
      ),
    ).rejects.toThrow(/undeclared secret reference: OTHER_TOKEN/)
  })

  it("rejects a profile-relative symlink that escapes the profile directory", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-profile-path-"))
    const profileDirectory = path.join(root, "profile")
    await import("node:fs/promises").then(({ mkdir }) => mkdir(profileDirectory))
    const outside = path.join(root, "outside.md")
    await writeFile(outside, "outside\n")
    await symlink(outside, path.join(profileDirectory, "prompt.md"))
    const input = profile().replace(
      'args = ["--dangerously-bypass-approvals-and-sandbox"]',
      'args = ["--dangerously-bypass-approvals-and-sandbox"]\ninitial_prompt = "./prompt.md"',
    )

    await expect(Effect.runPromise(parseProfile(input, path.join(profileDirectory, "profile.toml")))).rejects.toThrow(
      /escapes profile directory/,
    )
  })

  it("changes the profile hash when the referenced initial prompt changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-profile-prompt-"))
    const prompt = path.join(root, "prompt.md")
    const input = profile().replace(
      'args = ["--dangerously-bypass-approvals-and-sandbox"]',
      'args = ["--dangerously-bypass-approvals-and-sandbox"]\ninitial_prompt = "./prompt.md"',
    )
    await writeFile(prompt, "first\n")
    const first = await Effect.runPromise(parseProfile(input, path.join(root, "profile.toml")))
    await writeFile(prompt, "second\n")
    const second = await Effect.runPromise(parseProfile(input, path.join(root, "profile.toml")))

    expect(profileHash(first)).not.toBe(profileHash(second))
  })

  it("supports native and compatibility plugins plus stdio and HTTP MCPs", async () => {
    const result = await decode(
      profile(`
[[plugins]]
adapter = "codex-native"
repository = "https://github.com/example/native.git"
ref = "v1"
select = ["native"]

[[plugins]]
adapter = "wshobson-agents"
repository = "https://github.com/wshobson/agents.git"
ref = "abc123"
select = ["full-stack-orchestration"]

[[mcps]]
name = "local"
transport = "stdio"
command = "local-mcp"
args = ["serve"]
env = { MODE = "safe" }
env_from_secret = { TOKEN = "DOCS_TOKEN" }
tools = { allow = ["search"], deny = ["delete"] }

[[mcps]]
name = "docs"
transport = "http"
url = "https://example.test/mcp"
required = true
headers = { "X-Mode" = "safe" }
headers_from_secret = { Authorization = "DOCS_TOKEN" }
`),
    )

    expect(result.profile.plugins).toHaveLength(2)
    expect(result.profile.mcps).toHaveLength(2)
  })
})
