import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { builderScript, profileMetadata } from "../src/application.js"
import { claudeDefaultOnboarding, claudeDefaultSettings } from "../src/claude-materialize.js"
import { parseLock } from "../src/lock-file.js"
import type { ProfileLock } from "../src/lock.js"
import { parseProfile } from "../src/profile.js"

const profilePath = fileURLToPath(new URL("../../../profiles/claude-hyperresearch/profile.toml", import.meta.url))
const qwenProfilePath = fileURLToPath(new URL("../../../profiles/claude-qwen-local/profile.toml", import.meta.url))
const socialProfilePath = fileURLToPath(new URL("../../../profiles/claude-social-media/profile.toml", import.meta.url))
const socialLockPath = fileURLToPath(
  new URL("../../../profiles/claude-social-media/profile.linux-arm64.lock.toml", import.meta.url),
)
const launcherPath = fileURLToPath(new URL("../../../prototypes/trellage/trellage", import.meta.url))
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

describe("authored Claude Hyperresearch profile", () => {
  it("starts fresh Claude homes with permission prompts bypassed", () => {
    expect(claudeDefaultSettings.permissions.defaultMode).toBe("bypassPermissions")
    expect(claudeDefaultSettings.skipDangerousModePermissionPrompt).toBe(true)
    expect(claudeDefaultOnboarding("2.1.222")).toEqual({
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.222",
      theme: "dark",
      shiftEnterKeyBindingInstalled: true,
    })
  })

  it("cites and selects the exact upstream adapter contract", async () => {
    const source = await readFile(profilePath, "utf8")

    expect(source).toContain("# Upstream project: https://github.com/jordan-gibbs/hyperresearch")
    expect(source).toContain('adapter = "hyperresearch"')
    expect(source).toContain('repository = "https://github.com/jordan-gibbs/hyperresearch.git"')
    expect(source).toContain('select = ["full"]')
  })

  it("publishes Claude-specific runtime metadata without credentials", async () => {
    const metadata = await Effect.runPromise(profileMetadata(profilePath, "linux/arm64"))

    expect(metadata).toMatchObject({
      harness_kind: "claude",
      harness_executable: "claude",
      runtime_entry: "trellage-claude-entry",
      default_network: "copilot-proxy-rs_default",
      auth_policy: "claude-explicit",
      claude_mode: "hyperresearch",
      claude_gateway: "http://copilot-proxy-rs:8080",
      claude_opus_model: "claude-opus-5",
      claude_sonnet_model: "claude-sonnet-5",
      claude_haiku_model: "claude-haiku-4.5",
    })
    expect(JSON.stringify(metadata)).not.toMatch(/TOKEN|API_KEY|secret value/i)
  })

  it("keeps Claude auth and browser credentials out of container creation and injects them only at final exec", async () => {
    const source = await readFile(launcherPath, "utf8")

    expect(source).toContain("--auth-mode")
    expect(source).toContain("--auth-mode is supported only for Claude profiles")
    expect(source).toContain("ambient_claude_code_oauth_token")
    expect(source).toContain("ambient_anthropic_api_key")
    expect(source).toContain("ambient_playwright_mcp_extension_token")
    expect(source).toContain("prepare_claude_auth")
    expect(source).toContain("claude_gateway")
    expect(source).toContain("claude_opus_model")
    expect(source).toContain("claude_sonnet_model")
    expect(source).toContain("claude_haiku_model")
    expect(source).toContain('ANTHROPIC_BASE_URL="$claude_gateway"')
    expect(source).toContain('ANTHROPIC_DEFAULT_OPUS_MODEL="$claude_opus_model"')
    expect(source).toContain('ANTHROPIC_DEFAULT_SONNET_MODEL="$claude_sonnet_model"')
    expect(source).toContain('ANTHROPIC_DEFAULT_HAIKU_MODEL="$claude_haiku_model"')
    expect(source).not.toContain("ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5")
    expect(source.indexOf("docker container create")).toBeLessThan(source.lastIndexOf("prepare_claude_auth"))
  })

  it("builds Claude through only locked tools and contains no credential material", async () => {
    const source = await readFile(profilePath, "utf8")
    const document = await Effect.runPromise(parseProfile(source, profilePath))
    const lock: ProfileLock = {
      schema: 1,
      platform: "linux/arm64",
      source_date_epoch: 1784379906,
      profile_hash: `sha256:${"a".repeat(64)}`,
      sources: [
        {
          kind: "plugin",
          adapter: "hyperresearch",
          repository: "https://github.com/jordan-gibbs/hyperresearch.git",
          ref: "main",
          select: ["full"],
          commit: "d".repeat(40),
          integrity: `sha256:${"e".repeat(64)}`,
          files: [],
        },
      ],
      packages: {
        harness: {
          kind: "claude",
          selector: "2.1.218",
          version: "2.1.218",
          integrity: `sha256:${"b".repeat(64)}`,
          url: "https://example.test/claude.tgz",
          size: 1,
        },
        runtime: [],
      },
      image: { base: "node:22.17.0-bookworm-slim", base_digest: `sha256:${"c".repeat(64)}` },
    }

    const script = builderScript(document, lock)
    expect(script).toContain("mise install --locked")
    expect(script).toContain("mise oci build --locked")
    expect(script).not.toMatch(/TOKEN|API_KEY|secret/i)
  })

  it("passes all Claude runtime assets through the CLI build boundary", async () => {
    const source = await readFile(cliPath, "utf8")

    expect(source).toContain(
      'claudeEntry: path.join(repositoryRoot, "prototypes", "trellage", "runtime-claude-entry.sh")',
    )
    expect(source).toContain("hyperresearchRequirements: path.join(")
    expect(source).toContain('"hyperresearch-requirements.lock"')
    expect(source).toContain("claudeBrowserAgent: path.join(")
    expect(source).toContain('"hyperresearch-browser-fetcher.md"')
    expect(source).toContain(
      'finalizeClaudeSeed: path.join(repositoryRoot, "prototypes", "trellage", "finalize-claude-seed.mjs")',
    )
  })
})

describe("authored Claude social media profile", () => {
  it("selects the attributed native marketplace plugins without an unsolicited startup prompt", async () => {
    const [source, lockSource] = await Promise.all([
      readFile(socialProfilePath, "utf8"),
      readFile(socialLockPath, "utf8"),
    ])
    const document = await Effect.runPromise(parseProfile(source, socialProfilePath))
    const lock = await Effect.runPromise(parseLock(lockSource))

    expect(source).toContain("# Upstream project: https://github.com/charlie947/social-media-skills")
    expect(source).toContain("# Upstream project: https://github.com/blader/humanizer")
    expect(document.profile.plugins).toEqual([
      expect.objectContaining({
        adapter: "claude-marketplace",
        marketplace: "social-media-skills",
        select: ["social-media-skills"],
      }),
      expect.objectContaining({
        adapter: "claude-marketplace",
        marketplace: "humanizer",
        select: ["humanizer"],
      }),
    ])
    expect(document.profile.secrets.required).toEqual([])
    expect(document.resolvedInitialPrompt).toBeUndefined()
    expect(document.profile.harness.initial_prompt).toBeUndefined()
    expect(lock.sources[0]).toMatchObject({
      adapter: "claude-marketplace",
      marketplace: "social-media-skills",
      plugin_versions: { "social-media-skills": "1.0.0" },
      commit: "94f72ea2ece388fa30ef49a26fb2e6fd2109e0b1",
    })
    expect(lock.sources[0]?.files.filter(({ path }) => path.endsWith("/SKILL.md"))).toHaveLength(17)
    expect(lock.sources[1]).toMatchObject({
      adapter: "claude-marketplace",
      marketplace: "humanizer",
      plugin_versions: { humanizer: "2.9.1" },
      commit: "523374dee72d67c7b2b5f858ea0094ffda49c3ac",
    })
    expect(lock.sources[1]?.files.filter(({ path }) => path === "SKILL.md")).toHaveLength(1)
    expect(lock.packages.artifacts?.map(({ name }) => name)).toEqual(["node", "builder-oci", "skopeo-oci"])
  })

  it("forwards optional integration variables only to final Claude execution", async () => {
    const source = await readFile(launcherPath, "utf8")

    expect(source).toContain('ambient_apify_api_token="${APIFY_API_TOKEN-}"')
    expect(source).toContain('ambient_google_ai_api_key="${GOOGLE_AI_API_KEY-}"')
    expect(source).toContain("claude_auth_args+=(--env APIFY_API_TOKEN)")
    expect(source).toContain("claude_auth_args+=(--env GOOGLE_AI_API_KEY)")
    const createBlock = source.slice(source.indexOf("docker container create"), source.indexOf("terminal_args=("))
    expect(createBlock).not.toMatch(/APIFY_API_TOKEN|GOOGLE_AI_API_KEY/)
    expect(source).toContain('${claude_auth_args[@]+"${claude_auth_args[@]}"}')
  })
})

describe("authored standalone Claude Qwen profile", () => {
  it("declares a source-free core profile without Python or browser tooling", async () => {
    const source = await readFile(qwenProfilePath, "utf8")

    expect(source).toContain('name = "claude-qwen-local"')
    expect(source).toContain('mode = "core"')
    expect(source).toContain('model = "qwen3.6-35b-a3b-local"')
    expect(source).not.toMatch(/\[\[plugins\]\]|\[\[mcps\]\]|python|playwright|chromium|obscura/i)
  })

  it("publishes the exact local gateway and Qwen alias routes", async () => {
    const metadata = await Effect.runPromise(profileMetadata(qwenProfilePath, "linux/arm64"))

    expect(metadata).toMatchObject({
      claude_mode: "core",
      claude_gateway: "http://copilot-proxy-rs:8080",
      claude_opus_model: "qwen3.6-35b-a3b-local",
      claude_sonnet_model: "qwen3.6-35b-a3b-local",
      claude_haiku_model: "qwen3.6-35b-a3b-local",
    })
  })
})
