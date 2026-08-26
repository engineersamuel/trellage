import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Cause, Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

const cliHarness = vi.hoisted(() => ({
  main: undefined as unknown,
  selected: [] as Array<string>,
  upgraded: [] as Array<string>,
  registries: [] as Array<string | undefined>,
  guide: {
    schemaVersion: 1,
    capabilities: ["test"],
    bestFor: ["CLI list tests"],
    avoidFor: ["Production use"],
    prerequisites: [],
    workflows: [
      {
        id: "test",
        description: "Exercise list output",
        examples: ["List alpha", "List beta", "List gamma"],
        promptTemplate: "{{intent}}",
      },
    ],
  },
}))

vi.mock("@effect/platform-node", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/platform-node")>()
  return {
    ...actual,
    NodeRuntime: {
      ...actual.NodeRuntime,
      runMain: (main: unknown) => {
        cliHarness.main = main
      },
    },
  }
})

vi.mock("../src/docker-target.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/docker-target.js")>()
  const { Effect: EffectModule } = await import("effect")
  return {
    ...actual,
    captureDockerTarget: () =>
      EffectModule.succeed({
        endpoint: "unix:///tmp/trellage-cli-test.sock",
        serverId: "trellage-cli-test-server",
        platform: "linux/arm64" as const,
      }),
  }
})

vi.mock("../src/application.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/application.js")>()
  const { Effect } = await import("effect")
  return {
    ...actual,
    profileMetadata: (profilePath: string) =>
      Effect.sync(() => {
        cliHarness.selected.push(profilePath)
        return {}
      }),
    upgradeProfile: (
      profilePath: string,
      _cacheHome: string,
      _runtimeSupport: unknown,
      _target: unknown,
      _services: unknown,
      npmRegistry: string | undefined,
    ) =>
      Effect.gen(function* () {
        cliHarness.upgraded.push(profilePath)
        cliHarness.registries.push(npmRegistry)
        if (profilePath === "/profiles/beta/profile.toml") {
          return yield* Effect.fail(new actual.ApplicationError({ message: "VPN blocked beta" }))
        }
        return { image: `image:${path.basename(path.dirname(profilePath))}`, digest: "sha256:updated" }
      }),
  }
})

vi.mock("../src/profile-discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/profile-discovery.js")>()
  const { Effect: EffectModule } = await import("effect")
  return {
    ...actual,
    discoverProfileChoices: () =>
      EffectModule.succeed([
        {
          name: "alpha",
          description: "Alpha description",
          value: "/profiles/alpha/profile.toml",
          supported_platforms: ["linux/arm64"],
          harness: { kind: "codex", version: "latest" },
          headlessRuntime: "codex",
          skills: [],
          plugins: [],
          mcps: [],
        },
        {
          name: "beta",
          description: "Beta description",
          value: "/profiles/beta/profile.toml",
          supported_platforms: [],
          harness: { kind: "claude", version: "latest", model: "claude-opus-5" },
          headlessRuntime: "claude-hyperresearch",
          skills: [],
          plugins: [],
          mcps: [],
        },
        {
          name: "gamma",
          description: "Gamma description",
          value: "/profiles/gamma/profile.toml",
          supported_platforms: ["linux/amd64"],
          harness: { kind: "copilot", version: "latest" },
          headlessRuntime: "copilot",
          skills: [],
          plugins: [],
          mcps: [],
        },
      ]),
  }
})

vi.mock("../src/profile-guides.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/profile-guides.js")>()
  const { Effect: EffectModule } = await import("effect")
  return {
    ...actual,
    loadSandboxProfileGuides: (_repositoryRoot: string, choices: ReadonlyArray<unknown>) =>
      EffectModule.succeed(choices.map(() => cliHarness.guide)),
  }
})

import { ApplicationError } from "../src/application.js"
import { formatCliCause } from "../src/cli.js"

const cliSource = readFileSync(fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "utf8")

const runMetadata = async (
  args: ReadonlyArray<string>,
  environment: { readonly trellage?: string; readonly harness?: string },
): Promise<ReadonlyArray<string>> => {
  const originalArgv = process.argv
  const originalTrellage = process.env.TRELLAGE_PROFILE
  const originalHarness = process.env.HARNESS_PROFILE
  try {
    process.argv = [process.execPath, "trellage-profile", "metadata", ...args]
    environment.trellage === undefined
      ? delete process.env.TRELLAGE_PROFILE
      : (process.env.TRELLAGE_PROFILE = environment.trellage)
    environment.harness === undefined
      ? delete process.env.HARNESS_PROFILE
      : (process.env.HARNESS_PROFILE = environment.harness)
    cliHarness.main = undefined
    cliHarness.selected = []
    vi.resetModules()
    await import("../src/cli.js")
    if (cliHarness.main === undefined) throw new Error("CLI main effect was not captured")
    await Effect.runPromise(cliHarness.main as Effect.Effect<void, unknown, never>)
    return [...cliHarness.selected]
  } finally {
    process.argv = originalArgv
    originalTrellage === undefined
      ? delete process.env.TRELLAGE_PROFILE
      : (process.env.TRELLAGE_PROFILE = originalTrellage)
    originalHarness === undefined ? delete process.env.HARNESS_PROFILE : (process.env.HARNESS_PROFILE = originalHarness)
  }
}

const runUpgradeAll = async (): Promise<{
  readonly upgraded: ReadonlyArray<string>
  readonly registries: ReadonlyArray<string | undefined>
  readonly exitCode: number | undefined
}> => {
  const originalArgv = process.argv
  const originalExitCode = process.exitCode
  try {
    process.argv = [process.execPath, "trellage-profile", "upgrade", "all"]
    process.exitCode = undefined
    cliHarness.main = undefined
    cliHarness.upgraded = []
    cliHarness.registries = []
    vi.resetModules()
    await import("../src/cli.js")
    if (cliHarness.main === undefined) throw new Error("CLI main effect was not captured")
    await Effect.runPromise(cliHarness.main as Effect.Effect<void, unknown, never>)
    return {
      upgraded: [...cliHarness.upgraded],
      registries: [...cliHarness.registries],
      exitCode: process.exitCode,
    }
  } finally {
    process.argv = originalArgv
    process.exitCode = originalExitCode
  }
}

const runList = async (
  args: ReadonlyArray<string>,
): Promise<{
  readonly logs: ReadonlyArray<string>
  readonly exitCode: number | undefined
}> => {
  const originalArgv = process.argv
  const originalExitCode = process.exitCode
  const logs: Array<string> = []
  const originalLog = console.log
  try {
    process.argv = [process.execPath, "trellage-profile", "list", ...args]
    process.exitCode = undefined
    cliHarness.main = undefined
    console.log = (...parts: Array<unknown>) => {
      logs.push(parts.map(String).join(" "))
    }
    vi.resetModules()
    await import("../src/cli.js")
    if (cliHarness.main === undefined) throw new Error("CLI main effect was not captured")
    await Effect.runPromise(cliHarness.main as Effect.Effect<void, unknown, never>)
    return { logs, exitCode: process.exitCode }
  } finally {
    process.argv = originalArgv
    process.exitCode = originalExitCode
    console.log = originalLog
  }
}

describe("CLI identity and failure reporting", () => {
  it("uses Trellage identity and prints the full failure cause tree", () => {
    expect.soft(cliSource).toContain('Command.make("trellage-profile"')
    expect.soft(cliSource).toContain('Command.make("choices"')
    expect.soft(cliSource).toContain('Command.make("list"')
    expect.soft(cliSource).toContain('Options.boolean("json")')
    expect.soft(cliSource).toContain('Options.boolean("json-full")')
    expect.soft(cliSource).toContain('Options.boolean("full")')
    expect.soft(cliSource).toContain('name: "Trellage profile compiler"')
    expect.soft(cliSource).toContain("process.env.TRELLAGE_PROFILE")
    expect.soft(cliSource).not.toContain("process.env.HARNESS_PROFILE")

    const cause = Cause.sequential(
      Cause.fail(new ApplicationError({ message: "canonical tag failed" })),
      Cause.fail(new ApplicationError({ message: "compensation restore failed" })),
    )

    expect(formatCliCause(cause)).toContain("canonical tag failed")
    expect(formatCliCause(cause)).toContain("compensation restore failed")
    expect(formatCliCause(cause)).toMatch(/^trellage profile:/)
  })

  it("selects TRELLAGE_PROFILE and keeps an explicit profile path first", async () => {
    await expect(runMetadata([], { trellage: "from-environment.toml" })).resolves.toEqual([
      path.resolve("from-environment.toml"),
    ])
    await expect(runMetadata(["explicit.toml"], { trellage: "from-environment.toml" })).resolves.toEqual([
      path.resolve("explicit.toml"),
    ])
  })

  it("ignores the legacy HARNESS_PROFILE variable", async () => {
    const legacy = path.resolve("legacy.toml")
    const selected = await runMetadata([], { harness: "legacy.toml" })
    expect(selected).toHaveLength(1)
    expect(selected[0]).not.toBe(legacy)
  })

  it("lists simplified and full JSON catalogs", async () => {
    const simplified = await runList(["--json"])
    expect(simplified.exitCode ?? 0).toBe(0)
    expect(JSON.parse(simplified.logs.join("\n"))).toEqual({
      schemaVersion: 1,
      profiles: [
        { name: "alpha", description: "Alpha description", guide: cliHarness.guide, sandbox: true },
        { name: "beta", description: "Beta description", guide: cliHarness.guide, sandbox: true },
        { name: "gamma", description: "Gamma description", guide: cliHarness.guide, sandbox: true },
      ],
    })

    const full = await runList(["--json-full"])
    const fullAlias = await runList(["--json", "--full"])
    const parsed = JSON.parse(full.logs.join("\n")) as {
      schemaVersion: number
      profiles: Array<{
        name: string
        path: string
        supportedPlatforms: string[]
        headless: { schemaVersion: number; testedHarnessVersion: string | null }
        locked: boolean
        herdrCompatibility: { status: string }
      }>
    }
    expect(parsed.schemaVersion).toBe(1)
    expect(fullAlias.exitCode ?? 0).toBe(0)
    expect(fullAlias.logs.join("\n")).toBe(full.logs.join("\n"))
    expect(parsed.profiles.map((p) => p.name)).toEqual(["alpha", "beta", "gamma"])
    expect(parsed.profiles[0]).toMatchObject({
      path: "/profiles/alpha/profile.toml",
      supportedPlatforms: ["linux/arm64"],
    })
    // These fixture profiles have no real file on disk, so readiness cannot
    // be determined and must degrade to false rather than failing `list`.
    expect(parsed.profiles.every((p) => p.locked === false)).toBe(true)
    // None of these fixture names appear in docs/herdr-compatibility.json,
    // so the ledger lookup must default to "untested" rather than failing.
    expect(parsed.profiles.every((p) => p.herdrCompatibility.status === "untested")).toBe(true)
    expect(parsed.profiles.every((p) => p.headless.schemaVersion === 1)).toBe(true)
    expect(parsed.profiles[1]?.headless.testedHarnessVersion).toBe("2.1.229")
  })

  it("rejects invalid full-list flag combinations", async () => {
    await expect(runList(["--json", "--json-full"])).resolves.toMatchObject({ exitCode: 1 })
    await expect(runList(["--full"])).resolves.toMatchObject({ exitCode: 1 })
    await expect(runList(["--json-full", "--full"])).resolves.toMatchObject({ exitCode: 1 })
  })

  it("upgrades every discovered profile and reports failure after continuing", async () => {
    await expect(runUpgradeAll()).resolves.toEqual({
      upgraded: ["/profiles/alpha/profile.toml", "/profiles/beta/profile.toml", "/profiles/gamma/profile.toml"],
      registries: expect.arrayContaining([expect.any(String)]),
      exitCode: 1,
    })
  })
})
