import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Cause, Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

const cliHarness = vi.hoisted(() => ({
  main: undefined as unknown,
  selected: [] as Array<string>,
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

describe("CLI identity and failure reporting", () => {
  it("uses Trellage identity and prints the full failure cause tree", () => {
    expect.soft(cliSource).toContain('Command.make("trellage-profile"')
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
})
