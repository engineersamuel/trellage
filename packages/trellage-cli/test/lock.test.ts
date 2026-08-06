import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { arm64ArtifactCatalog } from "../src/artifact-catalog.js"

import {
  compileLock,
  lockIsReady,
  profileHash,
  requireLocked,
  type LockResolvers,
  type ProfileLock,
} from "../src/lock.js"
import { parseLock, renderLock } from "../src/lock-file.js"
import { parseProfile } from "../src/profile.js"

const source = (model = "gpt-5.5") => `
schema = 1
name = "test"
description = "Lock test profile"
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
packages = ["bash", "fish"]
[[skills]]
repository = "https://github.com/obra/superpowers.git"
ref = "v6.2.0"
select = ["*"]
`

const copilotSource = `
schema = 1
name = "copilot-hve"
description = "Copilot lock profile"
[harness]
kind = "copilot"
version = "latest"
[harness.copilot]
auth = "host-or-login"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash", "fish", "git", "jq"]
[[plugins]]
adapter = "copilot-marketplace"
repository = "https://github.com/microsoft/hve-core.git"
ref = "main"
marketplace = "hve-core"
select = ["hve-core"]
`

const piSource = `
schema = 1
name = "pi-oh-my-pi"
description = "Oh My Pi profile"
[harness]
kind = "pi"
version = "latest"
args = ["--yolo"]
[harness.pi]
implementation = "oh-my-pi"
provider = "github-copilot"
model = "gpt-5.6-terra"
auth = "host-or-login"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
`

const document = (model?: string) => Effect.runSync(parseProfile(source(model), "/profiles/test/profile.toml"))

const copilotDocument = (_platform: "linux/arm64" | "linux/amd64" = "linux/arm64") =>
  Effect.runSync(parseProfile(copilotSource, "/profiles/copilot/profile.toml"))

const piDocument = () => Effect.runSync(parseProfile(piSource, "/profiles/pi-oh-my-pi/profile.toml"))

const digest = (character: string) => `sha256:${character.repeat(64)}`
const commit = (character: string) => character.repeat(40)
const treeIntegrity = (files: ReadonlyArray<unknown>) =>
  `sha256:${createHash("sha256").update(JSON.stringify(files)).digest("hex")}`

const fakeResolvers = (
  commit: string,
  calls: Array<string>,
  options: { readonly copilotVersion?: string; readonly pluginVersion?: string } = {},
): LockResolvers => ({
  platform: "linux/arm64",
  resolveSource: (request) =>
    Effect.sync(() => {
      calls.push(`source:${request.ref}`)
      const files = [
        {
          kind: "file" as const,
          path:
            request.adapter === "copilot-marketplace" ? ".github/plugin/marketplace.json" : "skills/example/SKILL.md",
          sha256: digest("f"),
        },
      ]
      return {
        commit,
        integrity: treeIntegrity(files),
        files,
        ...(request.adapter === "copilot-marketplace"
          ? { plugin_versions: { "hve-core": options.pluginVersion ?? "3.3.101" } }
          : {}),
      }
    }),
  resolvePackages: (request) =>
    Effect.sync(() => {
      calls.push("packages")
      const version =
        request.kind === "copilot"
          ? (options.copilotVersion ?? "1.0.75")
          : request.selector === "latest"
            ? request.kind === "claude"
              ? "2.1.222"
              : request.kind === "codex"
                ? "0.146.1"
                : "17.2.9"
            : request.selector
      const copilotAsset =
        request.platform === "linux/arm64" ? "copilot-linux-arm64.tar.gz" : "copilot-linux-x64.tar.gz"
      const claudeAsset = request.platform === "linux/arm64" ? "claude-linux-arm64.tar.gz" : "claude-linux-x64.tar.gz"
      const codexAsset =
        request.platform === "linux/arm64"
          ? "codex-aarch64-unknown-linux-musl.tar.gz"
          : "codex-x86_64-unknown-linux-musl.tar.gz"
      const piAsset = request.platform === "linux/arm64" ? "omp-linux-arm64" : "omp-linux-x64"
      return {
        harness: {
          kind: request.kind,
          selector: request.selector,
          version,
          integrity: digest("c"),
          url:
            request.kind === "copilot"
              ? `https://github.com/github/copilot-cli/releases/download/v${version}/${copilotAsset}`
              : request.kind === "codex"
                ? `https://github.com/openai/codex/releases/download/rust-v${version}/${codexAsset}`
                : request.kind === "claude"
                  ? `https://github.com/anthropics/claude-code/releases/download/v${version}/${claudeAsset}`
                  : `https://github.com/can1357/oh-my-pi/releases/download/v${version}/${piAsset}`,
          size: 1024,
        },
        ...(request.needsSkillsCli ? { skills_cli_version: "1.5.19", skills_cli_integrity: "sha512-dGVzdA==" } : {}),
        runtime: request.packages.map((name) => ({
          name,
          version: arm64ArtifactCatalog.runtimeVersions[name as keyof typeof arm64ArtifactCatalog.runtimeVersions],
          integrity:
            arm64ArtifactCatalog.runtimeIntegrities[name as keyof typeof arm64ArtifactCatalog.runtimeIntegrities],
        })),
      }
    }),
  resolveBase: (request) =>
    Effect.sync(() => {
      calls.push("base")
      return { reference: request.reference, digest: arm64ArtifactCatalog.base.digest }
    }),
})

const completeCopilotLock = (platform: "linux/arm64" | "linux/amd64" = "linux/arm64"): ProfileLock => {
  const profile = copilotDocument(platform)
  const asset = platform === "linux/arm64" ? "copilot-linux-arm64.tar.gz" : "copilot-linux-x64.tar.gz"
  const files = [{ kind: "file" as const, path: "plugins/hve-core/SKILL.md", sha256: digest("f") }]
  return {
    schema: 1,
    platform,
    source_date_epoch: 1784379906,
    profile_hash: profileHash(profile),
    sources: [
      {
        kind: "plugin",
        adapter: "copilot-marketplace",
        marketplace: "hve-core",
        plugin_versions: { "hve-core": "3.3.101" },
        repository: "https://github.com/microsoft/hve-core.git",
        ref: "main",
        select: ["hve-core"],
        commit: commit("a"),
        integrity: treeIntegrity(files),
        files,
      },
    ],
    packages: {
      harness: {
        kind: "copilot",
        selector: "latest",
        version: "1.0.75",
        integrity: digest("c"),
        url: `https://github.com/github/copilot-cli/releases/download/v1.0.75/${asset}`,
        size: 1024,
      },
      runtime: profile.profile.image.packages.map((name) => ({
        name,
        version: `1.0-${name}`,
        integrity: digest("d"),
      })),
    },
    image: {
      base: profile.profile.image.base,
      base_digest: digest("b"),
      final_digest: digest("e"),
    },
  }
}

const completePiLock = (): ProfileLock => {
  const profile = piDocument()
  return {
    schema: 1,
    platform: "linux/arm64",
    source_date_epoch: 1784379906,
    profile_hash: profileHash(profile),
    sources: [],
    packages: {
      harness: {
        kind: "pi",
        selector: "latest",
        version: "17.2.6",
        integrity: "sha256:65cd7f5e7d537b0b41f277191c1b95b53d509f8147c3d1bd508503dc048f1453",
        url: "https://github.com/can1357/oh-my-pi/releases/download/v17.2.6/omp-linux-arm64",
        size: 157526160,
      },
      runtime: profile.profile.image.packages.map((name) => ({
        name,
        version: `1.0-${name}`,
        integrity: digest("d"),
      })),
    },
    image: {
      base: profile.profile.image.base,
      base_digest: digest("b"),
      final_digest: digest("e"),
    },
  }
}

describe("lock inventory compatibility", () => {
  it("rejects a persisted lock without platform identity", async () => {
    const rendered = renderLock(completeCopilotLock()).replace('platform = "linux/arm64"\n', "")

    await expect(Effect.runPromise(parseLock(rendered))).rejects.toThrow(/platform.*missing|\["platform"\]/i)
  })

  it("round-trips and accepts a complete native Claude marketplace lock", async () => {
    const profile = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "claude-social-media"
description = "Claude marketplace test profile"
[harness]
kind = "claude"
version = "2.1.218"
[harness.claude]
default_auth = "proxy"
model = "claude-opus-5"
gateway = "http://copilot-proxy-rs:8080"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[plugins]]
adapter = "claude-marketplace"
repository = "https://github.com/charlie947/social-media-skills.git"
ref = "main"
marketplace = "social-media-skills"
select = ["social-media-skills"]
`,
        "/profiles/claude-social-media/profile.toml",
      ),
    )
    const files = [
      {
        kind: "file" as const,
        path: ".claude-plugin/marketplace.json",
        sha256: digest("f"),
      },
    ]
    const lock: ProfileLock = {
      schema: 1,
      platform: "linux/arm64",
      source_date_epoch: 1784379906,
      profile_hash: profileHash(profile),
      sources: [
        {
          kind: "plugin",
          adapter: "claude-marketplace",
          marketplace: "social-media-skills",
          plugin_versions: { "social-media-skills": "1.0.0" },
          repository: "https://github.com/charlie947/social-media-skills.git",
          ref: "main",
          select: ["social-media-skills"],
          commit: commit("a"),
          integrity: treeIntegrity(files),
          files,
        },
      ],
      packages: {
        harness: {
          kind: "claude",
          selector: "2.1.218",
          version: "2.1.218",
          integrity: digest("c"),
          url: "https://github.com/anthropics/claude-code/releases/download/v2.1.218/claude-linux-arm64.tar.gz",
          size: 88123930,
        },
        runtime: [
          {
            name: "bash",
            version: arm64ArtifactCatalog.runtimeVersions.bash,
            integrity: arm64ArtifactCatalog.runtimeIntegrities.bash,
          },
        ],
        artifacts: arm64ArtifactCatalog.fixedArtifacts,
      },
      image: {
        base: "node:22.17.0-bookworm-slim",
        base_digest: arm64ArtifactCatalog.base.digest,
        final_digest: digest("e"),
      },
    }

    const parsed = await Effect.runPromise(parseLock(renderLock(lock)))

    await expect(Effect.runPromise(requireLocked(profile, parsed))).resolves.toBe(parsed)
    expect(parsed.sources[0]).toMatchObject({
      adapter: "claude-marketplace",
      plugin_versions: { "social-media-skills": "1.0.0" },
    })
    expect(parsed.packages.python_lock_integrity).toBeUndefined()
  })

  it("round-trips exact Claude auxiliary artifact identities", async () => {
    const claudeDocument = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "claude-hyperresearch"
description = "Claude lock profile"
[harness]
kind = "claude"
version = "2.1.218"
[harness.claude]
default_auth = "proxy"
model = "claude-opus-5"
gateway = "http://copilot-proxy-rs:8080"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[plugins]]
adapter = "hyperresearch"
repository = "https://github.com/jordan-gibbs/hyperresearch.git"
ref = "main"
select = ["full"]
`,
        "/profiles/claude/profile.toml",
      ),
    )
    const calls: Array<string> = []
    const lock = await Effect.runPromise(
      compileLock(claudeDocument, undefined, false, fakeResolvers(commit("1"), calls)),
    )
    const artifact = {
      name: "obscura",
      version: "v0.1.11",
      integrity: digest("a"),
      url: "https://example.test/obscura.tar.gz",
      size: 52716812,
    }
    const enriched: ProfileLock = {
      ...lock,
      packages: { ...lock.packages, artifacts: [artifact], python_lock_integrity: digest("b") },
    }

    const parsed = await Effect.runPromise(parseLock(renderLock(enriched)))
    expect(parsed.packages.artifacts).toEqual([artifact])
    expect(parsed.packages.python_lock_integrity).toBe(digest("b"))
  })

  it("rejects a ready Claude lock when an auxiliary artifact is tampered", async () => {
    const claudeDocument = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "claude-hyperresearch"
description = "Claude lock profile"
[harness]
kind = "claude"
version = "2.1.218"
[harness.claude]
default_auth = "proxy"
model = "claude-opus-5"
gateway = "http://copilot-proxy-rs:8080"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[plugins]]
adapter = "hyperresearch"
repository = "https://github.com/jordan-gibbs/hyperresearch.git"
ref = "main"
select = ["full"]
`,
        "/profiles/claude/profile.toml",
      ),
    )
    const resolved = await Effect.runPromise(
      compileLock(claudeDocument, undefined, false, fakeResolvers(commit("1"), [])),
    )
    const tampered: ProfileLock = {
      ...resolved,
      packages: {
        ...resolved.packages,
        python_lock_integrity: digest("a"),
        artifacts: [{ name: "obscura", version: "v0.1.11", integrity: "sha256:bad", url: "https://example.test/a" }],
      },
      image: { ...resolved.image, final_digest: digest("e") },
    }

    await expect(Effect.runPromise(requireLocked(claudeDocument, tampered))).rejects.toThrow(/artifact integrity/i)
  })

  it("rejects a persisted Hyperresearch lock when an exact auxiliary artifact identity is changed", async () => {
    const claudeDocument = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "claude-hyperresearch"
description = "Claude lock profile"
[harness]
kind = "claude"
version = "2.1.218"
[harness.claude]
default_auth = "proxy"
model = "claude-opus-5"
gateway = "http://copilot-proxy-rs:8080"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[plugins]]
adapter = "hyperresearch"
repository = "https://github.com/jordan-gibbs/hyperresearch.git"
ref = "main"
select = ["full"]
`,
        "/profiles/claude/profile.toml",
      ),
    )
    const resolved = await Effect.runPromise(
      compileLock(claudeDocument, undefined, false, fakeResolvers(commit("1"), [])),
    )
    const artifacts = [...arm64ArtifactCatalog.fixedArtifacts, ...arm64ArtifactCatalog.hyperresearchArtifacts].map(
      (artifact) => (artifact.name === "obscura" ? { ...artifact, integrity: digest("f") } : artifact),
    )
    const tampered: ProfileLock = {
      ...resolved,
      packages: {
        ...resolved.packages,
        harness: {
          kind: "claude",
          selector: "2.1.218",
          version: "2.1.218",
          integrity: digest("c"),
          url: "https://github.com/anthropics/claude-code/releases/download/v2.1.218/claude-linux-arm64.tar.gz",
          size: 88123930,
        },
        runtime: [
          {
            name: "bash",
            version: arm64ArtifactCatalog.runtimeVersions.bash,
            integrity: arm64ArtifactCatalog.runtimeIntegrities.bash,
          },
        ],
        artifacts,
        python_lock_integrity: arm64ArtifactCatalog.hyperresearchPythonLockIntegrity,
      },
      image: {
        base: arm64ArtifactCatalog.base.reference,
        base_digest: arm64ArtifactCatalog.base.digest,
        final_digest: digest("e"),
      },
    }
    const persisted = await Effect.runPromise(parseLock(renderLock(tampered)))

    await expect(Effect.runPromise(requireLocked(claudeDocument, persisted))).rejects.toThrow(
      /artifact does not match platform catalog: obscura/,
    )
  })

  it("rejects a Claude lock that predates the locked Chromium headless shell", async () => {
    const claudeDocument = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "claude-hyperresearch"
description = "Claude lock profile"
[harness]
kind = "claude"
version = "2.1.218"
[harness.claude]
default_auth = "proxy"
model = "claude-opus-5"
gateway = "http://copilot-proxy-rs:8080"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[plugins]]
adapter = "hyperresearch"
repository = "https://github.com/jordan-gibbs/hyperresearch.git"
ref = "main"
select = ["full"]
`,
        "/profiles/claude/profile.toml",
      ),
    )
    const resolved = await Effect.runPromise(
      compileLock(claudeDocument, undefined, false, fakeResolvers(commit("1"), [])),
    )
    const artifacts = [
      "node",
      "python",
      "playwright-mcp",
      "playwright",
      "playwright-core",
      "chromium",
      "obscura",
      "builder-oci",
      "skopeo-oci",
    ].map((name) => ({
      name,
      version: "1",
      integrity: digest("a"),
      url: "https://example.test/artifact",
      size: 1,
    }))
    const legacy: ProfileLock = {
      ...resolved,
      packages: { ...resolved.packages, artifacts, python_lock_integrity: digest("b") },
      image: { ...resolved.image, final_digest: digest("e") },
    }

    await expect(Effect.runPromise(requireLocked(claudeDocument, legacy))).rejects.toThrow(
      /required Claude artifact is missing: chromium-headless-shell/,
    )
  })

  it("renders and decodes a modern typed Codex file and package shape", async () => {
    const lock = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const rendered = renderLock(lock)

    expect(rendered).toContain(
      `[[sources.files]]\nkind = "file"\npath = "skills/example/SKILL.md"\nsha256 = "${digest("f")}"`,
    )
    expect(rendered).toContain('[packages.harness]\nkind = "codex"')
    expect(rendered).not.toContain(`executable =`)
    await expect(Effect.runPromise(parseLock(rendered))).resolves.toMatchObject({
      sources: [{ files: [{ kind: "file", path: "skills/example/SKILL.md", sha256: digest("f") }] }],
      packages: { harness: { kind: "codex", selector: "0.144.6", version: "0.144.6" } },
    })
  })

  it("renders and decodes a normalized executable file bit", async () => {
    const fileLock = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const files = [
      {
        kind: "file" as const,
        path: "skills/example/install.sh",
        sha256: digest("f"),
        executable: true as const,
      },
    ]
    const lock: ProfileLock = {
      ...fileLock,
      sources: [{ ...fileLock.sources[0]!, files, integrity: treeIntegrity(files) }],
    }
    const rendered = renderLock(lock)

    expect(rendered).toContain(
      `[[sources.files]]\nkind = "file"\npath = "skills/example/install.sh"\nsha256 = "${digest("f")}"\nexecutable = true`,
    )
    await expect(Effect.runPromise(parseLock(rendered))).resolves.toMatchObject({
      sources: [{ files }],
    })
  })

  it("rejects a persisted false executable bit instead of accepting non-canonical lock bytes", async () => {
    const lock = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const rendered = renderLock(lock).replace(
      `sha256 = "${digest("f")}"`,
      `sha256 = "${digest("f")}"\nexecutable = false`,
    )

    await expect(Effect.runPromise(parseLock(rendered))).rejects.toThrow(/executable|true/)
  })

  it("renders and decodes discriminated Copilot package and marketplace fields", async () => {
    const lock = completeCopilotLock()
    const rendered = renderLock(lock)

    expect(rendered).toContain('marketplace = "hve-core"')
    expect(rendered).toContain('plugin_versions = { "hve-core" = "3.3.101" }')
    expect(rendered).toContain('[packages.harness]\nkind = "copilot"\nselector = "latest"\nversion = "1.0.75"')
    const parsed = await Effect.runPromise(parseLock(rendered))

    expect(parsed).toEqual(lock)
    expect(Object.getPrototypeOf(parsed.sources[0]!.plugin_versions!)).toBeNull()
    expect(Object.isFrozen(parsed.sources[0]!.plugin_versions!)).toBe(true)
  })

  it("round-trips a source-free Pi lock with the canonical OMP release asset", async () => {
    const lock = completePiLock()
    const rendered = renderLock(lock)

    expect(rendered).toContain("sources = []")
    expect(rendered).toContain('kind = "pi"')
    expect(rendered).toContain('url = "https://github.com/can1357/oh-my-pi/releases/download/v17.2.6/omp-linux-arm64"')
    await expect(Effect.runPromise(parseLock(rendered))).resolves.toEqual(lock)
    await expect(Effect.runPromise(requireLocked(piDocument(), lock))).resolves.toEqual(lock)
  })

  it("normalizes handcrafted plugin version tables deterministically", async () => {
    const lock = completeCopilotLock()
    const source = renderLock({
      ...lock,
      sources: [
        {
          ...lock.sources[0]!,
          select: ["zeta", "alpha"],
          plugin_versions: { zeta: "2.0.0", alpha: "1.0.0" },
        },
      ],
    })
    const parsed = await Effect.runPromise(parseLock(source))
    const versions = parsed.sources[0]!.plugin_versions!

    expect(Object.keys(versions)).toEqual(["alpha", "zeta"])
    expect(Object.getPrototypeOf(versions)).toBeNull()
    expect(Object.isFrozen(versions)).toBe(true)
    expect(renderLock(parsed)).toContain('plugin_versions = { "alpha" = "1.0.0", "zeta" = "2.0.0" }')
  })

  it("accepts a parsed historical file-only lock with legacy inventory integrity", async () => {
    const profilePath = fileURLToPath(new URL("../../../profiles/codex-superpowers/profile.toml", import.meta.url))
    const lockPath = fileURLToPath(
      new URL("../../../profiles/codex-superpowers/profile.linux-arm64.lock.toml", import.meta.url),
    )
    const profileSource = await readFile(profilePath, "utf8")
    const serialized = await readFile(lockPath, "utf8")
    const historicalDocument = await Effect.runPromise(parseProfile(profileSource, profilePath))
    const parsed = await Effect.runPromise(parseLock(serialized))

    await expect(Effect.runPromise(requireLocked(historicalDocument, parsed))).resolves.toBe(parsed)
    expect(renderLock(parsed)).toBe(serialized)
    expect(JSON.stringify(parsed)).not.toContain("legacySourceProvenance")
    expect(renderLock({ ...parsed })).toContain('[packages.harness]\nkind = "codex"')
    expect(renderLock({ ...parsed })).toContain('[[sources.files]]\nkind = "file"')
  })

  it("does not let legacy integrity omit an executable file bit", async () => {
    const pending = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const files = pending.sources[0]!.files.map((file) =>
      file.kind === "file" ? { ...file, executable: true as const } : file,
    )
    const legacyFiles = files.map((file) => {
      if (file.kind !== "file") throw new Error("expected file-only fixture")
      return { path: file.path, sha256: file.sha256 }
    })
    const forged: ProfileLock = {
      ...pending,
      sources: [{ ...pending.sources[0]!, files, integrity: treeIntegrity(legacyFiles) }],
      image: { ...pending.image, final_digest: digest("e") },
    }

    await expect(Effect.runPromise(requireLocked(document(), forged))).rejects.toThrow(/source integrity/)
  })

  it("rejects legacy alternate integrity on a modern typed Codex inventory", async () => {
    const pending = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const legacyFiles = pending.sources[0]!.files.map((file) => {
      if (file.kind !== "file") throw new Error("expected file-only fixture")
      return { path: file.path, sha256: file.sha256 }
    })
    const forged: ProfileLock = {
      ...pending,
      sources: [{ ...pending.sources[0]!, integrity: treeIntegrity(legacyFiles) }],
      image: { ...pending.image, final_digest: digest("e") },
    }

    await expect(Effect.runPromise(requireLocked(document(), forged))).rejects.toThrow(/source integrity/)
  })

  it("does not gain legacy provenance when a modern Codex lock is rendered and reparsed", async () => {
    const pending = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const modern: ProfileLock = {
      ...pending,
      image: { ...pending.image, final_digest: digest("e") },
    }
    const files = modern.sources[0]!.files
    const legacyFiles = files.map((file) => {
      if (file.kind !== "file") throw new Error("expected file-only fixture")
      return { path: file.path, sha256: file.sha256 }
    })
    const legacyIntegrity = treeIntegrity(legacyFiles)
    const rendered = renderLock(modern)
    const attacked = rendered.replace(
      `integrity = "${modern.sources[0]!.integrity}"`,
      `integrity = "${legacyIntegrity}"`,
    )
    const reparsed = await Effect.runPromise(parseLock(attacked))

    expect(rendered).toContain('[packages.harness]\nkind = "codex"')
    expect(rendered).toContain('[[sources.files]]\nkind = "file"')
    await expect(Effect.runPromise(requireLocked(document(), reparsed))).rejects.toThrow(/source integrity/)
  })

  it("renders and decodes typed symlink entries", async () => {
    const fileLock = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const files = [{ kind: "symlink" as const, path: "skills/example/current", target: "../shared" }]
    const lock: ProfileLock = {
      ...fileLock,
      sources: [{ ...fileLock.sources[0]!, files, integrity: treeIntegrity(files) }],
    }
    const rendered = renderLock(lock)

    expect(rendered).toContain(
      `[[sources.files]]\nkind = "symlink"\npath = "skills/example/current"\ntarget = "../shared"`,
    )
    await expect(Effect.runPromise(parseLock(rendered))).resolves.toMatchObject({
      sources: [{ files }],
    })
  })

  it("accepts a semantically safe typed symlink inventory", async () => {
    const pending = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const files = [
      { kind: "symlink" as const, path: "skills/example/current.md", target: "../shared/file.md" },
      { kind: "file" as const, path: "skills/shared/file.md", sha256: digest("f") },
    ]
    const lock: ProfileLock = {
      ...pending,
      sources: [{ ...pending.sources[0]!, files, integrity: treeIntegrity(files) }],
      image: { ...pending.image, final_digest: digest("e") },
    }

    await expect(Effect.runPromise(requireLocked(document(), lock))).resolves.toBe(lock)
  })

  it.each([
    "",
    "/etc/passwd",
    "../../../outside.md",
    "..\\..\\..\\outside.md",
    "C:outside.md",
    "C:\\outside.md",
    "\\\\server\\share\\outside.md",
  ])("rejects an unsafe symlink target %j in lock semantics", async (target) => {
    const pending = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const files = [{ kind: "symlink" as const, path: "skills/example/current.md", target }]
    const lock: ProfileLock = {
      ...pending,
      sources: [{ ...pending.sources[0]!, files, integrity: treeIntegrity(files) }],
      image: { ...pending.image, final_digest: digest("e") },
    }

    await expect(Effect.runPromise(requireLocked(document(), lock))).rejects.toThrow(/source symlink target/)
  })

  it.each([
    ["missing", {}],
    ["extra", { "hve-core": "3.3.101", extra: "1.0.0" }],
    ["empty", { "hve-core": "" }],
  ])("rejects %s Copilot plugin versions", async (_label, plugin_versions) => {
    const profile = copilotDocument()
    const complete = completeCopilotLock()
    const lock: ProfileLock = {
      ...complete,
      sources: [{ ...complete.sources[0]!, plugin_versions }],
    }

    await expect(Effect.runPromise(requireLocked(profile, lock))).rejects.toThrow(/plugin version/)
  })

  it("rejects mismatched Copilot marketplace and harness kinds", async () => {
    const profile = copilotDocument()
    const complete = completeCopilotLock()
    const wrongMarketplace: ProfileLock = {
      ...complete,
      sources: [{ ...complete.sources[0]!, marketplace: "other" }],
    }
    const wrongHarness: ProfileLock = {
      ...complete,
      packages: {
        ...complete.packages,
        harness: { ...complete.packages.harness, kind: "codex" },
      },
    }

    await expect(Effect.runPromise(requireLocked(profile, wrongMarketplace))).rejects.toThrow(
      /marketplace does not match/,
    )
    await expect(Effect.runPromise(requireLocked(profile, wrongHarness))).rejects.toThrow(/harness package kind/)
  })

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects persisted dangerous Copilot plugin key %j even when selected",
    async (key) => {
      const profile = copilotDocument()
      if (profile.profile.harness.kind !== "copilot") throw new Error("expected Copilot profile")
      const dangerousProfile = {
        ...profile,
        profile: {
          ...profile.profile,
          plugins: profile.profile.plugins.map((plugin) => ({ ...plugin, select: [key] })),
        },
      } as typeof profile
      const complete = completeCopilotLock()
      const forged: ProfileLock = {
        ...complete,
        profile_hash: profileHash(dangerousProfile),
        sources: [
          {
            ...complete.sources[0]!,
            select: [key],
            plugin_versions: Object.fromEntries([[key, "3.3.101"]]),
          },
        ],
      }
      const parsed = await Effect.runPromise(parseLock(renderLock(forged)))

      await expect(Effect.runPromise(requireLocked(dangerousProfile, parsed))).rejects.toThrow(
        /plugin version key is unsafe/,
      )
    },
  )
})

describe("compileLock", () => {
  it("re-resolves genuine legacy sources when only profile content changes", async () => {
    const profilePath = fileURLToPath(new URL("../../../profiles/codex-superpowers/profile.toml", import.meta.url))
    const lockPath = fileURLToPath(
      new URL("../../../profiles/codex-superpowers/profile.linux-arm64.lock.toml", import.meta.url),
    )
    const legacyProfileSource = await readFile(profilePath, "utf8")
    const currentLock = await Effect.runPromise(parseLock(await readFile(lockPath, "utf8")))
    const currentSource = currentLock.sources[0]!
    const legacyFiles = currentSource.files.map((file, index) =>
      index === 0 && file.kind === "file" ? { ...file, executable: true as const } : file,
    )
    const legacyLock = await Effect.runPromise(
      parseLock(
        renderLock({
          ...currentLock,
          sources: [
            {
              ...currentSource,
              files: legacyFiles,
              integrity: treeIntegrity(
                legacyFiles.map((file) => ({ path: file.path, sha256: "sha256" in file ? file.sha256 : "" })),
              ),
            },
            ...currentLock.sources.slice(1),
          ],
        }),
      ),
    )
    const changedDocument = await Effect.runPromise(
      parseProfile(legacyProfileSource.replace('model = "gpt-5.5"', 'model = "gpt-5.6"'), profilePath),
    )
    const calls: Array<string> = []
    const baseResolvers = fakeResolvers(commit("b"), calls)
    const resolvers: LockResolvers = {
      ...baseResolvers,
      resolveSource: (request) =>
        baseResolvers.resolveSource(request).pipe(
          Effect.map((resolution) => ({
            ...resolution,
            commit: /^[0-9a-f]{40}$/.test(request.ref) ? request.ref : resolution.commit,
          })),
        ),
      resolvePackages: baseResolvers.resolvePackages,
    }

    const compiled = await Effect.runPromise(compileLock(changedDocument, legacyLock, false, resolvers))
    const complete: ProfileLock = {
      ...compiled,
      image: { ...compiled.image, final_digest: digest("e") },
    }
    const reparsed = await Effect.runPromise(parseLock(renderLock(complete)))

    expect(calls.filter((call) => call.startsWith("source:"))).toEqual([
      "source:v6.2.0",
      "source:v1.10.0",
      "source:c4b82b0ad771190355eb8e204b1329732a18449a",
    ])
    expect(compiled.sources.every((source) => source.integrity === treeIntegrity(source.files))).toBe(true)
    expect(renderLock(compiled)).toContain('[[sources.files]]\nkind = "file"')
    await expect(Effect.runPromise(requireLocked(changedDocument, reparsed))).resolves.toBe(reparsed)
  })

  it("records exact Copilot marketplace and harness resolutions", async () => {
    const calls: Array<string> = []

    const lock = await Effect.runPromise(
      compileLock(copilotDocument(), undefined, false, fakeResolvers(commit("a"), calls)),
    )

    expect(lock.sources[0]).toMatchObject({
      adapter: "copilot-marketplace",
      marketplace: "hve-core",
      plugin_versions: { "hve-core": "3.3.101" },
    })
    expect(lock.packages.harness).toEqual({
      kind: "copilot",
      selector: "latest",
      version: "1.0.75",
      integrity: digest("c"),
      url: "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
      size: 1024,
    })
    expect(lock.packages.skills_cli_version).toBeUndefined()
    expect(calls).toEqual(["source:main", "packages", "base"])
  })

  it("keeps resolved Copilot plugin versions immutable and prototype-safe", async () => {
    const lock = await Effect.runPromise(
      compileLock(copilotDocument(), undefined, false, fakeResolvers(commit("a"), [])),
    )
    const versions = lock.sources[0]!.plugin_versions!

    expect(Object.getPrototypeOf(versions)).toBeNull()
    expect(Object.isFrozen(versions)).toBe(true)
  })

  it("accepts a complete matching Copilot lock in metadata and locked modes", async () => {
    const profile = copilotDocument()
    const lock = completeCopilotLock()

    expect(lockIsReady(profile, lock)).toBe(true)
    await expect(Effect.runPromise(requireLocked(profile, lock))).resolves.toBe(lock)
  })

  it("recognizes the canonical x64 lock shape but rejects unsupported AMD64 production", async () => {
    const profile = copilotDocument("linux/amd64")
    const lock = completeCopilotLock("linux/amd64")

    expect(lockIsReady(profile, lock, "linux/amd64")).toBe(false)
    await expect(Effect.runPromise(requireLocked(profile, lock, "linux/amd64"))).rejects.toThrow(
      /production artifacts are unavailable/,
    )
  })

  it("rejects a lock selected for a different Docker server platform", async () => {
    const profile = copilotDocument()
    const lock = completeCopilotLock("linux/arm64")

    expect(lockIsReady(profile, lock, "linux/amd64")).toBe(false)
    await expect(Effect.runPromise(requireLocked(profile, lock, "linux/amd64"))).rejects.toThrow(/lock platform/)
  })

  it.each(["1.0.75-alpha.1", "1.0.75+build.1"])("rejects non-stable Copilot lock version %j", async (version) => {
    const profile = copilotDocument()
    const complete = completeCopilotLock()
    const lock: ProfileLock = {
      ...complete,
      packages: {
        ...complete.packages,
        harness: {
          ...complete.packages.harness,
          version,
          url: `https://github.com/github/copilot-cli/releases/download/v${version}/copilot-linux-arm64.tar.gz`,
        },
      },
    }

    expect(lockIsReady(profile, lock)).toBe(false)
    await expect(Effect.runPromise(requireLocked(profile, lock))).rejects.toThrow(/stable/)
  })

  it.each([
    "https://example.test/copilot-linux-arm64.tar.gz",
    "https://github.com/github/copilot-cli/releases/download/v1.0.76/copilot-linux-arm64.tar.gz",
    "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-x64.tar.gz",
  ])("rejects forged Copilot artifact URL %j", async (url) => {
    const profile = copilotDocument()
    const complete = completeCopilotLock()
    const lock: ProfileLock = {
      ...complete,
      packages: {
        ...complete.packages,
        harness: { ...complete.packages.harness, url },
      },
    }

    expect(lockIsReady(profile, lock)).toBe(false)
    await expect(Effect.runPromise(requireLocked(profile, lock))).rejects.toThrow(/artifact URL/)
  })

  it("rejects a source commit that differs from an exact ref", async () => {
    const pending = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const lock: ProfileLock = {
      ...pending,
      sources: [{ ...pending.sources[0]!, ref: commit("b") }],
      image: { ...pending.image, final_digest: digest("e") },
    }

    await expect(Effect.runPromise(requireLocked(document(), lock))).rejects.toThrow(
      /exact source ref does not match commit/,
    )
  })

  it("allows latest to resolve to an exact Copilot version", async () => {
    const profile = copilotDocument()
    const lock = completeCopilotLock()

    await expect(Effect.runPromise(requireLocked(profile, lock))).resolves.toBe(lock)
  })

  it.each(["codex", "copilot"] as const)(
    "rejects an explicit %s selector that differs from the resolved version",
    async (kind) => {
      const profile = kind === "codex" ? document() : copilotDocument()
      const base =
        kind === "codex"
          ? await Effect.runPromise(compileLock(profile, undefined, false, fakeResolvers(commit("a"), [])))
          : completeCopilotLock()
      const lock: ProfileLock = {
        ...base,
        packages: {
          ...base.packages,
          harness: {
            ...base.packages.harness,
            selector: kind === "codex" ? "0.144.6" : "1.0.75",
            version: kind === "codex" ? "0.145.0" : "1.0.76",
          },
        },
        image: { ...base.image, final_digest: digest("e") },
      }

      await expect(Effect.runPromise(requireLocked(profile, lock))).rejects.toThrow(
        /explicit harness selector does not match resolved version/,
      )
    },
  )

  it("reuses exact Copilot resolutions until update is requested", async () => {
    const initial = await Effect.runPromise(
      compileLock(
        copilotDocument(),
        undefined,
        false,
        fakeResolvers(commit("a"), [], { copilotVersion: "1.0.75", pluginVersion: "3.3.101" }),
      ),
    )
    const reuseCalls: Array<string> = []
    const reused = await Effect.runPromise(
      compileLock(
        copilotDocument(),
        initial,
        false,
        fakeResolvers(commit("b"), reuseCalls, { copilotVersion: "1.0.76", pluginVersion: "3.3.102" }),
      ),
    )
    const updateCalls: Array<string> = []
    const updated = await Effect.runPromise(
      compileLock(
        copilotDocument(),
        initial,
        true,
        fakeResolvers(commit("b"), updateCalls, { copilotVersion: "1.0.76", pluginVersion: "3.3.102" }),
      ),
    )

    expect(reused).toBe(initial)
    expect(reuseCalls).toEqual([])
    expect(updated.sources[0]).toMatchObject({
      commit: commit("b"),
      plugin_versions: { "hve-core": "3.3.102" },
    })
    expect(updated.packages.harness.version).toBe("1.0.76")
    expect(updateCalls).toEqual(["source:main", "packages", "base"])
  })

  it("creates a deterministic lock from exact resolutions", async () => {
    const calls: Array<string> = []
    const first = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), calls)))
    const second = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))

    expect(first).toEqual(second)
    expect(first.sources[0]?.commit).toBe(commit("a"))
    expect(first.image.base_digest).toBe(arm64ArtifactCatalog.base.digest)
    expect(first.image.final_digest).toBeUndefined()
    expect(first.source_date_epoch).toBe(1784379906)
    expect(calls).toEqual(["source:v6.2.0", "packages", "base"])
  })

  it("reuses an unchanged lock without resolution", async () => {
    const calls: Array<string> = []
    const current = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))

    const result = await Effect.runPromise(compileLock(document(), current, false, fakeResolvers(commit("b"), calls)))

    expect(result).toBe(current)
    expect(calls).toEqual([])
  })

  it("preserves compatible source resolutions when another profile field changes", async () => {
    const current = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const calls: Array<string> = []

    const result = await Effect.runPromise(
      compileLock(document("gpt-5.6"), current, false, fakeResolvers(commit("b"), calls)),
    )

    expect(result.sources[0]?.commit).toBe(commit("a"))
    expect(calls).not.toContain("source:v6.2.0")
  })

  it("refreshes unchanged refs only when update is requested", async () => {
    const current = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const calls: Array<string> = []

    const result = await Effect.runPromise(compileLock(document(), current, true, fakeResolvers(commit("b"), calls)))

    expect(result.sources[0]?.commit).toBe(commit("b"))
    expect(result.image.final_digest).toBeUndefined()
    expect(calls).toContain("source:v6.2.0")
  })

  it("locked mode rejects missing and stale locks", async () => {
    await expect(Effect.runPromise(requireLocked(document(), undefined))).rejects.toThrow(/missing lock/)

    const stale = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    await expect(Effect.runPromise(requireLocked(document("gpt-5.6"), stale))).rejects.toThrow(/stale lock/)
  })

  it("rejects a lock source collision", async () => {
    const current = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const corrupt: ProfileLock = {
      ...current,
      sources: [{ ...current.sources[0]!, repository: "https://github.com/other/repo.git" }],
    }

    await expect(
      Effect.runPromise(compileLock(document(), corrupt, false, fakeResolvers(commit("b"), []))),
    ).resolves.toMatchObject({ sources: [{ repository: "https://github.com/obra/superpowers.git" }] })
  })

  it("rejects an incomplete or profile-incompatible lock in locked mode", async () => {
    const pending = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    await expect(Effect.runPromise(requireLocked(document(), pending))).rejects.toThrow(/final OCI digest/)

    const complete: ProfileLock = {
      ...pending,
      image: { ...pending.image, final_digest: digest("c") },
    }
    const substituted: ProfileLock = {
      ...complete,
      sources: [{ ...complete.sources[0]!, repository: "https://github.com/other/repo.git" }],
    }
    await expect(Effect.runPromise(requireLocked(document(), substituted))).rejects.toThrow(/incompatible lock/)
  })

  it("rejects a locked profile without Codex archive integrity", async () => {
    const pending = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const incomplete: ProfileLock = {
      ...pending,
      packages: {
        ...pending.packages,
        harness: { ...pending.packages.harness, integrity: "" },
      },
      image: { ...pending.image, final_digest: digest("c") },
    }

    await expect(Effect.runPromise(requireLocked(document(), incomplete))).rejects.toThrow(/Codex package integrity/)
  })

  it("rejects a locked profile without a Codex archive URL", async () => {
    const pending = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const incomplete: ProfileLock = {
      ...pending,
      packages: {
        ...pending.packages,
        harness: { ...pending.packages.harness, url: "" },
      },
      image: { ...pending.image, final_digest: digest("c") },
    }

    await expect(Effect.runPromise(requireLocked(document(), incomplete))).rejects.toThrow(/Codex package.*URL/)
  })

  it("rejects a locked profile without a Codex archive size", async () => {
    const pending = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const incomplete: ProfileLock = {
      ...pending,
      packages: {
        ...pending.packages,
        harness: { ...pending.packages.harness, size: 0 },
      },
      image: { ...pending.image, final_digest: digest("c") },
    }

    await expect(Effect.runPromise(requireLocked(document(), incomplete))).rejects.toThrow(/Codex package size/)
  })

  it("rejects a locked profile without a Skills CLI version", async () => {
    const pending = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const { skills_cli_version: _omitted, ...packages } = pending.packages
    const incomplete: ProfileLock = {
      ...pending,
      packages,
      image: { ...pending.image, final_digest: digest("c") },
    }

    await expect(Effect.runPromise(requireLocked(document(), incomplete))).rejects.toThrow(/Skills CLI version/)
  })

  it("rejects a locked profile without Skills CLI integrity", async () => {
    const pending = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const { skills_cli_integrity: _omitted, ...packages } = pending.packages
    const incomplete: ProfileLock = {
      ...pending,
      packages,
      image: { ...pending.image, final_digest: digest("c") },
    }

    await expect(Effect.runPromise(requireLocked(document(), incomplete))).rejects.toThrow(/Skills CLI integrity/)
  })

  it.each(["latest", "^1.5.19", ">=1.5.19", "1.x"])("rejects a non-exact Skills CLI version %j", async (version) => {
    const pending = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
    const incomplete: ProfileLock = {
      ...pending,
      packages: { ...pending.packages, skills_cli_version: version },
      image: { ...pending.image, final_digest: digest("c") },
    }

    await expect(Effect.runPromise(requireLocked(document(), incomplete))).rejects.toThrow(
      /Skills CLI version is not exact/,
    )
  })

  it.each(["latest", "^5.2.15", ">=5.2.15", "5.x"])(
    "rejects a non-exact runtime package version %j",
    async (version) => {
      const pending = await Effect.runPromise(compileLock(document(), undefined, false, fakeResolvers(commit("a"), [])))
      const runtime = pending.packages.runtime.map((entry, index) => (index === 0 ? { ...entry, version } : entry))
      const incomplete: ProfileLock = {
        ...pending,
        packages: { ...pending.packages, runtime },
        image: { ...pending.image, final_digest: digest("c") },
      }

      await expect(Effect.runPromise(requireLocked(document(), incomplete))).rejects.toThrow(
        /runtime package version is not exact/,
      )
    },
  )
})
