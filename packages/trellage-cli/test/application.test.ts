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

const mocks = vi.hoisted(() => ({
  requests: [] as Array<GitHubSourceRequest>,
  sourceDirectory: "/definitely-missing-harness-source",
  sourceFiles: [] as Array<{ readonly kind: "file"; readonly path: string; readonly sha256: string }>,
  failLockRenames: 0,
  lockRenameEvents: undefined as Array<string> | undefined,
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    rename: async (source: Parameters<typeof actual.rename>[0], destination: Parameters<typeof actual.rename>[1]) => {
      if (String(destination).endsWith("profile.lock.toml")) {
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

import {
  ApplicationError,
  builderScript,
  buildProfile,
  loadLock,
  profileMetadata,
  sanitizeNpmRegistry,
  upgradeProfile,
  type UpgradeServices,
} from "../src/application.js"
import { renderLock } from "../src/lock-file.js"
import { profileHash, requireLocked, type ProfileLock } from "../src/lock.js"
import { parseProfile } from "../src/profile.js"

const digest = (character: string) => `sha256:${character.repeat(64)}`
const execFilePromise = promisify(execFile)
const treeIntegrity = (files: ReadonlyArray<unknown>) =>
  `sha256:${createHash("sha256").update(JSON.stringify(files)).digest("hex")}`
const contentIntegrity = (content: string) => `sha256:${createHash("sha256").update(content).digest("hex")}`

const runtimeSupport = (root: string) => ({
  codexEntry: path.join(root, "runtime-entry.sh"),
  copilotEntry: path.join(root, "runtime-copilot-entry.sh"),
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
  await writeFile(path.join(root, "profile.lock.toml"), renderLock({ ...lock, profile_hash: profileHash(document) }))
  return profilePath
}

const copilotSource = `
schema = 1
name = "copilot"
[harness]
kind = "copilot"
version = "latest"
args = ["$(touch /tmp/profile-injection)", "COPILOT_GITHUB_TOKEN=secret"]
[harness.copilot]
auth = "host-or-login"
[image]
platform = "linux/arm64"
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
    harness: {
      kind: "copilot",
      selector: "latest",
      version: "1.0.75",
      integrity: digest("c"),
      url: "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
      size: 1024,
    },
    runtime: [{ name: "bash", version: "5.2.15", integrity: digest("d") }],
  },
  image: {
    base: "node:22.17.0-bookworm-slim",
    base_digest: digest("b"),
    final_digest: digest("e"),
  },
})

const codexSource = `
schema = 1
name = "codex-upgrade"
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
platform = "linux/arm64"
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
    harness: {
      kind: "codex",
      selector: "0.144.6",
      version: "0.144.6",
      integrity: "sha256:8eddae5e6c009dff9ba51ae1bfe3bdd9ff4c1ccc93a48cc6860db1cd9fdf11be",
      url: "https://github.com/openai/codex/releases/download/rust-v0.144.6/codex-aarch64-unknown-linux-musl.tar.gz",
      size: 101269986,
    },
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
    await writeFile(path.join(root, "profile.lock.toml"), renderLock(staleLock))

    const metadata = await Effect.runPromise(profileMetadata(profilePath))
    expect(metadata).toMatchObject({
      harness_kind: "copilot",
      locked: false,
      resolved_version: null,
    })
    expect.soft(metadata.image).toBe("trellage-profile-copilot-hve:locked")
    expect.soft(metadata.build_command).toContain("trellage build --locked")
    expect.soft(metadata.runtime_entry).toBe("trellage-copilot-entry")
    const applicationSource = await readFile(fileURLToPath(new URL("../src/application.ts", import.meta.url)), "utf8")
    expect.soft(applicationSource).toContain('path.join(xdgCacheHome, "trellage",')
    expect.soft(applicationSource).not.toContain('path.join(xdgCacheHome, "harness",')
  })
})

describe("transactional profile upgrade", () => {
  beforeEach(() => {
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
    await writeFile(path.join(root, "profile.lock.toml"), renderLock(codexLock(profileHash(document))))
    const support = runtimeSupport(root)
    await writeFile(support.codexEntry, "#!/bin/sh\n")

    const canonical = "trellage-profile-codex-upgrade:locked"
    const candidate = `trellage-profile-codex-upgrade:candidate-${process.pid}`
    const backup = `trellage-profile-codex-upgrade:backup-${process.pid}`
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

    await expect(Effect.runPromise(upgradeProfile(profilePath, root, support, services))).resolves.toEqual({
      image: canonical,
      digest: builtDigest,
    })
    mocks.sourceFiles = []
    expect(events).toEqual([
      `build:${candidate}:undefined`,
      `exists:${canonical}`,
      `tag:${canonical}->${backup}`,
      `tag:${candidate}->${canonical}`,
      "write:lock",
      `remove:${candidate}`,
      `remove:${backup}`,
    ])
    const finalLock = codexLock(profileHash(document), builtDigest)
    expect(await readFile(path.join(root, "profile.lock.toml"), "utf8")).toBe(renderLock(finalLock))
    expect(events.join(" ")).not.toMatch(/container|volume|state/i)
  })

  const prepare = async (source = codexSource) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-upgrade-transaction-"))
    const profilePath = path.join(root, "profile.toml")
    await writeFile(profilePath, source)
    const document = await Effect.runPromise(parseProfile(source, profilePath))
    const original = renderLock(codexLock(profileHash(document)))
    await writeFile(path.join(root, "profile.lock.toml"), original)
    const support = runtimeSupport(root)
    await writeFile(support.codexEntry, "#!/bin/sh\n")
    mocks.sourceFiles = [{ kind: "file", path: "skills/example/SKILL.md", sha256: digest("f") }]
    return {
      root,
      profilePath,
      support,
      original,
      lockPath: path.join(root, "profile.lock.toml"),
      canonical: "trellage-profile-codex-upgrade:locked",
      candidate: `trellage-profile-codex-upgrade:candidate-${process.pid}`,
      backup: `trellage-profile-codex-upgrade:backup-${process.pid}`,
    }
  }

  const failed = (message: string) => Effect.fail(new ApplicationError({ message }))

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
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, services)),
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
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, services)),
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
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, services)),
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
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, services)),
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
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, services)),
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
      upgradeProfile(fixture.profilePath, fixture.root, fixture.support, services),
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
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, services)),
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
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, services)),
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
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, services)),
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
          return (await readFile(resultPath, "utf8")) === "failure:upgrade already active for profile: codex-upgrade"
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
      expect(results).toEqual(["success", "failure:upgrade already active for profile: codex-upgrade"])
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
        await Effect.runPromise(upgradeProfile(profilePath, path.dirname(profilePath), support, services))
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
    const first = Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, services))
    await started
    await expect(
      Effect.runPromise(upgradeProfile(fixture.profilePath, fixture.root, fixture.support, services)),
    ).rejects.toThrow(/upgrade already active/)
    releaseBuild()
    await expect(first).resolves.toEqual({ image: fixture.canonical, digest: digest("9") })
  })
})

describe("locked builder command", () => {
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
        skills_cli_version: "1.5.19",
        skills_cli_integrity: "sha512-dGVzdA==",
      },
    }

    expect(builderScript(document, lock)).toBe(
      'mise install --locked http:codex@0.144.6; codex_dir="$(mise where http:codex@0.144.6)"; rm -f "$codex_dir/metadata.json"; PATH=/src/build-support:$PATH mise oci build --locked --output "$OUTPUT_DIR" --tag "$IMAGE_REF"',
    )
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
      const executableScript = script.replaceAll("/mise/installs/node/24.18.0/bin/node", node)
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
platform = "linux/arm64"
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

[[packages.runtime]]
name = "bash"
version = "5.2.15-2+b13"
integrity = "sha256:fdb470b5ec1773b90014138bfc1deda4505c1c23e7f5731e8b527c636ac03385"

[image]
base = "node:22.17.0-bookworm-slim"
base_digest = "sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0"
final_digest = "${oldDigest}"
`
    const lockPath = path.join(root, "profile.lock.toml")
    await writeFile(lockPath, historical)
    const parsedHistorical = await Effect.runPromise(loadLock(profilePath))
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

    await expect(Effect.runPromise(buildProfile(profilePath, false, root, support, execute))).resolves.toEqual({
      image: "trellage-profile-legacy-codex:locked",
      digest: builtDigest,
    })
    const expected = original.replace(oldDigest, builtDigest)
    const persisted = await readFile(lockPath, "utf8")
    expect(persisted).toBe(expected)
    const reloaded = await Effect.runPromise(loadLock(profilePath))
    await expect(Effect.runPromise(requireLocked(document, reloaded))).resolves.toBe(reloaded)
    expect(renderLock(reloaded!)).toBe(expected)
  })
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
    await expect(Effect.runPromise(buildProfile(profilePath, true, root, support))).rejects.toThrow(
      /Copilot runtime support.*regular readable file/,
    )
    expect(mocks.requests).toEqual([])
    await writeFile(support.copilotEntry, "#!/bin/sh\n")
    await expect(Effect.runPromise(buildProfile(profilePath, true, root, support))).rejects.toThrow(
      /Copilot runtime support finalizeCopilotSeed.*regular readable file/,
    )
    expect(mocks.requests).toEqual([])
  })

  it("rehydrates a complete Copilot marketplace with its symlink policy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-application-copilot-"))
    const source = `
schema = 1
name = "copilot"
[harness]
kind = "copilot"
version = "latest"
[harness.copilot]
auth = "host-or-login"
[image]
platform = "linux/arm64"
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
        harness: {
          kind: "copilot",
          selector: "latest",
          version: "1.0.75",
          integrity: digest("c"),
          url: "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
          size: 1024,
        },
        runtime: [{ name: "bash", version: "5.2.15", integrity: digest("d") }],
      },
      image: {
        base: "node:22.17.0-bookworm-slim",
        base_digest: digest("b"),
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
        buildProfile(profilePath, true, root, support, execute, "https://packagefeedproxy.microsoft.io/npm/"),
      ),
    ).resolves.toEqual({ image: "trellage-profile-copilot:locked", digest: digest("e") })
    expect(runnerOptions).toEqual([
      expect.objectContaining({ stdio: "inherit" }),
      expect.objectContaining({ stdio: "inherit" }),
    ])
    expect(scripts).toHaveLength(1)
    expect(builderArgs).toContain("npm_config_registry=https://packagefeedproxy.microsoft.io/npm/")
    expect(scripts[0]).toContain('"$copilot_bin" plugin install hve-core@hve-core')
    expect(mocks.requests).toEqual([
      expect.objectContaining({
        include: [],
        inventoryPolicy: { allowSymlinks: true },
      }),
    ])
  })

  it("rehydrates Codex sources with the strict inventory policy", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "harness-application-codex-"))
    const source = `
schema = 1
name = "codex"
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
platform = "linux/arm64"
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
        harness: {
          kind: "codex",
          selector: "0.144.6",
          version: "0.144.6",
          integrity: digest("c"),
          url: "https://example.test/codex.tar.gz",
          size: 1024,
        },
        skills_cli_version: "1.5.19",
        skills_cli_integrity: "sha512-dGVzdA==",
        runtime: [{ name: "bash", version: "5.2.15", integrity: digest("d") }],
      },
      image: {
        base: "node:22.17.0-bookworm-slim",
        base_digest: digest("b"),
        final_digest: digest("e"),
      },
    })

    const support = runtimeSupport(root)
    await expect(Effect.runPromise(buildProfile(profilePath, true, root, support))).rejects.toThrow(
      /Codex runtime support codexEntry.*regular readable file/,
    )
    expect(mocks.requests).toEqual([])
    await writeFile(support.codexEntry, "#!/bin/sh\n")
    await expect(Effect.runPromise(buildProfile(profilePath, true, root, support))).rejects.toThrow(
      /source inventory mismatch/,
    )
    expect(mocks.requests).toEqual([
      expect.objectContaining({
        include: ["skills"],
        inventoryPolicy: {},
      }),
    ])
  })
})
