import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { builderScript, profileMetadata } from "../src/application.js"
import { claudeDefaultOnboarding, claudeDefaultSettings, claudeDefaultUserSettings } from "../src/claude-materialize.js"
import { parseLock } from "../src/lock-file.js"
import type { ProfileLock } from "../src/lock.js"
import { parseProfile } from "../src/profile.js"

const profilePath = fileURLToPath(new URL("../../../profiles/claude-research/profile.toml", import.meta.url))
const lockPath = fileURLToPath(
  new URL("../../../profiles/claude-research/profile.linux-arm64.lock.toml", import.meta.url),
)
const qwenProfilePath = fileURLToPath(new URL("../../../profiles/claude-qwen-local/profile.toml", import.meta.url))
const qwenLockPath = fileURLToPath(
  new URL("../../../profiles/claude-qwen-local/profile.linux-arm64.lock.toml", import.meta.url),
)
const socialProfilePath = fileURLToPath(new URL("../../../profiles/claude-social-media/profile.toml", import.meta.url))
const socialLockPath = fileURLToPath(
  new URL("../../../profiles/claude-social-media/profile.linux-arm64.lock.toml", import.meta.url),
)
const graphOfLoopsProfilePath = fileURLToPath(
  new URL("../../../profiles/claude-graph-of-loops/profile.toml", import.meta.url),
)
const graphOfLoopsLockPath = fileURLToPath(
  new URL("../../../profiles/claude-graph-of-loops/profile.linux-arm64.lock.toml", import.meta.url),
)
const blogProfilePath = fileURLToPath(new URL("../../../profiles/claude-blog/profile.toml", import.meta.url))
const blogLockPath = fileURLToPath(
  new URL("../../../profiles/claude-blog/profile.linux-arm64.lock.toml", import.meta.url),
)
const councilProfilePath = fileURLToPath(new URL("../../../profiles/claude-council/profile.toml", import.meta.url))
const councilLockPath = fileURLToPath(
  new URL("../../../profiles/claude-council/profile.linux-arm64.lock.toml", import.meta.url),
)
const launcherPath = fileURLToPath(new URL("../../../prototypes/trellage/trellage", import.meta.url))
const claudeEntryPath = fileURLToPath(new URL("../../../prototypes/trellage/runtime-claude-entry.sh", import.meta.url))
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const stableVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const commitSha = /^[0-9a-f]{40}$/

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
  })

  it("uses floating common and research skills alongside locked Hyperresearch", async () => {
    const [source, lockSource] = await Promise.all([readFile(profilePath, "utf8"), readFile(lockPath, "utf8")])
    const document = await Effect.runPromise(parseProfile(source, profilePath))
    const lock = await Effect.runPromise(parseLock(lockSource))

    expect(document.profile.skill_bundles).toEqual(["sandbox-common", "claude-research"])
    expect(lock.sources).toHaveLength(1)
    expect(lock.sources[0]).toMatchObject({
      kind: "plugin",
      adapter: "hyperresearch",
      repository: "https://github.com/jordan-gibbs/hyperresearch.git",
    })
  })

  it("publishes Claude-specific runtime metadata without credentials", async () => {
    const metadata = await Effect.runPromise(profileMetadata(profilePath, "linux/arm64"))
    const lock = await Effect.runPromise(parseLock(await readFile(lockPath, "utf8")))

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
      resolved_version: lock.packages.harness.version,
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
      },
      image: { base: "node:22.17.0-bookworm-slim", base_digest: `sha256:${"c".repeat(64)}` },
    }

    const script = builderScript(document, lock)
    expect(script).toContain(
      "mise x uv@0.11.21 -- uv pip install --target /src/hyperresearch-site --python-version 3.13 --python-platform aarch64-manylinux_2_28 --require-hashes --no-deps",
    )
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
    expect(source).toContain("hyperresearchRequirements: path.join(")
    expect(source).toContain('"hyperresearch-requirements.lock"')
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
    expect(lock.sources).toHaveLength(document.profile.plugins.length)
    const socialMediaSource = lock.sources.find(
      (candidate) => candidate.kind === "plugin" && candidate.marketplace === "social-media-skills",
    )
    expect(socialMediaSource).toMatchObject({
      adapter: "claude-marketplace",
      marketplace: "social-media-skills",
      repository: "https://github.com/charlie947/social-media-skills.git",
      select: ["social-media-skills"],
      plugin_versions: { "social-media-skills": expect.stringMatching(stableVersion) },
      commit: expect.stringMatching(commitSha),
    })
    expect(socialMediaSource?.files.some(({ path }) => path.endsWith("/SKILL.md"))).toBe(true)
    const humanizerSource = lock.sources.find(
      (candidate) => candidate.kind === "plugin" && candidate.marketplace === "humanizer",
    )
    expect(humanizerSource).toMatchObject({
      adapter: "claude-marketplace",
      marketplace: "humanizer",
      repository: "https://github.com/blader/humanizer.git",
      select: ["humanizer"],
      plugin_versions: { humanizer: expect.stringMatching(stableVersion) },
      commit: expect.stringMatching(commitSha),
    })
    expect(humanizerSource?.files.some(({ path }) => path === "SKILL.md")).toBe(true)
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

describe("authored Claude Blog profile", () => {
  it("routes Claude Opus 5 through copilot-proxy-rs and records the selected marketplace plugin", async () => {
    const [source, lockSource] = await Promise.all([readFile(blogProfilePath, "utf8"), readFile(blogLockPath, "utf8")])
    const document = await Effect.runPromise(parseProfile(source, blogProfilePath))
    const lock = await Effect.runPromise(parseLock(lockSource))

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
        marketplace: "agricidaniel-blog",
        select: ["claude-blog"],
      }),
    ])
    expect(lock.sources).toHaveLength(document.profile.plugins.length)
    const blogSource = lock.sources.find(
      (candidate) => candidate.kind === "plugin" && candidate.marketplace === "agricidaniel-blog",
    )
    expect(blogSource).toMatchObject({
      adapter: "claude-marketplace",
      marketplace: "agricidaniel-blog",
      repository: "https://github.com/AgriciDaniel/claude-blog.git",
      select: ["claude-blog"],
      plugin_versions: { "claude-blog": expect.stringMatching(stableVersion) },
      commit: expect.stringMatching(commitSha),
    })
    expect(blogSource?.files.some(({ path }) => /^skills\/[^/]+\/SKILL\.md$/.test(path))).toBe(true)
  })
})

describe("authored Claude council profile", () => {
  it("routes Claude Opus 5 through copilot-proxy-rs with Caveman always on", async () => {
    const [source, lockSource] = await Promise.all([
      readFile(councilProfilePath, "utf8"),
      readFile(councilLockPath, "utf8"),
    ])
    const document = await Effect.runPromise(parseProfile(source, councilProfilePath))
    const lock = await Effect.runPromise(parseLock(lockSource))

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
        ref: expect.stringMatching(/^v\d+\.\d+\.\d+$/),
        marketplace: "council-of-high-intelligence",
        select: ["council"],
      }),
      expect.objectContaining({
        adapter: "claude-marketplace",
        repository: "https://github.com/JuliusBrussee/caveman.git",
        ref: expect.stringMatching(/^v\d+\.\d+\.\d+$/),
        marketplace: "caveman",
        select: ["caveman"],
      }),
    ])
    expect(lock.sources).toHaveLength(document.profile.plugins.length)
    const councilSource = lock.sources.find(
      (candidate) => candidate.kind === "plugin" && candidate.marketplace === "council-of-high-intelligence",
    )
    expect(councilSource).toMatchObject({
      adapter: "claude-marketplace",
      marketplace: "council-of-high-intelligence",
      repository: "https://github.com/0xNyk/council-of-high-intelligence.git",
      ref: document.profile.plugins[0]?.ref,
      select: ["council"],
      plugin_versions: { council: expect.stringMatching(stableVersion) },
      commit: expect.stringMatching(commitSha),
    })
    expect(
      councilSource?.files.some((file) => file.kind === "symlink" && file.path === "skills/council/SKILL.md"),
    ).toBe(true)
    const cavemanPluginSource = lock.sources.find(
      (candidate) => candidate.kind === "plugin" && candidate.marketplace === "caveman",
    )
    expect(cavemanPluginSource).toMatchObject({
      adapter: "claude-marketplace",
      marketplace: "caveman",
      repository: "https://github.com/JuliusBrussee/caveman.git",
      ref: document.profile.plugins[1]?.ref,
      select: ["caveman"],
      plugin_versions: { caveman: expect.stringMatching(stableVersion) },
      commit: expect.stringMatching(commitSha),
    })
    expect(lock.packages.artifacts?.map(({ name }) => name)).toEqual(["node", "builder-oci", "skopeo-oci"])
  })
})

describe("authored Claude graph-of-loops profile", () => {
  it("cites Granite's Graph of Loops article", async () => {
    const source = await readFile(graphOfLoopsProfilePath, "utf8")

    expect(source).toContain('# Source article: Granite, "A Graph of Loops"')
    expect(source).toContain("https://x.com/granite0x/status/2080665298609328201")
  })

  it("pins an independent Codex reviewer configured for copilot-proxy-rs", async () => {
    const [source, lockSource] = await Promise.all([
      readFile(graphOfLoopsProfilePath, "utf8"),
      readFile(graphOfLoopsLockPath, "utf8"),
    ])
    const document = await Effect.runPromise(parseProfile(source, graphOfLoopsProfilePath))
    const lock = await Effect.runPromise(parseLock(lockSource))

    expect(document.profile.image.tools).toContainEqual({
      kind: "github-release",
      repository: "openai/codex",
      name: "codex",
    })
    expect(lock.packages.artifacts).toContainEqual(
      expect.objectContaining({
        name: "bv",
        version: "0.22.0",
        url: "https://github.com/Dicklesworthstone/beads_viewer/releases/download/v0.22.0/bv_linux_arm64.tar.gz",
      }),
    )
    expect(lock.packages.artifacts).toContainEqual(
      expect.objectContaining({
        name: "codex",
        version: "0.149.1",
        url: "https://github.com/openai/codex/releases/download/rust-v0.149.1/codex-aarch64-unknown-linux-musl.tar.gz",
      }),
    )
    expect(lock.packages.artifacts).toContainEqual(
      expect.objectContaining({
        name: "codex-code-mode-host",
        version: "0.149.1",
        url: "https://github.com/openai/codex/releases/download/rust-v0.149.1/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
      }),
    )
    expect(lock.packages.artifacts).toContainEqual(
      expect.objectContaining({
        name: "lefthook-linux-arm64",
        version: "2.1.10",
      }),
    )
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
    const metadata = await Effect.runPromise(profileMetadata(qwenProfilePath, "linux/arm64"))
    const lock = await Effect.runPromise(parseLock(await readFile(qwenLockPath, "utf8")))

    expect(metadata).toMatchObject({
      claude_mode: "core",
      claude_gateway: "http://copilot-proxy-rs:8080",
      claude_opus_model: "qwen3.6-35b-a3b-local",
      claude_sonnet_model: "qwen3.6-35b-a3b-local",
      claude_haiku_model: "qwen3.6-35b-a3b-local",
      resolved_version: lock.packages.harness.version,
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
