import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { builderScript, profileMetadata } from "../src/application.js"
import { claudeDefaultSettings } from "../src/claude-materialize.js"
import type { ProfileLock } from "../src/lock.js"
import { parseProfile } from "../src/profile.js"

const profilePath = fileURLToPath(new URL("../../../profiles/claude-hyperresearch/profile.toml", import.meta.url))
const launcherPath = fileURLToPath(new URL("../../../prototypes/trellage/trellage", import.meta.url))
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url))

describe("authored Claude Hyperresearch profile", () => {
  it("starts fresh Claude homes with permission prompts bypassed", () => {
    expect(claudeDefaultSettings.permissions.defaultMode).toBe("bypassPermissions")
    expect(claudeDefaultSettings.skipDangerousModePermissionPrompt).toBe(true)
  })

  it("cites and selects the exact upstream adapter contract", async () => {
    const source = await readFile(profilePath, "utf8")

    expect(source).toContain("# Upstream project: https://github.com/jordan-gibbs/hyperresearch")
    expect(source).toContain('adapter = "hyperresearch"')
    expect(source).toContain('repository = "https://github.com/jordan-gibbs/hyperresearch.git"')
    expect(source).toContain('select = ["full"]')
  })

  it("publishes Claude-specific runtime metadata without credentials", async () => {
    const metadata = await Effect.runPromise(profileMetadata(profilePath))

    expect(metadata).toMatchObject({
      harness_kind: "claude",
      harness_executable: "claude",
      runtime_entry: "trellage-claude-entry",
      default_network: "copilot-proxy-rs_default",
      auth_policy: "claude-explicit",
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
    expect(source).toContain("ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5")
    expect(source).toContain("ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-5")
    expect(source).toContain("ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-haiku-4.5")
    expect(source.indexOf("docker container create")).toBeLessThan(source.lastIndexOf("prepare_claude_auth"))
  })

  it("builds Claude through only locked tools and contains no credential material", async () => {
    const source = await readFile(profilePath, "utf8")
    const document = await Effect.runPromise(parseProfile(source, profilePath))
    const lock: ProfileLock = {
      schema: 1,
      source_date_epoch: 1784379906,
      profile_hash: `sha256:${"a".repeat(64)}`,
      sources: [],
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
  })
})
