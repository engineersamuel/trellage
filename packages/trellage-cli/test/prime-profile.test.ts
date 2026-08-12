import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { profileMetadata } from "../src/application.js"
import { parseLock } from "../src/lock-file.js"
import { lockIsReady, profileHash } from "../src/lock.js"
import { isPrimeProfile, parseProfile } from "../src/profile.js"

const profilePath = fileURLToPath(new URL("../../../profiles/prime-agent/profile.toml", import.meta.url))
const lockPath = fileURLToPath(new URL("../../../profiles/prime-agent/profile.linux-arm64.lock.toml", import.meta.url))

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
      base: "node:22.17.0-bookworm-slim",
      shell: "fish",
      packages: ["bash", "ca-certificates", "curl", "fish", "gh", "git", "jq", "ripgrep", "zsh"],
    })
    expect(document.profile.skills).toEqual([
      {
        repository: "https://github.com/JuliusBrussee/caveman.git",
        ref: "v1.10.0",
        select: ["caveman"],
        always_on: true,
      },
      {
        repository: "https://github.com/mattpocock/skills.git",
        ref: "v1.2.3",
        select: ["grill-with-docs", "improve-codebase-architecture"],
        always_on: true,
      },
    ])
    expect(document.profile.plugins).toEqual([])
    expect(document.profile.mcps).toEqual([])
    expect(document.profile.secrets).toEqual({ provider: "env", required: [] })
  })

  it("accepts the generated Linux arm64 lock as complete and deterministic", async () => {
    const [profileSource, lockSource] = await Promise.all([readFile(profilePath, "utf8"), readFile(lockPath, "utf8")])
    const document = await Effect.runPromise(parseProfile(profileSource, profilePath))
    const lock = await Effect.runPromise(parseLock(lockSource))

    expect(lock.platform).toBe("linux/arm64")
    expect(lock.profile_hash).toBe(profileHash(document))
    expect(lock.sources).toHaveLength(2)
    expect(lock.sources[0]).toMatchObject({
      kind: "skill",
      repository: "https://github.com/JuliusBrussee/caveman.git",
      ref: "v1.10.0",
      select: ["caveman"],
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      integrity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(lock.sources[0]?.files).toContainEqual({
      kind: "file",
      path: "skills/caveman/SKILL.md",
      sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(lock.sources[1]).toMatchObject({
      kind: "skill",
      repository: "https://github.com/mattpocock/skills.git",
      ref: "v1.2.3",
      select: ["grill-with-docs", "improve-codebase-architecture"],
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      integrity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(lock.sources[1]?.files).toContainEqual({
      kind: "file",
      path: "skills/engineering/grill-with-docs/SKILL.md",
      sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(lock.sources[1]?.files).toContainEqual({
      kind: "file",
      path: "skills/engineering/improve-codebase-architecture/SKILL.md",
      sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    })
    expect(lock.packages.skills_cli_version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(lock.packages.skills_cli_integrity).toMatch(/^sha512-/)
    expect(lock.packages.harness).toMatchObject({
      kind: "prime",
      selector: "latest",
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      integrity: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      url: expect.stringMatching(
        /^https:\/\/pub-728493de92a943e2a9b2d17b4719f318\.r2\.dev\/releases\/v(\d+\.\d+\.\d+)\/prime-agent-\1\.tgz$/,
      ),
      size: expect.any(Number),
    })
    expect(lock.packages.runtime.map(({ name }) => name)).toEqual(document.profile.image.packages)
    expect(lock.packages.artifacts).toBeUndefined()
    expect(lock.image.final_digest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(lockIsReady(document, lock, "linux/arm64")).toBe(true)
  })

  it("publishes only the fixed Prime proxy route and platform image identity", async () => {
    const metadata = await Effect.runPromise(profileMetadata(profilePath, "linux/arm64"))

    expect(metadata).toMatchObject({
      profile_name: "prime-agent",
      platform: "linux/arm64",
      image: "trellage-profile-prime-agent-linux-arm64:locked",
      locked: true,
      harness_kind: "prime",
      harness_executable: "prime-agent",
      runtime_entry: "trellage-prime-entry",
      default_network: "copilot-proxy-rs_default",
      auth_policy: "proxy",
      prime_provider: "copilot-proxy-rs",
      prime_model: "claude-opus-5",
      prime_base_url: "http://copilot-proxy-rs:8080",
      resolved_version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
    })
    expect(JSON.stringify(metadata)).not.toMatch(
      /ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN/,
    )
  })
})
