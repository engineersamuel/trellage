import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { builderScript, profileMetadata } from "../src/application.js"
import { claudeDefaultOnboarding, claudeDefaultSettings, claudeDefaultUserSettings } from "../src/claude-materialize.js"
import type { ProfileLock } from "../src/lock.js"
import { parseProfile } from "../src/profile.js"
import { playwrightArtifacts } from "./fixtures/tool-artifacts.js"

const profilePath = fileURLToPath(new URL("../../../profiles/claude-research/profile.toml", import.meta.url))
const qwenProfilePath = fileURLToPath(new URL("../../../profiles/claude-qwen-local/profile.toml", import.meta.url))
const socialProfilePath = fileURLToPath(new URL("../../../profiles/claude-social-media/profile.toml", import.meta.url))
const graphOfLoopsProfilePath = fileURLToPath(
  new URL("../../../profiles/claude-graph-of-loops/profile.toml", import.meta.url),
)
const blogProfilePath = fileURLToPath(new URL("../../../profiles/claude-blog/profile.toml", import.meta.url))
const councilProfilePath = fileURLToPath(new URL("../../../profiles/claude-council/profile.toml", import.meta.url))
const launcherPath = fileURLToPath(new URL("../../../prototypes/trellage/trellage", import.meta.url))
const claudeEntryPath = fileURLToPath(new URL("../../../prototypes/trellage/runtime-claude-entry.sh", import.meta.url))
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

describe("authored Claude Research profile", () => {
  it("starts fresh Claude homes with permission prompts bypassed", () => {
    expect(claudeDefaultSettings.permissions.defaultMode).toBe("bypassPermissions")
    expect(claudeDefaultSettings.skipDangerousModePermissionPrompt).toBe(true)
    expect(claudeDefaultSettings).not.toHaveProperty("outputStyle")
    expect(claudeDefaultUserSettings.outputStyle).toBe("Rundown")
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
    expect(source).toContain('select = ["light"]')
    expect(source).toContain('gear = "full"')
  })

  it("uses floating common, research, and Hyperresearch sources", async () => {
    const source = await readFile(profilePath, "utf8")
    const document = await Effect.runPromise(parseProfile(source, profilePath))

    expect(document.profile.skill_bundles).toEqual(["sandbox-common", "claude-research"])
    expect(document.profile.plugins).toEqual([
      expect.objectContaining({
        adapter: "hyperresearch",
        repository: "https://github.com/jordan-gibbs/hyperresearch.git",
        ref: "main",
        select: ["light"],
      }),
    ])
  })

  it("publishes Claude-specific runtime metadata without credentials", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "trellage-claude-research-metadata-"))
    const metadata = await Effect.runPromise(profileMetadata(profilePath, "linux/arm64", cache))

    expect(metadata).toMatchObject({
      resolution_policy: "floating",
      locally_resolved: false,
      release_lock_available: false,
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
      resolved_version: null,
      headless: {
        schemaVersion: 1,
        prompt: false,
        outputFormats: ["text"],
        eventContract: null,
        trellageEventContract: null,
        sessionId: "none",
        resume: false,
        resumeWithPrompt: false,
        questionToolControl: "none",
        changedFiles: "none",
        usage: false,
        cost: false,
        modelOverride: false,
        effortOverride: false,
        testedHarnessVersion: "2.1.229",
      },
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
          select: ["light"],
          commit: "e".repeat(40),
          integrity: `sha256:${"f".repeat(64)}`,
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
        artifacts: [
          {
            name: "node",
            version: "24.8.0",
            integrity: `sha256:${"c".repeat(64)}`,
            url: "https://nodejs.org/dist/v24.8.0/node-v24.8.0-linux-arm64.tar.gz",
          },
          {
            name: "uv",
            version: "0.11.22",
            integrity: `sha256:${"d".repeat(64)}`,
            url: "https://github.com/astral-sh/uv/releases/download/0.11.22/uv-aarch64-unknown-linux-musl.tar.gz",
            size: 1,
          },
          {
            name: "python",
            version: "3.13.14",
            integrity: `sha256:${"e".repeat(64)}`,
            url: "https://example.test/python.tar.gz",
          },
          ...playwrightArtifacts,
        ],
      },
      image: { base: "node:22.17.0-bookworm-slim", base_digest: `sha256:${"c".repeat(64)}` },
    }

    const script = builderScript(document, lock)
    expect(script).toContain(
      "mise x --locked uv@0.11.22 -- uv pip install --target /src/hyperresearch-site --python-version 3.13 --python-platform aarch64-manylinux_2_28 --require-hashes --no-deps",
    )
    expect(script).toContain(
      '"$node_dir/bin/npm" install --global --prefix /src/playwright-mcp-prefix --ignore-scripts --omit=optional --offline',
    )
    expect(script).toContain("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1")
    expect(script).toContain("/src/npm-artifacts/playwright-mcp.tgz")
    expect(script).toContain('"@playwright/mcp":"0.0.78"')
    expect(script).toContain('"playwright":"1.62.0-alpha-1783623505000"')
    expect(script).toContain('"playwright-core":"1.62.0-alpha-1783623505000"')
    expect(script).toContain('require(root+name+"/package.json").version')
    expect(script).toContain("cp -R /src/hyperresearch-package/hyperresearch /src/hyperresearch-site/hyperresearch")
    expect(script).toContain("mise install --locked")
    expect(script).toContain("mise oci build --locked")
    expect(script).not.toMatch(/TOKEN|API_KEY|secret/i)
  })

  it("passes all Claude runtime assets through the CLI build boundary", async () => {
    const source = await readFile(cliPath, "utf8")

    expect(source).toContain(
      'claudeEntry: path.join(repositoryRoot, "prototypes", "trellage", "runtime-claude-entry.sh")',
    )
    expect(source).not.toContain("hyperresearchRequirements")
    expect(source).toContain("claudeBrowserAgent: path.join(")
    expect(source).toContain('"hyperresearch-browser-fetcher.md"')
    expect(source).toContain("claudeOutputStyleRundown: path.join(")
    expect(source).toContain('"rundown.md"')
    expect(source).toContain(
      'finalizeClaudeSeed: path.join(repositoryRoot, "prototypes", "trellage", "finalize-claude-seed.mjs")',
    )
  })
})

describe("authored Claude social media profile", () => {
  it("selects the attributed native marketplace plugins without an unsolicited startup prompt", async () => {
    const source = await readFile(socialProfilePath, "utf8")
    const document = await Effect.runPromise(parseProfile(source, socialProfilePath))

    expect(source).toContain("# Upstream project: https://github.com/charlie947/social-media-skills")
    expect(source).toContain("# Upstream project: https://github.com/blader/humanizer")
    expect(document.profile.plugins).toEqual([
      expect.objectContaining({
        adapter: "claude-marketplace",
        repository: "https://github.com/charlie947/social-media-skills.git",
        ref: "main",
        marketplace: "social-media-skills",
        select: ["social-media-skills"],
      }),
      expect.objectContaining({
        adapter: "claude-marketplace",
        repository: "https://github.com/blader/humanizer.git",
        ref: "main",
        marketplace: "humanizer",
        select: ["humanizer"],
      }),
    ])
    expect(document.profile.secrets.required).toEqual([])
    expect(document.resolvedInitialPrompt).toBeUndefined()
    expect(document.profile.harness.initial_prompt).toBeUndefined()
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

describe("authored Claude Blog profile", () => {
  it("routes Claude Opus 5 through copilot-proxy-rs and records the selected marketplace plugin", async () => {
    const source = await readFile(blogProfilePath, "utf8")
    const document = await Effect.runPromise(parseProfile(source, blogProfilePath))

    expect(source).toContain(
      "# Upstream project and published skill catalog: https://github.com/AgriciDaniel/claude-blog",
    )
    expect(source).toContain("# Website catalog: https://claude-blog.md/skills")
    expect(document.profile.harness.kind).toBe("claude")
    if (document.profile.harness.kind !== "claude") throw new Error("expected Claude harness")
    expect(document.profile.harness.claude).toMatchObject({
      default_auth: "proxy",
      model: "claude-opus-5",
      gateway: "http://copilot-proxy-rs:8080",
    })
    expect(document.profile.plugins).toEqual([
      expect.objectContaining({
        adapter: "claude-marketplace",
        repository: "https://github.com/AgriciDaniel/claude-blog.git",
        ref: "main",
        marketplace: "agricidaniel-blog",
        select: ["claude-blog"],
      }),
    ])
  })
})

describe("authored Claude council profile", () => {
  it("routes Claude Opus 5 through copilot-proxy-rs with Caveman always on", async () => {
    const source = await readFile(councilProfilePath, "utf8")
    const document = await Effect.runPromise(parseProfile(source, councilProfilePath))

    expect(source).toContain("# Upstream project: https://github.com/0xNyk/council-of-high-intelligence")
    expect(source).toContain("# Upstream project: https://github.com/JuliusBrussee/caveman")
    expect(document.profile.harness.kind).toBe("claude")
    if (document.profile.harness.kind !== "claude") throw new Error("expected Claude harness")
    expect(document.profile.harness.claude).toMatchObject({
      default_auth: "proxy",
      model: "claude-opus-5",
      gateway: "http://copilot-proxy-rs:8080",
    })
    expect(document.profile.skill_bundles).toEqual(["sandbox-common"])
    expect(document.profile.plugins).toEqual([
      expect.objectContaining({
        adapter: "claude-marketplace",
        repository: "https://github.com/0xNyk/council-of-high-intelligence.git",
        ref: "main",
        marketplace: "council-of-high-intelligence",
        select: ["council"],
      }),
      expect.objectContaining({
        adapter: "claude-marketplace",
        repository: "https://github.com/JuliusBrussee/caveman.git",
        ref: "main",
        marketplace: "caveman",
        select: ["caveman"],
      }),
    ])
  })
})

describe("authored Claude graph-of-loops profile", () => {
  it("cites Granite's Graph of Loops article", async () => {
    const source = await readFile(graphOfLoopsProfilePath, "utf8")

    expect(source).toContain('# Source article: Granite, "A Graph of Loops"')
    expect(source).toContain("https://x.com/granite0x/status/2080665298609328201")
  })

  it("declares an independent Codex reviewer and related floating tools", async () => {
    const source = await readFile(graphOfLoopsProfilePath, "utf8")
    const document = await Effect.runPromise(parseProfile(source, graphOfLoopsProfilePath))

    expect(document.profile.image.tools).toContainEqual({
      kind: "github-release",
      repository: "openai/codex",
      name: "codex",
    })
    expect(document.profile.image.tools).toContainEqual({
      kind: "github-release",
      repository: "Dicklesworthstone/beads_viewer",
      name: "bv",
    })
    expect(document.profile.plugins.every((plugin) => plugin.ref === "main")).toBe(true)
  })

  it("refreshes the Codex reviewer config in persistent Claude state", async () => {
    const source = await readFile(claudeEntryPath, "utf8")

    expect(source).toContain('codex_reviewer_config="${TRELLAGE_CODEX_REVIEWER_CONFIG-}"')
    expect(source).toContain('codex_home="${CODEX_HOME:-/home/agent/.codex}"')
    expect(source).toContain('cp -- "$codex_reviewer_config" "$codex_config_tmp"')
    expect(source).toContain('mv -f -- "$codex_config_tmp" "$codex_config"')
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
    const cache = await mkdtemp(path.join(os.tmpdir(), "trellage-claude-qwen-metadata-"))
    const metadata = await Effect.runPromise(profileMetadata(qwenProfilePath, "linux/arm64", cache))

    expect(metadata).toMatchObject({
      claude_mode: "core",
      claude_gateway: "http://copilot-proxy-rs:8080",
      claude_opus_model: "qwen3.6-35b-a3b-local",
      claude_sonnet_model: "qwen3.6-35b-a3b-local",
      claude_haiku_model: "qwen3.6-35b-a3b-local",
      locally_resolved: false,
      release_lock_available: false,
      resolved_version: null,
      headless: {
        outputFormats: ["text"],
        trellageEventContract: null,
        changedFiles: "none",
        modelOverride: false,
        resumeWithPrompt: false,
        eventContract: null,
        testedHarnessVersion: "2.1.229",
      },
    })
  })
})
