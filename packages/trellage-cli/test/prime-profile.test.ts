import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { profileMetadata } from "../src/application.js"
import { isPrimeProfile, parseProfile } from "../src/profile.js"

const profilePath = fileURLToPath(new URL("../../../profiles/prime-agent/profile.toml", import.meta.url))

describe("authored Prime Agent profile", () => {
  it("declares the exact proxy profile with Caveman and GitHub CLI delivery support", async () => {
    const document = await Effect.runPromise(parseProfile(await readFile(profilePath, "utf8"), profilePath))

    expect(isPrimeProfile(document.profile)).toBe(true)
    if (!isPrimeProfile(document.profile)) throw new Error("expected Prime profile")
    expect(document.profile.harness).toEqual({
      kind: "prime",
      version: "latest",
      prime: {
        provider: "copilot-proxy-rs",
        model: "claude-opus-5",
        base_url: "http://copilot-proxy-rs:8080",
        api: "anthropic-messages",
      },
    })
    expect(document.profile.image).toEqual({
      base: "node:bookworm-slim",
      shell: "fish",
      packages: ["bash", "ca-certificates", "curl", "fish", "gh", "git", "jq", "ripgrep", "zsh"],
    })
    expect(document.profile.skill_bundles).toEqual(["sandbox-common"])
    expect(document.profile.plugins).toEqual([])
    expect(document.profile.mcps).toEqual([])
    expect(document.profile.secrets).toEqual({ provider: "env", required: [] })
  })

  it("publishes declared policy without claiming local or release resolution", async () => {
    const cache = await mkdtemp(path.join(os.tmpdir(), "trellage-prime-metadata-"))
    const metadata = await Effect.runPromise(profileMetadata(profilePath, "linux/arm64", cache))

    expect(metadata).toMatchObject({
      profile_name: "prime-agent",
      platform: "linux/arm64",
      image: "trellage-profile-prime-agent-linux-arm64:locked",
      resolution_policy: "floating",
      resolution_channel: "stable",
      locally_resolved: false,
      release_lock_available: false,
      locked: false,
      harness_kind: "prime",
      harness_executable: "prime-agent",
      runtime_entry: "trellage-prime-entry",
      default_network: "copilot-proxy-rs_default",
      auth_policy: "proxy",
      prime_provider: "copilot-proxy-rs",
      prime_model: "claude-opus-5",
      prime_base_url: "http://copilot-proxy-rs:8080",
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
        testedHarnessVersion: null,
      },
      resolved_version: null,
    })
    expect(JSON.stringify(metadata)).not.toMatch(
      /ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN/,
    )
  })
})
