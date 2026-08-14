import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { Cause, Effect, Exit } from "effect"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { GitHubSourceRequest } from "../src/github-cache.js"
import { arm64ArtifactCatalog } from "../src/artifact-catalog.js"

const mocks = vi.hoisted(() => ({
  requests: [] as Array<GitHubSourceRequest>,
  sourceDirectory: "/definitely-missing-harness-source",
  sourceFiles: [] as Array<{ readonly kind: "file"; readonly path: string; readonly sha256: string }>,
  failUnlockedSourceResolutions: 0,
  failPackageResolutions: 0,
  failLockRenames: 0,
  lockRenameEvents: undefined as Array<string> | undefined,
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    rename: async (source: Parameters<typeof actual.rename>[0], destination: Parameters<typeof actual.rename>[1]) => {
      if (String(destination).endsWith("profile.linux-arm64.lock.toml")) {
        mocks.lockRenameEvents?.push("write:lock")
        if (mocks.failLockRenames > 0) {
          mocks.failLockRenames -= 1
          throw new Error("atomic rename failed")
        }
      }
      return actual.rename(source, destination)
    },
  }
})

vi.mock("../src/github-cache.js", async () => {
  const { Effect } = await import("effect")
  return {
    resolveGitHubSource: (_cache: string, request: GitHubSourceRequest) => {
      mocks.requests.push(request)
      if (request.lockedCommit === undefined && mocks.failUnlockedSourceResolutions > 0) {
        mocks.failUnlockedSourceResolutions -= 1
        return Effect.fail(new Error("ECONNRESET while resolving latest source"))
      }
      return Effect.succeed({
        ...request,
        commit: request.lockedCommit ?? "a".repeat(40),
        directory: mocks.sourceDirectory,
        integrity: treeIntegrity(mocks.sourceFiles),
        files: mocks.sourceFiles,
      })
    },
  }
})

vi.mock("../src/claude-release.js", async () => {
  const { Effect: EffectModule } = await import("effect")
  return {
    resolveClaudeRelease: (selector: string) => {
      const version = selector === "latest" ? "2.1.222" : selector
      return EffectModule.succeed({
        kind: "claude" as const,
        selector,
        version,
        integrity: digest("c"),
        url: `https://github.com/anthropics/claude-code/releases/download/v${version}/claude-linux-arm64.tar.gz`,
        size: 88123930,
      })
    },
  }
})

vi.mock("../src/codex-release.js", async () => {
  const { Effect: EffectModule } = await import("effect")
  return {
    resolveCodexRelease: (selector: string) => {
      const version = selector === "latest" ? "0.146.1" : selector
      return EffectModule.succeed({
        harness: {
          kind: "codex" as const,
          selector,
          version,
          integrity:
            selector === "latest"
              ? "sha256:05de65ee7b6bd02038e720cc313941d5ec6794718e4261bd28fd83b93fe34d43"
              : "sha256:8eddae5e6c009dff9ba51ae1bfe3bdd9ff4c1ccc93a48cc6860db1cd9fdf11be",
          url: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-aarch64-unknown-linux-musl.tar.gz`,
          size: selector === "latest" ? 105647055 : 101269986,
        },
        artifacts: [
          {
            name: "codex-code-mode-host",
            version,
            integrity: "sha256:dfd4ff98ea4db30ed078af9c31b6f86e3da4836d0573aa87e225e5a5b54d3c7c",
            url: `https://github.com/openai/codex/releases/download/rust-v${version}/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz`,
            size: 17260137,
          },
        ],
      })
    },
  }
})

vi.mock("../src/resolvers.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/resolvers.js")>()
  const { Effect: EffectModule } = await import("effect")
  return {
    ...actual,
    productionResolvers: (...args: Parameters<typeof actual.productionResolvers>) => {
      const base = actual.productionResolvers(...args)
      return {
        ...base,
        resolvePackages: (request: Parameters<typeof base.resolvePackages>[0]) => {
          if (mocks.failPackageResolutions > 0) {
            mocks.failPackageResolutions -= 1
            return EffectModule.fail(new Error("HTTP 503 while resolving latest harness"))
          }
          return base.resolvePackages(request)
        },
      }
    },
  }
})

import {
  ApplicationError,
  builderNetworkEnv,
  builderScript,
  buildProfile,
  compatibilityPluginArguments,
  discoverPypiIndex,
  loadLock,
  microsoftProtectedPypiIndex,
  profileMetadata,
  pypiIndexFromNpmRegistry,
  sanitizeNpmRegistry,
  sanitizePypiIndex,
  upgradeProfile,
  type CommandRunner,
  type DockerServices,
  type UpgradeServices,
} from "../src/application.js"
import { renderLock } from "../src/lock-file.js"
import { profileHash, requireLocked, type ProfileLock } from "../src/lock.js"
import { parseProfile } from "../src/profile.js"

const digest = (character: string) => `sha256:${character.repeat(64)}`
const arm64Target = {
  endpoint: "unix:///tmp/trellage-test-docker.sock",
  serverId: "trellage-test-server",
  platform: "linux/arm64",
} as const
const dockerServices = (run: CommandRunner): DockerServices => ({ run, verify: () => Effect.void })
const execFilePromise = promisify(execFile)
const treeIntegrity = (files: ReadonlyArray<unknown>) =>
  `sha256:${createHash("sha256").update(JSON.stringify(files)).digest("hex")}`
const contentIntegrity = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}`

const runtimeSupport = (root: string) => ({
  codexEntry: path.join(root, "runtime-entry.sh"),
  copilotEntry: path.join(root, "runtime-copilot-entry.sh"),
  piEntry: path.join(root, "runtime-pi-entry.sh"),
  primeEntry: path.join(root, "runtime-prime-entry.sh"),
  finalizeCopilotSeed: path.join(root, "finalize-copilot-seed.mjs"),
})

const pathExists = async (candidate: string) => {
  try {
    await access(candidate)
    return true
  } catch {
    return false
  }
}

describe("compatibility plugin generation", () => {
  it("runs the source generator without installing its unrelated eval project", () => {
    expect(compatibilityPluginArguments("/source", "full-stack-orchestration", "/output")).toEqual([
      "x",
      "uv@0.11.21",
      "--",
      "uv",
      "run",
      "--no-project",
      "--python",
      "3.13",
      "python",
      "/source/tools/generate.py",
      "--harness",
      "codex",
      "--plugin",
      "full-stack-orchestration",
      "--output-root",
      "/output",
    ])
  })
})

describe("npm registry forwarding", () => {
  it("accepts a credential-free HTTPS registry", () => {
    expect(sanitizeNpmRegistry("https://packagefeedproxy.microsoft.io/npm/\n")).toBe(
      "https://packagefeedproxy.microsoft.io/npm/",
    )
  })

  it("rejects registry URLs that could forward credentials", () => {
    expect(sanitizeNpmRegistry("https://token@registry.example.test/npm/")).toBeUndefined()
    expect(sanitizeNpmRegistry("https://registry.example.test/npm/?token=secret")).toBeUndefined()
    expect(sanitizeNpmRegistry("http://registry.example.test/npm/")).toBeUndefined()
  })
})

describe("builder network env forwarding", () => {
  it("forwards UV index and proxy variables from the host", () => {
    expect(
      builderNetworkEnv({
        UV_DEFAULT_INDEX: "https://mirrors.aliyun.com/pypi/simple/",
        HTTPS_PROXY: "http://proxy.example.test:8080",
        NO_PROXY: "localhost,127.0.0.1",
        UV_INDEX: "",
        PATH: "/usr/bin",
      }),
    ).toEqual([
      "--env",
      "UV_DEFAULT_INDEX=https://mirrors.aliyun.com/pypi/simple/",
      "--env",
      "HTTPS_PROXY=http://proxy.example.test:8080",
      "--env",
      "NO_PROXY=localhost,127.0.0.1",
    ])
  })

  it("injects a discovered PyPI index when host UV/PIP index env is unset", () => {
    expect(builderNetworkEnv({ PATH: "/usr/bin" }, { pypiIndex: microsoftProtectedPypiIndex })).toEqual([
      "--env",
      `UV_DEFAULT_INDEX=${microsoftProtectedPypiIndex}`,
      "--env",
      `PIP_INDEX_URL=${microsoftProtectedPypiIndex}`,
    ])
  })

  it("does not override an explicit UV_DEFAULT_INDEX with a discovered index", () => {
    expect(
      builderNetworkEnv(
        { UV_DEFAULT_INDEX: "https://example.test/simple/" },
        { pypiIndex: microsoftProtectedPypiIndex },
      ),
    ).toEqual([
      "--env",
      "UV_DEFAULT_INDEX=https://example.test/simple/",
      "--env",
      `PIP_INDEX_URL=${microsoftProtectedPypiIndex}`,
    ])
  })

  it("skips values that would break docker argv", () => {
    expect(
      builderNetworkEnv({
        UV_DEFAULT_INDEX: "https://example.test/simple/\n",
        HTTPS_PROXY: "http://proxy.example.test:8080\0",
      }),
    ).toEqual([])
  })
})

describe("PyPI index discovery", () => {
  it("accepts credential-free HTTPS simple indexes", () => {
    expect(sanitizePypiIndex(`  ${microsoftProtectedPypiIndex}  `)).toBe(microsoftProtectedPypiIndex)
    expect(sanitizePypiIndex("http://pypi.example.test/simple/")).toBeUndefined()
    expect(sanitizePypiIndex("https://user:pass@pypi.example.test/simple/")).toBeUndefined()
  })

  it("maps Microsoft npm packagefeedproxy to the CFS PyPI simple index", () => {
    expect(pypiIndexFromNpmRegistry("https://packagefeedproxy.microsoft.io/npm/")).toBe(microsoftProtectedPypiIndex)
    expect(pypiIndexFromNpmRegistry("https://registry.npmjs.org/")).toBeUndefined()
  })

  it("prefers UV_DEFAULT_INDEX, then pip config, then Microsoft npm inference", async () => {
    await expect(
      discoverPypiIndex({
        environment: { UV_DEFAULT_INDEX: "https://example.test/uv-simple/" },
        npmRegistry: "https://packagefeedproxy.microsoft.io/npm/",
        run: async () => ({ stdout: "global.index-url='https://example.test/pip-simple/'\n" }),
      }),
    ).resolves.toBe("https://example.test/uv-simple/")

    await expect(
      discoverPypiIndex({
        environment: {},
        npmRegistry: "https://packagefeedproxy.microsoft.io/npm/",
        run: async () => ({ stdout: "global.index-url='https://example.test/pip-simple/'\n" }),
      }),
    ).resolves.toBe("https://example.test/pip-simple/")

    await expect(
      discoverPypiIndex({
        environment: {},
        npmRegistry: "https://packagefeedproxy.microsoft.io/npm/",
        run: async () => {
          throw new Error("pip missing")
        },
      }),
    ).resolves.toBe(microsoftProtectedPypiIndex)
  })
})

const waitUntil = async (predicate: () => Promise<boolean>, message: string) => {
  const deadline = Date.now() + 10_000
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const writeReadyProfile = async (root: string, source: string, lock: Omit<ProfileLock, "profile_hash">) => {
  const profilePath = path.join(root, "profile.toml")
  await writeFile(profilePath, source)
  const document = await Effect.runPromise(parseProfile(source, profilePath))
  await writeFile(
    path.join(root, "profile.linux-arm64.lock.toml"),
    renderLock({ ...lock, platform: "linux/arm64", profile_hash: profileHash(document) }),
  )
  return profilePath
}

const copilotSource = `
schema = 1
name = "copilot"
description = "Copilot application profile"
[harness]
kind = "copilot"
version = "latest"
args = ["$(touch /tmp/profile-injection)", "COPILOT_GITHUB_TOKEN=secret"]
[harness.copilot]
auth = "host-or-login"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[plugins]]
adapter = "copilot-marketplace"
repository = "https://github.com/microsoft/hve-core.git"
ref = "main"
marketplace = "hve-core"
select = ["hve-core"]
`

const copilotLock = (profile_hash: string): ProfileLock => ({
  schema: 1,
  platform: "linux/arm64",
  source_date_epoch: 1784379906,
  profile_hash,
  sources: [
    {
      kind: "plugin",
      adapter: "copilot-marketplace",
      marketplace: "hve-core",
      plugin_versions: { "hve-core": "3.3.101" },
      repository: "https://github.com/microsoft/hve-core.git",
      ref: "main",
      select: ["hve-core"],
      commit: "a".repeat(40),
      integrity: treeIntegrity([]),
      files: [],
    },
  ],
  packages: {
    deja: arm64ArtifactCatalog.deja,
    harness: {
      kind: "copilot",
      selector: "latest",
      version: "1.0.75",
      integrity: digest("c"),
      url: "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
      size: 1024,
    },
    runtime: [
      {
        name: "bash",
        version: arm64ArtifactCatalog.runtimeVersions.bash,
        integrity: arm64ArtifactCatalog.runtimeIntegrities.bash,
      },
    ],
  },
  image: {
    base: "node:22.17.0-bookworm-slim",
    base_digest: arm64ArtifactCatalog.base.digest,
    final_digest: digest("e"),
  },
})

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

const piLock = (profile_hash: string): ProfileLock => ({
  schema: 1,
  platform: "linux/arm64",
  source_date_epoch: 1784379906,
  profile_hash,
  sources: [],
  packages: {
    deja: arm64ArtifactCatalog.deja,
    harness: {
      kind: "pi",
      selector: "latest",
      version: "17.2.6",
      integrity: "sha256:65cd7f5e7d537b0b41f277191c1b95b53d509f8147c3d1bd508503dc048f1453",
      url: "https://github.com/can1357/oh-my-pi/releases/download/v17.2.6/omp-linux-arm64",
      size: 157526160,
    },
    runtime: [
      {
        name: "bash",
        version: arm64ArtifactCatalog.runtimeVersions.bash,
        integrity: arm64ArtifactCatalog.runtimeIntegrities.bash,
      },
    ],
  },
  image: {
    base: "node:22.17.0-bookworm-slim",
    base_digest: arm64ArtifactCatalog.base.digest,
    final_digest: digest("e"),
  },
})

const primeSource = `
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

const primeLock = (profile_hash: string): ProfileLock => ({
  schema: 1,
  platform: "linux/arm64",
  source_date_epoch: 1784379906,
  profile_hash,
  sources: [],
  packages: {
    deja: arm64ArtifactCatalog.deja,
    harness: {
      kind: "prime",
      selector: "latest",
      version: "0.7.0",
      integrity: "sha256:88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b",
      url: "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.0/prime-agent-0.7.0.tgz",
      size: 9323789,
    },
    runtime: ["bash", "gh", "git"].map((name) => ({
      name,
      version: arm64ArtifactCatalog.runtimeVersions[name as keyof typeof arm64ArtifactCatalog.runtimeVersions],
      integrity: arm64ArtifactCatalog.runtimeIntegrities[name as keyof typeof arm64ArtifactCatalog.runtimeIntegrities],
    })),
  },
  image: {
    base: "node:22.17.0-bookworm-slim",
    base_digest: arm64ArtifactCatalog.base.digest,
    final_digest: digest("e"),
  },
})

const codexSource = `
schema = 1
name = "codex-upgrade"
description = "Codex upgrade profile"
[harness]
kind = "codex"
version = "0.144.6"
[harness.codex]
model = "gpt-5.5"
reasoning_effort = "medium"
model_provider = "proxy"
[harness.codex.providers.proxy]
base_url = "http://proxy:8080/v1"
wire_api = "responses"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[skills]]
repository = "https://github.com/obra/superpowers.git"
ref = "v6.2.0"
select = ["*"]
`

const codexLock = (profile_hash: string, finalDigest = digest("e")): ProfileLock => ({
  schema: 1,
  platform: "linux/arm64",
  source_date_epoch: 1784379906,
  profile_hash,
  sources: [
    {
      kind: "skill",
      repository: "https://github.com/obra/superpowers.git",
      ref: "v6.2.0",
      select: ["*"],
      commit: "a".repeat(40),
      integrity: treeIntegrity([{ kind: "file", path: "skills/example/SKILL.md", sha256: digest("f") }]),
      files: [{ kind: "file", path: "skills/example/SKILL.md", sha256: digest("f") }],
    },
  ],
  packages: {
    deja: arm64ArtifactCatalog.deja,
    harness: {
      kind: "codex",
      selector: "0.144.6",
      version: "0.144.6",
      integrity: "sha256:8eddae5e6c009dff9ba51ae1bfe3bdd9ff4c1ccc93a48cc6860db1cd9fdf11be",
      url: "https://github.com/openai/codex/releases/download/rust-v0.144.6/codex-aarch64-unknown-linux-musl.tar.gz",
      size: 101269986,
    },
    artifacts: [
      {
        name: "codex-code-mode-host",
        version: "0.144.6",
        integrity: "sha256:dfd4ff98ea4db30ed078af9c31b6f86e3da4836d0573aa87e225e5a5b54d3c7c",
        url: "https://github.com/openai/codex/releases/download/rust-v0.144.6/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
        size: 17260137,
      },
    ],
    skills_cli_version: "1.5.19",
    skills_cli_integrity:
      "sha512-SR05cbNk+R17GfaCFv94Hlq5EXDpUCbG0ZL9+EYi5UEHzUPAAl+kls2LxCT+67wAWlOAanUwzZekIVQvpCmp5w==",
    runtime: [
      {
        name: "bash",
        version: "5.2.15-2+b13",
        integrity: "sha256:fdb470b5ec1773b90014138bfc1deda4505c1c23e7f5731e8b527c636ac03385",
      },
    ],
  },
  image: {
    base: "node:22.17.0-bookworm-slim",
    base_digest: "sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0",
    final_digest: finalDigest,
  },
})

describe("profile metadata", () => {
  it("omits the resolved harness version when the same-kind lock is not ready", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-metadata-stale-lock-"))
    const profilePath = path.join(root, "profile.toml")
    const source = copilotSource.replace('name = "copilot"', 'name = "copilot-hve"')
    await writeFile(profilePath, source)
    const document = await Effect.runPromise(parseProfile(source, profilePath))
    const files = [{ kind: "file" as const, path: "plugins/example/plugin.json", sha256: digest("f") }]
    const staleLock = {
      ...copilotLock(profileHash(document)),
      sources: copilotLock(profileHash(document)).sources.map((source) => ({
        ...source,
        integrity: treeIntegrity(files),
        files,
      })),
      packages: {
        ...copilotLock(profileHash(document)).packages,
        harness: {
          ...copilotLock(profileHash(document)).packages.harness,
          selector: "1.0.74",
        },
      },
    } satisfies ProfileLock
    await writeFile(path.join(root, "profile.linux-arm64.lock.toml"), renderLock(staleLock))

    const metadata = await Effect.runPromise(profileMetadata(profilePath, "linux/arm64"))
    expect(metadata).toMatchObject({
      harness_kind: "copilot",
      locked: false,
      resolved_version: null,
    })
    expect.soft(metadata.image).toBe("trellage-profile-copilot-hve-linux-arm64:locked")
    expect.soft(metadata.runtime_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect.soft(metadata.build_command).toContain("trellage build --locked")
    expect.soft(metadata.runtime_entry).toBe("trellage-copilot-entry")
    expect.soft(metadata.tmpfs_size).toBe("256m")
    const applicationSource = await readFile(fileURLToPath(new URL("../src/application.ts", import.meta.url)), "utf8")
    expect.soft(applicationSource).toContain('path.join(xdgCacheHome, "trellage",')
    expect.soft(applicationSource).not.toContain('path.join(xdgCacheHome, "harness",')
  })

  it("reports configured tmpfs size", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-metadata-tmpfs-size-"))
    const profilePath = path.join(root, "profile.toml")
    const source = copilotSource
      .replace('name = "copilot"', 'name = "copilot-tmpfs-size"')
      .replace(
        'description = "Copilot application profile"',
        'description = "Copilot application profile"\n[runtime]\ntmpfs_size = "2g"',
      )
    await writeFile(profilePath, source)
    const document = await Effect.runPromise(parseProfile(source, profilePath))
    const files = [{ kind: "file" as const, path: "plugins/example/plugin.json", sha256: digest("f") }]
    const lock = {
      ...copilotLock(profileHash(document)),
      sources: copilotLock(profileHash(document)).sources.map((source) => ({
        ...source,
        integrity: treeIntegrity(files),
        files,
      })),
    } satisfies ProfileLock
    await writeFile(path.join(root, "profile.linux-arm64.lock.toml"), renderLock(lock))

    const metadata = await Effect.runPromise(profileMetadata(profilePath, "linux/arm64"))
    expect(metadata.tmpfs_size).toBe("2g")
  })

  it("reports Pi runtime identity and bridge networking from a ready lock", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-metadata-pi-"))
    const profilePath = await writeReadyProfile(root, piSource, piLock("replaced-by-writeReadyProfile"))

    const metadata = await Effect.runPromise(profileMetadata(profilePath, "linux/arm64"))

    expect(metadata).toMatchObject({
      harness_kind: "pi",
      harness_executable: "omp",
      image: "trellage-profile-pi-oh-my-pi-linux-arm64:locked",
      locked: true,
      resolved_version: "17.2.6",
      runtime_entry: "trellage-pi-entry",
      default_network: "bridge",
      auth_policy: "host-or-login",
    })
    expect(metadata.runtime_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it("reports Prime proxy identity without model credentials", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-metadata-prime-"))
    const profilePath = await writeReadyProfile(root, primeSource, primeLock("replaced-by-writeReadyProfile"))

    const metadata = await Effect.runPromise(profileMetadata(profilePath, "linux/arm64"))

    expect(metadata).toMatchObject({
      harness_kind: "prime",
      harness_executable: "prime-agent",
      image: "trellage-profile-prime-agent-linux-arm64:locked",
      locked: true,
      resolved_version: "0.7.0",
      runtime_entry: "trellage-prime-entry",
      default_network: "copilot-proxy-rs_default",
      auth_policy: "proxy",
      prime_provider: "copilot-proxy-rs",
      prime_model: "claude-opus-5",
      prime_base_url: "http://copilot-proxy-rs:8080",
    })
    expect(metadata.runtime_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(JSON.stringify(metadata)).not.toMatch(
      /ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN/,
    )
  })
})

describe("transactional profile upgrade", () => {
  beforeEach(() => {
    mocks.failUnlockedSourceResolutions = 0
    mocks.failPackageResolutions = 0
    mocks.failLockRenames = 0
    mocks.lockRenameEvents = undefined
  })

  it("keeps lock file services private to the application transaction", async () => {
    const application = await import("../src/application.js")
    expect(application).not.toHaveProperty("LiveUpgradeFileServices")
  })

  it("commits the candidate image and matching lock before cleaning temporary tags", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-upgrade-success-"))
    const profilePath = path.join(root, "profile.toml")
    await writeFile(profilePath, codexSource)
    const document = await Effect.runPromise(parseProfile(codexSource, profilePath))
    await writeFile(path.join(root, "profile.linux-arm64.lock.toml"), renderLock(codexLock(profileHash(document))))
    const support = runtimeSupport(root)
    await writeFile(support.codexEntry, "#!/bin/sh\n")

    const canonical = "trellage-profile-codex-upgrade-linux-arm64:locked"
    const candidate = `trellage-profile-codex-upgrade-linux-arm64:candidate-${process.pid}`
    const backup = `trellage-profile-codex-upgrade-linux-arm64:backup-${process.pid}`
    const builtDigest = digest("9")
    const events: Array<string> = []
    const services: UpgradeServices = {
      buildCandidate: (_document, lock, image) =>
        Effect.sync(() => {
          events.push(`build:${image}:${String(lock.image.final_digest)}`)
          return builtDigest
        }),
      imageExists: (image) =>
        Effect.sync(() => {
          events.push(`exists:${image}`)
          return image === canonical
        }),
      tagImage: (source, destination) =>
        Effect.sync(() => {
          events.push(`tag:${source}->${destination}`)
        }),
      removeImage: (image) =>
        Effect.sync(() => {
          events.push(`remove:${image}`)
        }),
    }

    mocks.sourceFiles = [{ kind: "file", path: "skills/example/SKILL.md", sha256: digest("f") }]
    mocks.lockRenameEvents = events

    await expect(Effect.runPromise(upgradeProfile(profilePath, root, support, arm64Target, services))).resolves.toEqual(
      {
        image: canonical,
        digest: builtDigest,
        fallbacks: [],
      },
    )
    mocks.sourceFiles = []
    expect(events).toEqual([
      `build:${candidate}:undefined`,
      `exists:${canonical}`,
      `tag:${canonical}->${backup}`,
      `tag:${candidate}->${canonical}`,
      expect.stringMatching(
        /^tag:trellage-profile-codex-upgrade-linux-arm64:locked->trellage-profile-codex-upgrade-linux-arm64:h-[0-9a-f]{12}-[0-9a-f]{12}$/,
      ),
      "write:lock",
      `remove:${candidate}`,
      `remove:${backup}`,
    ])
    const finalLock = codexLock(profileHash(document), builtDigest)
    expect(await readFile(path.join(root, "profile.linux-arm64.lock.toml"), "utf8")).toBe(renderLock(finalLock))
    expect(events.join(" ")).not.toMatch(/container|volume|state/i)
  })

  const prepare = async (source = codexSource) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-upgrade-transaction-"))
    const profilePath = path.join(root, "profile.toml")
    await writeFile(profilePath, source)
    const document = await Effect.runPromise(parseProfile(source, profilePath))
    const original = renderLock(codexLock(profileHash(document)))
    await writeFile(path.join(root, "profile.linux-arm64.lock.toml"), original)
    const support = runtimeSupport(root)
    await writeFile(support.codexEntry, "#!/bin/sh\n")
    mocks.sourceFiles = [{ kind: "file", path: "skills/example/SKILL.md", sha256: digest("f") }]
    return {
      root,
      profilePath,
      support,
      original,
      lockPath: path.join(root, "profile.linux-arm64.lock.toml"),
      canonical: "trellage-profile-codex-upgrade-linux-arm64:locked",
      candidate: `trellage-profile-codex-upgrade-linux-arm64:candidate-${process.pid}`,
      backup: `trellage-profile-codex-upgrade-linux-arm64:backup-${process.pid}`,
    }
  }

  const failed = (message: string) => Effect.fail(new ApplicationError({ message }))

  it("retries candidate builds and forwards the configured npm registry", async () => {
    const fixture = await prepare()
    const registries: Array<string | undefined> = []
    let attempts = 0
    const services: UpgradeServices = {
      buildCandidate: (_document, _lock, _image, npmRegistry) =>
        Effect.suspend(() => {
          attempts += 1
          registries.push(npmRegistry)
          return attempts < 3
            ? Effect.fail(new ApplicationError({ message: "ECONNRESET during npm install" }))
            : Effect.succeed(digest("9"))
        }),
      imageExists: () => Effect.succeed(false),
      tagImage: () => Effect.void,
      removeImage: () => Effect.void,
    }

    await expect(
      Effect.runPromise(
        upgradeProfile(
          fixture.profilePath,
          fixture.root,
          fixture.support,
          arm64Target,
          services,
          "https://packagefeedproxy.microsoft.io/npm/",
        ),
      ),
    ).resolves.toEqual({ image: fixture.canonical, digest: digest("9"), fallbacks: [] })
    expect(attempts).toBe(3)
    expect(registries).toEqual([
      "https://packagefeedproxy.microsoft.io/npm/",
      "https://packagefeedproxy.microsoft.io/npm/",
      "https://packagefeedproxy.microsoft.io/npm/",
    ])
  })

  it("falls back to the verified locked source after latest resolution retries are exhausted", async () => {
    const fixture = await prepare()
    const builtLocks: Array<ProfileLock> = []
    mocks.requests.length = 0
    mocks.failUnlockedSourceResolutions = 3
    const services: UpgradeServices = {
      buildCandidate: (_document, lock) =>
        Effect.sync(() => {
          builtLocks.push(lock)
          return digest("9")
        }),
      imageExists: () => Effect.succeed(false),
      tagImage: () => Effect.void,
      removeImage: () => Effect.void,
    }

    await expect(
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, arm64Target, services)),
    ).resolves.toEqual({
      image: fixture.canonical,
      digest: digest("9"),
      fallbacks: [`source https://github.com/obra/superpowers.git@v6.2.0 -> ${"a".repeat(40)}`],
    })
    expect(mocks.requests).toEqual([
      expect.not.objectContaining({ lockedCommit: expect.anything() }),
      expect.not.objectContaining({ lockedCommit: expect.anything() }),
      expect.not.objectContaining({ lockedCommit: expect.anything() }),
      expect.objectContaining({ lockedCommit: "a".repeat(40) }),
    ])
    expect(builtLocks[0]?.sources[0]?.commit).toBe("a".repeat(40))
  })

  it("falls back to the verified harness when latest package resolution remains inaccessible", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-upgrade-package-fallback-"))
    const profilePath = await writeReadyProfile(root, piSource, piLock("replaced-by-writeReadyProfile"))
    const support = runtimeSupport(root)
    await writeFile(support.piEntry, "#!/bin/sh\n")
    mocks.failPackageResolutions = 3
    const services: UpgradeServices = {
      buildCandidate: () => Effect.succeed(digest("9")),
      imageExists: () => Effect.succeed(false),
      tagImage: () => Effect.void,
      removeImage: () => Effect.void,
    }

    await expect(Effect.runPromise(upgradeProfile(profilePath, root, support, arm64Target, services))).resolves.toEqual(
      {
        image: "trellage-profile-pi-oh-my-pi-linux-arm64:locked",
        digest: digest("9"),
        fallbacks: ["harness pi@latest -> 17.2.6"],
      },
    )
  })

  it("preflights runtime support before resolution or image mutation", async () => {
    const fixture = await prepare()
    mocks.requests.length = 0
    const events: Array<string> = []
    const services: UpgradeServices = {
      buildCandidate: () =>
        Effect.sync(() => {
          events.push("build")
          return digest("9")
        }),
      imageExists: () =>
        Effect.sync(() => {
          events.push("exists")
          return true
        }),
      tagImage: () =>
        Effect.sync(() => {
          events.push("tag")
        }),
      removeImage: () =>
        Effect.sync(() => {
          events.push("remove")
        }),
    }

    await expect(
      Effect.runPromise(
        upgradeProfile(
          fixture.profilePath,
          fixture.root,
          runtimeSupport(path.join(fixture.root, "missing-support")),
          arm64Target,
          services,
        ),
      ),
    ).rejects.toThrow(/Codex runtime support codexEntry.*regular readable file/)
    expect(mocks.requests).toEqual([])
    expect(events).toEqual([])
    expect(await readFile(fixture.lockPath, "utf8")).toBe(fixture.original)
  })

  it("does not mutate images or lock bytes when resolution fails", async () => {
    const fixture = await prepare(
      codexSource.replace('base = "node:22.17.0-bookworm-slim"', 'base = "unsupported.invalid:1"'),
    )
    const events: Array<string> = []
    const services: UpgradeServices = {
      buildCandidate: () =>
        Effect.sync(() => {
          events.push("build")
          return digest("9")
        }),
      imageExists: () =>
        Effect.sync(() => {
          events.push("exists")
          return true
        }),
      tagImage: () =>
        Effect.sync(() => {
          events.push("tag")
        }),
      removeImage: () =>
        Effect.sync(() => {
          events.push("remove")
        }),
    }

    await expect(
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, arm64Target, services)),
    ).rejects.toThrow(/base image resolution failed/)
    expect(events).toEqual([])
    expect(await readFile(fixture.lockPath, "utf8")).toBe(fixture.original)
  })

  it("cleans a partial candidate while preserving the old lock and canonical image", async () => {
    const fixture = await prepare()
    const events: Array<string> = []
    const services: UpgradeServices = {
      buildCandidate: (_document, _lock, image) =>
        Effect.sync(() => {
          events.push(`build:${image}`)
        }).pipe(Effect.zipRight(failed("candidate build failed"))),
      imageExists: () => Effect.die("canonical inspection must not run"),
      tagImage: () => Effect.die("tag must not run"),
      removeImage: (image) =>
        Effect.sync(() => {
          events.push(`remove:${image}`)
        }),
    }

    await expect(
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, arm64Target, services)),
    ).rejects.toThrow(/candidate build failed/)
    expect(events).toEqual([`build:${fixture.candidate}`, `remove:${fixture.candidate}`])
    expect(await readFile(fixture.lockPath, "utf8")).toBe(fixture.original)
  })

  it("preserves the old canonical image and lock when backup tagging fails", async () => {
    const fixture = await prepare()
    const events: Array<string> = []
    const services: UpgradeServices = {
      buildCandidate: () => Effect.succeed(digest("9")),
      imageExists: () => Effect.succeed(true),
      tagImage: (source, destination) =>
        Effect.sync(() => {
          events.push(`tag:${source}->${destination}`)
        }).pipe(Effect.zipRight(failed("backup tag failed"))),
      removeImage: (image) =>
        Effect.sync(() => {
          events.push(`remove:${image}`)
        }),
    }

    await expect(
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, arm64Target, services)),
    ).rejects.toThrow(/backup tag failed/)
    expect(events).toEqual([
      `tag:${fixture.canonical}->${fixture.backup}`,
      `remove:${fixture.candidate}`,
      `remove:${fixture.backup}`,
    ])
    expect(await readFile(fixture.lockPath, "utf8")).toBe(fixture.original)
  })

  it("restores the prior canonical association when canonical tagging fails after mutation", async () => {
    const fixture = await prepare()
    const oldImage = "sha256:old-image"
    const candidateImage = "sha256:candidate-image"
    const images = new Map([
      [fixture.canonical, oldImage],
      [fixture.candidate, candidateImage],
    ])
    let canonicalAttempts = 0
    const services: UpgradeServices = {
      buildCandidate: () => Effect.succeed(digest("9")),
      imageExists: (image) => Effect.succeed(images.has(image)),
      tagImage: (source, destination) =>
        Effect.suspend(() => {
          images.set(destination, images.get(source)!)
          if (destination === fixture.canonical && canonicalAttempts++ === 0) return failed("canonical tag failed")
          return Effect.void
        }),
      removeImage: (image) =>
        Effect.sync(() => {
          images.delete(image)
        }),
    }

    await expect(
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, arm64Target, services)),
    ).rejects.toThrow(/canonical tag failed/)
    expect(images.get(fixture.canonical)).toBe(oldImage)
    expect(images.has(fixture.candidate)).toBe(false)
    expect(images.has(fixture.backup)).toBe(false)
    expect(await readFile(fixture.lockPath, "utf8")).toBe(fixture.original)
  })

  it("restores exact lock bytes and canonical image when atomic lock replacement fails", async () => {
    const fixture = await prepare()
    const oldImage = "sha256:old-image"
    const images = new Map([
      [fixture.canonical, oldImage],
      [fixture.candidate, "sha256:candidate-image"],
    ])
    const writes: Array<string> = []
    mocks.lockRenameEvents = writes
    mocks.failLockRenames = 1
    const services: UpgradeServices = {
      buildCandidate: () => Effect.succeed(digest("9")),
      imageExists: (image) => Effect.succeed(images.has(image)),
      tagImage: (source, destination) =>
        Effect.sync(() => {
          images.set(destination, images.get(source)!)
        }),
      removeImage: (image) =>
        Effect.sync(() => {
          images.delete(image)
        }),
    }

    await expect(
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, arm64Target, services)),
    ).rejects.toThrow(/cannot write lock/)
    expect(writes).toHaveLength(2)
    expect(images.get(fixture.canonical)).toBe(oldImage)
    expect(await readFile(fixture.lockPath, "utf8")).toBe(fixture.original)
  })

  it("keeps the original failure primary while exposing compensation failure", async () => {
    const fixture = await prepare()
    let canonicalTags = 0
    const services: UpgradeServices = {
      buildCandidate: () => Effect.succeed(digest("9")),
      imageExists: () => Effect.succeed(true),
      tagImage: (_source, destination) => {
        if (destination !== fixture.canonical) return Effect.void
        canonicalTags += 1
        return failed(canonicalTags === 1 ? "primary canonical failure" : "restore canonical failure")
      },
      removeImage: () => Effect.void,
    }

    const exit = await Effect.runPromiseExit(
      upgradeProfile(fixture.profilePath, fixture.root, fixture.support, arm64Target, services),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) throw new Error("expected upgrade failure")
    const cause = Cause.pretty(exit.cause)
    expect(cause.indexOf("primary canonical failure")).toBeLessThan(cause.indexOf("restore canonical failure"))
    expect(await readFile(fixture.lockPath, "utf8")).toBe(fixture.original)
  })

  it("removes a newly-created canonical image during rollback when none existed", async () => {
    const fixture = await prepare()
    await rm(fixture.lockPath)
    const images = new Map([[fixture.candidate, "sha256:candidate-image"]])
    const services: UpgradeServices = {
      buildCandidate: () => Effect.succeed(digest("9")),
      imageExists: (image) => Effect.succeed(images.has(image)),
      tagImage: (source, destination) =>
        Effect.sync(() => {
          images.set(destination, images.get(source)!)
        }),
      removeImage: (image) =>
        Effect.sync(() => {
          images.delete(image)
        }),
    }
    mocks.failLockRenames = 1

    await expect(
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, arm64Target, services)),
    ).rejects.toThrow(/cannot write lock/)
    expect(images.has(fixture.canonical)).toBe(false)
    await expect(readFile(fixture.lockPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("reports cleanup failure without rolling back a committed upgrade", async () => {
    const fixture = await prepare()
    const images = new Map([
      [fixture.canonical, "sha256:old-image"],
      [fixture.candidate, "sha256:candidate-image"],
    ])
    const builtDigest = digest("9")
    const services: UpgradeServices = {
      buildCandidate: () => Effect.succeed(builtDigest),
      imageExists: (image) => Effect.succeed(images.has(image)),
      tagImage: (source, destination) =>
        Effect.sync(() => {
          images.set(destination, images.get(source)!)
        }),
      removeImage: (image) =>
        image === fixture.candidate
          ? failed("candidate cleanup failed")
          : Effect.sync(() => {
              images.delete(image)
            }),
    }

    await expect(
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, arm64Target, services)),
    ).rejects.toThrow(/upgrade committed but cleanup failed/)
    expect(images.get(fixture.canonical)).toBe("sha256:candidate-image")
    expect(await readFile(fixture.lockPath, "utf8")).toContain(`final_digest = "${builtDigest}"`)
  })

  it("restores the old image and lock when the fiber is interrupted after canonical mutation", async () => {
    const fixture = await prepare()
    const oldImage = "sha256:old-image"
    const images = new Map([
      [fixture.canonical, oldImage],
      [fixture.candidate, "sha256:candidate-image"],
    ])
    const services: UpgradeServices = {
      buildCandidate: () => Effect.succeed(digest("9")),
      imageExists: (image) => Effect.succeed(images.has(image)),
      tagImage: (source, destination) =>
        Effect.sync(() => {
          images.set(destination, images.get(source)!)
        }).pipe(Effect.zipRight(destination === fixture.canonical ? Effect.interrupt : Effect.void)),
      removeImage: (image) =>
        Effect.sync(() => {
          images.delete(image)
        }),
    }

    await expect(
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, arm64Target, services)),
    ).rejects.toThrow()
    expect(images.get(fixture.canonical)).toBe(oldImage)
    expect(images.has(fixture.candidate)).toBe(false)
    expect(images.has(fixture.backup)).toBe(false)
    expect(await readFile(fixture.lockPath, "utf8")).toBe(fixture.original)
  })

  it.skipIf(process.env.HARNESS_UPGRADE_CONTENTION_ROLE !== undefined)(
    "allows only one process to enter while reclaiming one orphaned stale lease",
    async () => {
      const fixture = await prepare()
      const contentionRoot = path.join(fixture.root, "contention")
      const leasePath = path.join(fixture.root, "trellage", "upgrade-locks", "codex-upgrade.lock")
      await mkdir(contentionRoot, { recursive: true })
      await mkdir(leasePath, { recursive: true })
      await utimes(leasePath, new Date(0), new Date(0))

      const vitest = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url))
      const worker = (role: string) =>
        execFilePromise(
          process.execPath,
          [vitest, "run", "test/application.test.ts", "-t", "upgrade contention worker", "--reporter=dot"],
          {
            cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
            env: {
              ...process.env,
              HARNESS_UPGRADE_CONTENTION_ROLE: role,
              HARNESS_UPGRADE_CONTENTION_ROOT: contentionRoot,
              HARNESS_UPGRADE_CONTENTION_PROFILE: fixture.profilePath,
            },
          },
        )
      const winner = worker("one")
      let contender: ReturnType<typeof worker> | undefined

      try {
        await waitUntil(
          () => pathExists(path.join(contentionRoot, "ready-one")),
          "contention winner did not become ready",
        )
        await writeFile(path.join(contentionRoot, "go"), "go")
        await waitUntil(
          () => pathExists(path.join(contentionRoot, "entered-one")),
          "contention winner did not reclaim and enter",
        )
        expect(await pathExists(path.join(fixture.root, "harness", "upgrade-locks"))).toBe(false)
        contender = worker("two")
        await waitUntil(
          () => pathExists(path.join(contentionRoot, "ready-two")),
          "contention contender did not become ready",
        )
        await waitUntil(async () => {
          const resultPath = path.join(contentionRoot, "result-two")
          if (!(await pathExists(resultPath))) return false
          return (
            (await readFile(resultPath, "utf8")) ===
            "failure:upgrade already active for profile: codex-upgrade-linux-arm64"
          )
        }, "contention contender did not report ELOCKED while winner held the lease")
      } finally {
        await writeFile(path.join(contentionRoot, "release"), "release")
      }

      if (contender === undefined) throw new Error("contention contender was not started")
      await Promise.all([winner, contender])
      const entries = (
        await Promise.all(
          ["one", "two"].map(async (role) =>
            (await pathExists(path.join(contentionRoot, `entered-${role}`))) ? role : undefined,
          ),
        )
      ).filter((role): role is string => role !== undefined)
      const results = await Promise.all(
        ["one", "two"].map((role) => readFile(path.join(contentionRoot, `result-${role}`), "utf8")),
      )

      expect(entries).toEqual(["one"])
      expect(results).toEqual(["success", "failure:upgrade already active for profile: codex-upgrade-linux-arm64"])
    },
    20_000,
  )

  it.skipIf(process.env.HARNESS_UPGRADE_CONTENTION_ROLE === undefined)(
    "upgrade contention worker",
    async () => {
      const role = process.env.HARNESS_UPGRADE_CONTENTION_ROLE as string
      const contentionRoot = process.env.HARNESS_UPGRADE_CONTENTION_ROOT as string
      const profilePath = process.env.HARNESS_UPGRADE_CONTENTION_PROFILE as string
      const support = runtimeSupport(path.dirname(profilePath))
      mocks.sourceFiles = [{ kind: "file", path: "skills/example/SKILL.md", sha256: digest("f") }]
      await writeFile(path.join(contentionRoot, `ready-${role}`), "ready")
      await waitUntil(() => pathExists(path.join(contentionRoot, "go")), "contention start was not released")
      const services: UpgradeServices = {
        buildCandidate: () =>
          Effect.promise(async () => {
            await writeFile(path.join(contentionRoot, `entered-${role}`), "entered")
            await waitUntil(
              () => pathExists(path.join(contentionRoot, "release")),
              "contention winner was not released",
            )
            return digest("9")
          }),
        imageExists: () => Effect.succeed(false),
        tagImage: () => Effect.void,
        removeImage: () => Effect.void,
      }

      let result = "success"
      try {
        await Effect.runPromise(upgradeProfile(profilePath, path.dirname(profilePath), support, arm64Target, services))
      } catch (cause) {
        result = `failure:${String((cause as { readonly message?: unknown }).message ?? cause)}`
      }
      await writeFile(path.join(contentionRoot, `result-${role}`), result)
    },
    20_000,
  )

  it("fails closed when the same profile upgrade is already active in this process", async () => {
    const fixture = await prepare()
    let releaseBuild!: () => void
    let signalStarted!: () => void
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve
    })
    const services: UpgradeServices = {
      buildCandidate: () =>
        Effect.promise(
          () =>
            new Promise<string>((resolve) => {
              releaseBuild = () => resolve(digest("9"))
              signalStarted()
            }),
        ),
      imageExists: () => Effect.succeed(false),
      tagImage: () => Effect.void,
      removeImage: () => Effect.void,
    }
    const first = Effect.runPromise(
      upgradeProfile(fixture.profilePath, fixture.root, fixture.support, arm64Target, services),
    )
    await started
    await expect(
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, arm64Target, services)),
    ).rejects.toThrow(/upgrade already active/)
    releaseBuild()
    await expect(first).resolves.toEqual({ image: fixture.canonical, digest: digest("9"), fallbacks: [] })
  })
})

describe("locked builder command", () => {
  it("installs locked native Claude marketplace plugins before finalizing the seed", async () => {
    const source = `
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
packages = ["bash", "git", "jq"]
[[plugins]]
adapter = "claude-marketplace"
repository = "https://github.com/charlie947/social-media-skills.git"
ref = "main"
marketplace = "social-media-skills"
select = ["social-media-skills"]
[[plugins]]
adapter = "claude-marketplace"
repository = "https://github.com/blader/humanizer.git"
ref = "main"
marketplace = "humanizer"
select = ["humanizer"]
`
    const document = await Effect.runPromise(parseProfile(source, "/profiles/claude-social-media/profile.toml"))
    const lock: ProfileLock = {
      schema: 1,
      platform: "linux/arm64",
      source_date_epoch: 1784379906,
      profile_hash: profileHash(document),
      sources: [
        {
          kind: "plugin",
          adapter: "claude-marketplace",
          marketplace: "social-media-skills",
          plugin_versions: { "social-media-skills": "1.0.0" },
          repository: "https://github.com/charlie947/social-media-skills.git",
          ref: "main",
          select: ["social-media-skills"],
          commit: "a".repeat(40),
          integrity: digest("b"),
          files: [],
        },
        {
          kind: "plugin",
          adapter: "claude-marketplace",
          marketplace: "humanizer",
          plugin_versions: { humanizer: "2.9.1" },
          repository: "https://github.com/blader/humanizer.git",
          ref: "main",
          select: ["humanizer"],
          commit: "e".repeat(40),
          integrity: digest("f"),
          files: [],
        },
      ],
      packages: {
        deja: arm64ArtifactCatalog.deja,
        harness: {
          kind: "claude",
          selector: "2.1.218",
          version: "2.1.218",
          integrity: digest("c"),
          url: "https://github.com/anthropics/claude-code/releases/download/v2.1.218/claude-linux-arm64.tar.gz",
          size: 88123930,
        },
        runtime: [],
      },
      image: { base: "node:22.17.0-bookworm-slim", base_digest: digest("d") },
    }

    const script = builderScript(document, lock)

    expect(script).toContain("mise install --locked node@22.17.0 http:claude@2.1.218")
    expect(script).toContain('claude_metadata="$claude_dir/metadata.json"')
    expect(script).toContain(
      'sed -i -E "s/^  \\"extracted_at\\": [0-9]+,$/  \\"extracted_at\\": $SOURCE_DATE_EPOCH,/" "$claude_metadata"',
    )
    expect(script).toContain('find /mise/installs -name metadata.json -type f ! -path "$claude_metadata" -delete')
    expect(script).toContain(
      "CLAUDE_CONFIG_DIR=/src/claude-seed DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1",
    )
    expect(script).toContain("plugin marketplace add /src/claude-marketplace-0")
    expect(script).toContain("plugin marketplace add /src/claude-marketplace-1")
    expect(script).toContain("plugin install social-media-skills@social-media-skills --scope user")
    expect(script).toContain("plugin install humanizer@humanizer --scope user")
    expect(script).toContain("/src/finalize-claude-seed.mjs /src/claude-seed /src/claude-marketplaces.json 2.1.218")
    expect(script).not.toMatch(/hyperresearch|playwright|obscura|APIFY_API_TOKEN|GOOGLE_AI_API_KEY/)
  })

  it("installs and verifies the exact locked Copilot plugin before finalizing the seed", async () => {
    const document = await Effect.runPromise(parseProfile(copilotSource, "/tmp/copilot/profile.toml"))
    const script = builderScript(document, copilotLock(profileHash(document)))
    const commands = [
      "mise install --locked http:copilot@1.0.75",
      'copilot_dir="$(mise where http:copilot@1.0.75)"',
      'copilot_bin="$copilot_dir/copilot"',
      '[ -x "$copilot_bin" ]',
      'rm -f "$copilot_dir/metadata.json"',
      'COPILOT_HOME=/src/copilot-seed COPILOT_AUTO_UPDATE=false NO_COLOR=1 TERM=dumb "$copilot_bin" plugin marketplace add /src/hve-core',
      'COPILOT_HOME=/src/copilot-seed COPILOT_AUTO_UPDATE=false NO_COLOR=1 TERM=dumb "$copilot_bin" plugin install hve-core@hve-core',
      'COPILOT_HOME=/src/copilot-seed COPILOT_AUTO_UPDATE=false NO_COLOR=1 TERM=dumb "$copilot_bin" plugin list',
      "[ -x /mise/installs/node/24.18.0/bin/node ]",
      "/mise/installs/node/24.18.0/bin/node /src/finalize-copilot-seed.mjs /src/copilot-seed hve-core hve-core 3.3.101",
      'PATH=/src/build-support:$PATH mise oci build --locked --output "$OUTPUT_DIR" --tag "$IMAGE_REF"',
    ]

    for (const command of commands) expect(script).toContain(command)
    for (let index = 1; index < commands.length; index += 1) {
      expect(script.indexOf(commands[index]!)).toBeGreaterThan(script.indexOf(commands[index - 1]!))
    }
    expect(script).toContain("$0 == expected { count++ } END { exit count == 1 ? 0 : 1 }")
    expect(script).toContain("plugin_list_status=0")
    expect(script).toContain("|| plugin_list_status=$?")
    expect(script).toContain('[ "$plugin_list_status" -eq 0 ]')
    expect(script).not.toMatch(
      /login|\/Users\/|\.copilot|COPILOT_GITHUB_TOKEN|GH_TOKEN|GITHUB_TOKEN|secret|profile-injection|latest/,
    )
    expect(script).toContain("deja_archive='/src/deja-vu_0.17.0_linux_arm64.tar.gz'")
    expect(script).toContain("tar --no-same-owner --no-same-permissions")
    expect(script).toContain("'/src/deja/linux_arm64/deja'")
  })

  it("retains the locked Codex install, metadata removal, and OCI build sequence", async () => {
    const source = copilotSource
      .replace('name = "copilot"', 'name = "codex"')
      .replace('kind = "copilot"', 'kind = "codex"')
      .replace(
        'version = "latest"\nargs = ["$(touch /tmp/profile-injection)", "COPILOT_GITHUB_TOKEN=secret"]\n[harness.copilot]\nauth = "host-or-login"',
        'version = "0.144.6"\n[harness.codex]\nmodel = "gpt-5.5"\nreasoning_effort = "medium"\nmodel_provider = "proxy"\n[harness.codex.providers.proxy]\nbase_url = "http://proxy:8080/v1"\nwire_api = "responses"',
      )
      .replace('adapter = "copilot-marketplace"\n', 'adapter = "codex-native"\n')
      .replace('marketplace = "hve-core"\n', "")
    const document = await Effect.runPromise(parseProfile(source, "/tmp/codex/profile.toml"))
    const lock: ProfileLock = {
      ...copilotLock(profileHash(document)),
      sources: [],
      packages: {
        ...copilotLock(profileHash(document)).packages,
        harness: {
          kind: "codex",
          selector: "0.144.6",
          version: "0.144.6",
          integrity: digest("c"),
          url: "https://example.test/codex.tar.gz",
          size: 1024,
        },
        artifacts: [
          {
            name: "codex-code-mode-host",
            version: "0.144.6",
            integrity: digest("e"),
            url: "https://github.com/openai/codex/releases/download/rust-v0.144.6/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
            size: 17260137,
          },
        ],
        skills_cli_version: "1.5.19",
        skills_cli_integrity: "sha512-dGVzdA==",
      },
    }

    const script = builderScript(document, lock)
    expect(script).toContain(
      'mise install --locked http:codex@0.144.6; codex_dir="$(mise where http:codex@0.144.6)"; rm -f "$codex_dir/metadata.json"',
    )
    expect(script).toContain(
      "mv '/tmp/trellage-codex-code-mode-host/codex-code-mode-host-aarch64-unknown-linux-musl' \"$codex_dir/codex-code-mode-host\"",
    )
    expect(script).toContain(
      "curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 --output '/src/codex-code-mode-host.tar.gz' 'https://github.com/openai/codex/releases/download/rust-v0.144.6/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz'",
    )
    expect(script).toContain("install -m 0755 '/src/.deja-stage/deja' '/src/deja/linux_arm64/deja'")
  })

  it("installs the exact locked Pi executable before the OCI build", async () => {
    const document = await Effect.runPromise(parseProfile(piSource, "/profiles/pi-oh-my-pi/profile.toml"))

    const script = builderScript(document, piLock(profileHash(document)))
    expect(script).toContain(
      'mise install --locked http:pi@17.2.6; pi_dir="$(mise where http:pi@17.2.6)"; rm -f "$pi_dir/metadata.json"',
    )
    expect(script).toContain("install -m 0755 '/src/.deja-stage/deja' '/src/deja/linux_arm64/deja'")
  })

  it("verifies and installs only the exact locked Prime tarball before the OCI build", async () => {
    const document = await Effect.runPromise(parseProfile(primeSource, "/profiles/prime-agent/profile.toml"))
    const lock = primeLock(profileHash(document))
    const script = builderScript(document, lock)
    const commands = [
      "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.0/prime-agent-0.7.0.tgz",
      'wc -c < "$prime_artifact"',
      "sha256sum --check --strict",
      "rm -f /mise/config.toml",
      "mise install --locked node@22.17.0",
      'prime_node_dir="$(mise where node@22.17.0)"',
      '[ -x "$prime_node_dir/bin/node" ]',
      '[ -x "$prime_node_dir/bin/npm" ]',
      "PRIME_AGENT_BOOTSTRAP_TOOLS_ON_INSTALL=0 PRIME_AGENT_BOOTSTRAP_KERNEL_ON_INSTALL=0 PRIME_AGENT_INSTALL_UV=0",
      'PATH="$prime_node_dir/bin:$PATH" "$prime_node_dir/bin/npm" install --global --prefix /src/prime-agent-prefix',
      '"$prime_node_dir/bin/node" -e',
      "/src/prime-agent-prefix/lib/node_modules/prime-agent/package.json",
      'p.bin?.["prime-agent"]!=="dist/bundle/cli.js"',
      "prime_kernel_home='/home/agent/.trellage/prime-kernel'",
      "prime_kernel_seed='/src/prime-kernel-seed.tar.gz'",
      "prime_kernel_status=0",
      'HOME="$prime_kernel_home" XDG_CACHE_HOME="$prime_kernel_home/.cache" PYTHONDONTWRITEBYTECODE=1',
      "/src/prime-agent-prefix/lib/node_modules/prime-agent/dist/core/kernel/bootstrap.js",
      "prime_kernel_status=$?",
      "trellage: Prime Python kernel bootstrap failed",
      "UV_DEFAULT_INDEX=https://packagefeedproxy.microsoft.io/pypi/simple/",
      "prime_kernel_requirements='/tmp/trellage-prime-kernel-requirements.txt'",
      "platformdirs==4.11.0 --hash=sha256:360ccded2b7fce0af0ff80cc8f5942a1c5d99b0e856033acb030bfc634709e74",
      'mise x uv@0.11.21 -- uv pip install --python "$prime_kernel_home/.prime/agent/kernel-venv/bin/python" --require-hashes --no-deps --reinstall',
      'rm -f "$prime_kernel_requirements"',
      'printf \'%s\\n\' "schema=1" > "$prime_kernel_home/.trellage-prime-kernel"',
      'find "$prime_kernel_home" -type d -name __pycache__',
      "prime_agent_runtime-*.dist-info/RECORD",
      'rm -f "$prime_runtime_dist_info/uv_cache.json"',
      "uv_cache",
      'tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner',
      'gzip -n > "$prime_kernel_seed"',
      'PATH=/src/build-support:$PATH mise oci build --locked --output "$OUTPUT_DIR" --tag "$IMAGE_REF"',
    ]

    for (const command of commands) expect(script).toContain(command)
    for (let index = 1; index < commands.length; index += 1) {
      expect(script.indexOf(commands[index]!)).toBeGreaterThan(script.indexOf(commands[index - 1]!))
    }
    expect(script).not.toMatch(/install\.sh|\/stable/)

    const harness = lock.packages.harness
    for (const forged of [
      { ...harness, url: "https://example.test/prime-agent-0.7.0.tgz" },
      { ...harness, integrity: "sha256:bad" },
      { ...harness, size: 0 },
    ]) {
      expect(() =>
        builderScript(document, { ...lock, packages: { ...lock.packages, harness: forged } } as ProfileLock),
      ).toThrow(/Prime builder/i)
    }
  })

  it("fails closed when Copilot reports a near-miss or duplicate plugin row", async () => {
    const document = await Effect.runPromise(parseProfile(copilotSource, "/tmp/copilot/profile.toml"))
    const script = builderScript(document, copilotLock(profileHash(document)))
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-builder-script-"))
    const bin = path.join(root, "bin")
    const data = path.join(root, "mise-data")
    const trace = path.join(root, "trace")
    const copilotTemplate = path.join(root, "copilot-template")
    const fakeNode = path.join(root, "node")
    await mkdir(bin)
    await Promise.all([
      writeFile(
        path.join(bin, "mise"),
        `#!/bin/sh
set -eu
printf 'mise:%s\\n' "$*" >> "$TRACE_FILE"
case "$1" in
  install)
    install_dir="$MISE_DATA_DIR/installs/http-copilot/1.0.75"
    mkdir -p "$install_dir"
    rm -f "$install_dir/copilot"
    if [ "$COPILOT_BINARY_MODE" != "missing" ]; then
      cp "$COPILOT_TEMPLATE" "$install_dir/copilot"
      if [ "$COPILOT_BINARY_MODE" = "non-executable" ]; then
        chmod 644 "$install_dir/copilot"
      else
        chmod 755 "$install_dir/copilot"
      fi
    fi
    ;;
  where)
    printf '%s\\n' "$MISE_DATA_DIR/installs/http-copilot/1.0.75"
    ;;
esac
`,
        { mode: 0o755 },
      ),
      writeFile(
        copilotTemplate,
        `#!/bin/sh
printf 'copilot:home=%s:auto=%s:no_color=%s:term=%s:argv=%s\\n' "$COPILOT_HOME" "$COPILOT_AUTO_UPDATE" "$NO_COLOR" "$TERM" "$*" >> "$TRACE_FILE"
case "$*" in
  "plugin marketplace add /src/hve-core") exit "$ADD_STATUS" ;;
  "plugin install hve-core@hve-core") exit "$INSTALL_STATUS" ;;
  "plugin list") printf '%s\\n' "$PLUGIN_LIST_OUTPUT"; exit "$LIST_STATUS" ;;
esac
`,
        { mode: 0o755 },
      ),
      writeFile(
        fakeNode,
        `#!/bin/sh
printf 'node:argv=%s\\n' "$*" >> "$TRACE_FILE"
exit "$FINALIZER_STATUS"
`,
        { mode: 0o755 },
      ),
    ])
    const missingNode = path.join(root, "missing-node")
    const nonExecutableNode = path.join(root, "non-executable-node")
    await writeFile(nonExecutableNode, "#!/bin/sh\n", { mode: 0o644 })
    const execute = async (options: {
      readonly pluginListOutput: string
      readonly addStatus?: number
      readonly installStatus?: number
      readonly listStatus?: number
      readonly finalizerStatus?: number
      readonly binaryMode?: "ok" | "missing" | "non-executable"
      readonly nodeMode?: "ok" | "missing" | "non-executable"
    }) => {
      await writeFile(trace, "")
      const node =
        options.nodeMode === "missing"
          ? missingNode
          : options.nodeMode === "non-executable"
            ? nonExecutableNode
            : fakeNode
      const managedDeja = script.slice(
        script.indexOf("deja_archive="),
        script.indexOf(
          'PATH=/src/build-support:$PATH mise oci build --locked --output "$OUTPUT_DIR" --tag "$IMAGE_REF"',
        ),
      )
      const executableScript = script.replace(managedDeja, "").replaceAll("/mise/installs/node/24.18.0/bin/node", node)
      const result = await execFilePromise("/bin/sh", ["-ceu", executableScript], {
        env: {
          PATH: `${bin}:/usr/bin:/bin`,
          MISE_DATA_DIR: data,
          COPILOT_TEMPLATE: copilotTemplate,
          TRACE_FILE: trace,
          PLUGIN_LIST_OUTPUT: options.pluginListOutput,
          ADD_STATUS: String(options.addStatus ?? 0),
          INSTALL_STATUS: String(options.installStatus ?? 0),
          LIST_STATUS: String(options.listStatus ?? 0),
          FINALIZER_STATUS: String(options.finalizerStatus ?? 0),
          COPILOT_BINARY_MODE: options.binaryMode ?? "ok",
          OUTPUT_DIR: path.join(root, "oci"),
          IMAGE_REF: "trellage-profile-copilot:locked",
        },
      })
      return { result, trace: await readFile(trace, "utf8") }
    }
    const exact = "  • hve-core@hve-core (v3.3.101)"

    await expect(execute({ pluginListOutput: `Installed plugins:\n${exact}` })).resolves.toEqual(
      expect.objectContaining({
        trace: [
          "mise:install --locked http:copilot@1.0.75",
          "mise:where http:copilot@1.0.75",
          "copilot:home=/src/copilot-seed:auto=false:no_color=1:term=dumb:argv=plugin marketplace add /src/hve-core",
          "copilot:home=/src/copilot-seed:auto=false:no_color=1:term=dumb:argv=plugin install hve-core@hve-core",
          "copilot:home=/src/copilot-seed:auto=false:no_color=1:term=dumb:argv=plugin list",
          "node:argv=/src/finalize-copilot-seed.mjs /src/copilot-seed hve-core hve-core 3.3.101",
          "mise:oci build --locked --output " + path.join(root, "oci") + " --tag trellage-profile-copilot:locked",
          "",
        ].join("\n"),
      }),
    )
    await expect(execute({ pluginListOutput: "  • hve-core@hve-core (v3.3.1010)" })).rejects.toThrow()
    await expect(execute({ pluginListOutput: "  • hve-core-extra@hve-core (v3.3.101)" })).rejects.toThrow()
    await expect(execute({ pluginListOutput: `\u001b[32m${exact}\u001b[0m` })).rejects.toThrow()
    await expect(execute({ pluginListOutput: `${exact}\n${exact}` })).rejects.toThrow()

    const failures = [
      {
        name: "marketplace add",
        options: { addStatus: 21 },
        reached: "argv=plugin marketplace add",
        forbidden: ["argv=plugin install", "argv=plugin list", "node:argv=", "mise:oci"],
      },
      {
        name: "plugin install",
        options: { installStatus: 22 },
        reached: "argv=plugin install",
        forbidden: ["argv=plugin list", "node:argv=", "mise:oci"],
      },
      {
        name: "plugin list",
        options: { listStatus: 23 },
        reached: "argv=plugin list",
        forbidden: ["node:argv=", "mise:oci"],
      },
      { name: "finalizer", options: { finalizerStatus: 24 }, reached: "node:argv=", forbidden: ["mise:oci"] },
      {
        name: "missing locked binary",
        options: { binaryMode: "missing" as const },
        reached: "mise:where",
        forbidden: ["copilot:", "node:argv=", "mise:oci"],
      },
      {
        name: "non-executable locked binary",
        options: { binaryMode: "non-executable" as const },
        reached: "mise:where",
        forbidden: ["copilot:", "node:argv=", "mise:oci"],
      },
      {
        name: "missing node",
        options: { nodeMode: "missing" as const },
        reached: "argv=plugin list",
        forbidden: ["node:argv=", "mise:oci"],
      },
      {
        name: "non-executable node",
        options: { nodeMode: "non-executable" as const },
        reached: "argv=plugin list",
        forbidden: ["node:argv=", "mise:oci"],
      },
    ]
    for (const failure of failures) {
      await expect(execute({ pluginListOutput: exact, ...failure.options }), failure.name).rejects.toThrow()
      const failureTrace = await readFile(trace, "utf8")
      expect(failureTrace, failure.name).toContain(failure.reached)
      for (const forbidden of failure.forbidden) expect(failureTrace, failure.name).not.toContain(forbidden)
    }
  }, 20_000)
})

describe("non-locked build lock persistence", () => {
  const roots: Array<string> = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it("preserves historical Codex lock serialization when persisting only the final digest", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-legacy-build-lock-"))
    roots.push(root)
    const profilePath = path.join(root, "profile.toml")
    const source = `
schema = 1
name = "legacy-codex"
description = "Legacy Codex profile"
[harness]
kind = "codex"
version = "0.144.6"
[harness.codex]
model = "gpt-5.5"
reasoning_effort = "medium"
model_provider = "proxy"
[harness.codex.providers.proxy]
base_url = "http://proxy:8080/v1"
wire_api = "responses"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[plugins]]
adapter = "codex-native"
repository = "https://github.com/example/legacy-plugin.git"
ref = "${"a".repeat(40)}"
select = []
`
    await writeFile(profilePath, source)
    const document = await Effect.runPromise(parseProfile(source, profilePath))
    const oldDigest = digest("e")
    const builtDigest = digest("9")
    const sourceContent = "legacy plugin fixture\n"
    const sourcePath = "plugins/legacy/README.md"
    const sourceHash = contentIntegrity(sourceContent)
    const legacyIntegrity = treeIntegrity([{ path: sourcePath, sha256: sourceHash }])
    const historical = `schema = 1
platform = "linux/arm64"
source_date_epoch = 1784379906
profile_hash = "${profileHash(document)}"

[[sources]]
kind = "plugin"
adapter = "codex-native"
repository = "https://github.com/example/legacy-plugin.git"
ref = "${"a".repeat(40)}"
select = []
commit = "${"a".repeat(40)}"
integrity = "${legacyIntegrity}"

[[sources.files]]
path = "${sourcePath}"
sha256 = "${sourceHash}"

[packages]
codex = "0.144.6"
codex_integrity = "sha256:8eddae5e6c009dff9ba51ae1bfe3bdd9ff4c1ccc93a48cc6860db1cd9fdf11be"
codex_url = "https://github.com/openai/codex/releases/download/rust-v0.144.6/codex-aarch64-unknown-linux-musl.tar.gz"
codex_size = 101269986

[packages.deja]
name = "deja"
version = "0.17.0"
integrity = "sha256:e6b21fdd9953b8428bd9464fc1cd6c9bbb1ad9396db31727a96903f60598b0e1"
url = "https://github.com/vshulcz/deja-vu/releases/download/v0.17.0/deja-vu_0.17.0_linux_arm64.tar.gz"
size = 4364290

[[packages.runtime]]
name = "bash"
version = "5.2.15-2+b13"
integrity = "sha256:fdb470b5ec1773b90014138bfc1deda4505c1c23e7f5731e8b527c636ac03385"

[image]
base = "node:22.17.0-bookworm-slim"
base_digest = "sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0"
final_digest = "${oldDigest}"
`
    const lockPath = path.join(root, "profile.linux-arm64.lock.toml")
    await writeFile(lockPath, historical)
    const parsedHistorical = await Effect.runPromise(loadLock(profilePath, "linux/arm64"))
    const original = renderLock(parsedHistorical!)
    expect(original).toContain('[packages]\ncodex = "0.144.6"')
    expect(original).not.toContain("[packages.harness]")
    const support = runtimeSupport(root)
    await writeFile(support.codexEntry, "#!/bin/sh\n")
    const sourceDirectory = path.join(root, "source")
    await mkdir(path.join(sourceDirectory, "plugins", "legacy"), { recursive: true })
    await writeFile(path.join(sourceDirectory, sourcePath), sourceContent)
    mocks.sourceDirectory = sourceDirectory
    const execute = (_command: string, args: ReadonlyArray<string>) =>
      Effect.promise(async () => {
        if (!args.includes("--user")) return
        const mount = args.find((argument) => argument.startsWith("type=bind,src=") && argument.endsWith(",dst=/src"))
        if (mount === undefined) throw new Error("missing build context mount")
        const context = mount.slice("type=bind,src=".length, -",dst=/src".length)
        await mkdir(path.join(context, "oci"))
        await writeFile(
          path.join(context, "oci", "index.json"),
          JSON.stringify({
            manifests: [{ digest: builtDigest }],
          }),
        )
      })

    await expect(
      Effect.runPromise(buildProfile(profilePath, false, root, support, arm64Target, dockerServices(execute))),
    ).resolves.toEqual({
      image: "trellage-profile-legacy-codex-linux-arm64:locked",
      digest: builtDigest,
    })
    const expected = original.replace(oldDigest, builtDigest)
    const persisted = await readFile(lockPath, "utf8")
    expect(persisted).toBe(expected)
    const reloaded = await Effect.runPromise(loadLock(profilePath, "linux/arm64"))
    await expect(Effect.runPromise(requireLocked(document, reloaded))).resolves.toBe(reloaded)
    expect(renderLock(reloaded!)).toBe(expected)
  }, 20_000)
})

describe("locked build source policy", () => {
  beforeEach(() => {
    mocks.requests.length = 0
    mocks.sourceDirectory = "/definitely-missing-harness-source"
  })

  it("rejects missing Copilot runtime support before resolving locked sources", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-application-support-"))
    const lock = copilotLock("replaced-by-writeReadyProfile")
    const supportFiles: ProfileLock["sources"][number]["files"] = [
      {
        kind: "file",
        path: ".github/plugin/marketplace.json",
        sha256: digest("f"),
      },
    ]
    const { profile_hash: _profileHash, ...readyLock } = {
      ...lock,
      sources: [{ ...lock.sources[0]!, files: supportFiles, integrity: treeIntegrity(supportFiles) }],
    }
    const profilePath = await writeReadyProfile(root, copilotSource, readyLock)

    const support = runtimeSupport(root)
    await writeFile(support.codexEntry, "#!/bin/sh\n")
    await expect(Effect.runPromise(buildProfile(profilePath, true, root, support, arm64Target))).rejects.toThrow(
      /Copilot runtime support.*regular readable file/,
    )
    expect(mocks.requests).toEqual([])
    await writeFile(support.copilotEntry, "#!/bin/sh\n")
    await expect(Effect.runPromise(buildProfile(profilePath, true, root, support, arm64Target))).rejects.toThrow(
      /Copilot runtime support finalizeCopilotSeed.*regular readable file/,
    )
    expect(mocks.requests).toEqual([])
  })

  it("rehydrates a complete Copilot marketplace with its symlink policy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-application-copilot-"))
    const source = `
schema = 1
name = "copilot"
description = "Copilot metadata profile"
[harness]
kind = "copilot"
version = "latest"
[harness.copilot]
auth = "host-or-login"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[plugins]]
adapter = "copilot-marketplace"
repository = "https://github.com/microsoft/hve-core.git"
ref = "main"
marketplace = "hve-core"
select = ["hve-core"]
`
    const marketplaceContent = "{}\n"
    const files: ProfileLock["sources"][number]["files"] = [
      {
        kind: "file",
        path: ".github/plugin/marketplace.json",
        sha256: contentIntegrity(marketplaceContent),
      },
    ]
    const profilePath = await writeReadyProfile(root, source, {
      schema: 1,
      platform: "linux/arm64",
      source_date_epoch: 1784379906,
      sources: [
        {
          kind: "plugin",
          adapter: "copilot-marketplace",
          marketplace: "hve-core",
          plugin_versions: { "hve-core": "3.3.101" },
          repository: "https://github.com/microsoft/hve-core.git",
          ref: "main",
          select: ["hve-core"],
          commit: "a".repeat(40),
          integrity: treeIntegrity(files),
          files,
        },
      ],
      packages: {
        deja: arm64ArtifactCatalog.deja,
        harness: {
          kind: "copilot",
          selector: "latest",
          version: "1.0.75",
          integrity: digest("c"),
          url: "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
          size: 1024,
        },
        runtime: [
          {
            name: "bash",
            version: arm64ArtifactCatalog.runtimeVersions.bash,
            integrity: arm64ArtifactCatalog.runtimeIntegrities.bash,
          },
        ],
      },
      image: {
        base: "node:22.17.0-bookworm-slim",
        base_digest: arm64ArtifactCatalog.base.digest,
        final_digest: digest("e"),
      },
    })

    const sourceDirectory = path.join(root, "source")
    await mkdir(path.join(sourceDirectory, ".github", "plugin"), { recursive: true })
    await writeFile(path.join(sourceDirectory, ".github", "plugin", "marketplace.json"), marketplaceContent)
    mocks.sourceDirectory = sourceDirectory
    const support = runtimeSupport(root)
    await Promise.all([
      writeFile(support.copilotEntry, "#!/bin/sh\n"),
      writeFile(support.finalizeCopilotSeed, "export {}\n"),
    ])
    const scripts: Array<string> = []
    const builderArgs: Array<string> = []
    const runnerOptions: Array<unknown> = []
    const execute = (command: string, args: ReadonlyArray<string>, options?: unknown) =>
      Effect.promise(async () => {
        expect(command).toBe("docker")
        runnerOptions.push(options)
        if (!args.includes("--user")) return
        builderArgs.push(...args)
        const mount = args.find((argument) => argument.startsWith("type=bind,src=") && argument.endsWith(",dst=/src"))
        if (mount === undefined) throw new Error("missing build context mount")
        const context = mount.slice("type=bind,src=".length, -",dst=/src".length)
        expect.soft(context.startsWith(path.join(root, "trellage", "build", "trellage-build-"))).toBe(true)
        scripts.push(args.at(-1) ?? "")
        await mkdir(path.join(context, "oci"))
        await writeFile(
          path.join(context, "oci", "index.json"),
          JSON.stringify({
            manifests: [{ digest: digest("e") }],
          }),
        )
      })

    await expect(
      Effect.runPromise(
        buildProfile(
          profilePath,
          true,
          root,
          support,
          arm64Target,
          dockerServices(execute),
          "https://packagefeedproxy.microsoft.io/npm/",
        ),
      ),
    ).resolves.toEqual({ image: "trellage-profile-copilot-linux-arm64:locked", digest: digest("e") })
    expect(runnerOptions).toEqual([
      expect.objectContaining({ stdio: "inherit" }),
      expect.objectContaining({ stdio: "inherit" }),
      undefined,
    ])
    expect(scripts).toHaveLength(1)
    expect(builderArgs).toContain("npm_config_registry=https://packagefeedproxy.microsoft.io/npm/")
    expect(builderArgs).toContain("npm_config_fetch_retries=5")
    expect(builderArgs).toContain("npm_config_fetch_retry_mintimeout=1000")
    expect(builderArgs).toContain("npm_config_fetch_retry_maxtimeout=10000")
    expect(scripts[0]).toContain('"$copilot_bin" plugin install hve-core@hve-core')
    expect(mocks.requests).toEqual([
      expect.objectContaining({
        include: [],
        inventoryPolicy: { allowSymlinks: true },
      }),
    ])
  }, 20_000)

  it("rehydrates Codex sources with the strict inventory policy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-application-codex-"))
    const source = `
schema = 1
name = "codex"
description = "Codex metadata profile"
[harness]
kind = "codex"
version = "0.144.6"
[harness.codex]
model = "gpt-5.5"
reasoning_effort = "medium"
model_provider = "proxy"
[harness.codex.providers.proxy]
base_url = "http://proxy:8080/v1"
wire_api = "responses"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[skills]]
repository = "https://github.com/obra/superpowers.git"
ref = "v6.2.0"
select = ["*"]
`
    const files: ProfileLock["sources"][number]["files"] = [
      {
        kind: "file",
        path: "skills/example/SKILL.md",
        sha256: digest("f"),
      },
    ]
    const profilePath = await writeReadyProfile(root, source, {
      schema: 1,
      platform: "linux/arm64",
      source_date_epoch: 1784379906,
      sources: [
        {
          kind: "skill",
          repository: "https://github.com/obra/superpowers.git",
          ref: "v6.2.0",
          select: ["*"],
          commit: "a".repeat(40),
          integrity: treeIntegrity(files),
          files,
        },
      ],
      packages: {
        deja: arm64ArtifactCatalog.deja,
        harness: {
          kind: "codex",
          selector: "0.144.6",
          version: "0.144.6",
          integrity: digest("c"),
          url: "https://github.com/openai/codex/releases/download/rust-v0.144.6/codex-aarch64-unknown-linux-musl.tar.gz",
          size: 101269986,
        },
        artifacts: [
          {
            name: "codex-code-mode-host",
            version: "0.144.6",
            integrity: digest("c"),
            url: "https://github.com/openai/codex/releases/download/rust-v0.144.6/codex-code-mode-host-aarch64-unknown-linux-musl.tar.gz",
            size: 17260137,
          },
        ],
        skills_cli_version: "1.5.19",
        skills_cli_integrity: "sha512-dGVzdA==",
        runtime: [
          {
            name: "bash",
            version: arm64ArtifactCatalog.runtimeVersions.bash,
            integrity: arm64ArtifactCatalog.runtimeIntegrities.bash,
          },
        ],
      },
      image: {
        base: "node:22.17.0-bookworm-slim",
        base_digest: arm64ArtifactCatalog.base.digest,
        final_digest: digest("e"),
      },
    })

    const support = runtimeSupport(root)
    await expect(Effect.runPromise(buildProfile(profilePath, true, root, support, arm64Target))).rejects.toThrow(
      /Codex runtime support codexEntry.*regular readable file/,
    )
    expect(mocks.requests).toEqual([])
    await writeFile(support.codexEntry, "#!/bin/sh\n")
    await expect(Effect.runPromise(buildProfile(profilePath, true, root, support, arm64Target))).rejects.toThrow(
      /source inventory mismatch/,
    )
    expect(mocks.requests).toEqual([
      expect.objectContaining({
        include: ["skills", ".agents/skills", ".claude/skills"],
        inventoryPolicy: {},
      }),
    ])
  })
})
