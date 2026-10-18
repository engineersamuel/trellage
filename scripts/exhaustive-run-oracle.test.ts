import { expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { readTrellageConfig } from "@trellage/runtime/native-config"
import { parseRunArguments, runNative } from "@trellage/runtime/native-run"
import { createCleanRunWorld } from "./exhaustive-clean-run-world.ts"
import { expectedRunOutcome, type RunOutcome } from "./exhaustive-run-oracle.ts"

const configPath = fileURLToPath(new URL("../config.toml", import.meta.url))
const {
  config: { native: catalog },
} = await readTrellageConfig({ environment: { TRELLAGE_CONFIG: configPath } })
const cases: { args: string[]; outcome: RunOutcome }[] = [
  { args: ["unknown-harness"], outcome: "usage" },
  { args: ["agency", "clean", "--continue", "--effort", "invalid"], outcome: "usage" },
  { args: ["agency", "clean", "--continue", "--", "--profile-only", "fixture"], outcome: "usage" },
  { args: ["agency", "clean", "base", "--continue"], outcome: "unsupported" },
  { args: ["agency", "clean", "base"], outcome: "usage" },
  { args: ["agency", "clean"], outcome: "unsupported" },
  { args: ["codex", "clean", "--skill", "a/b:c"], outcome: "usage" },
  { args: ["copilot", "clean", "--", "--plugin-dir", "fixture"], outcome: "usage" },
  { args: ["codex", "unknown-profile", "firstmate"], outcome: "unsupported" },
  { args: ["uji", "unknown-profile", "--model", "gpt-6-astra"], outcome: "usage" },
  { args: ["uji", "firstmate", "--model", "gpt-6-astra"], outcome: "unsupported" },
  { args: ["codex", "unknown-profile"], outcome: "unknown-profile" },
  { args: ["codex", "--no-always", "--require-proven-isolation"], outcome: "isolation" },
  { args: ["codex", "--no-always", "--require-proven-isolation", "--dry-run"], outcome: "dry-run" },
  { args: ["pi", "--no-always", "--require-proven-isolation"], outcome: "launched" },
]

for (const { args, outcome } of cases)
  test(`full run oracle validation order: ${args.join(" ")}`, async () => {
    const options = parseRunArguments(args)
    expect(expectedRunOutcome(options, catalog)).toBe(outcome)
    const world = await createCleanRunWorld()
    try {
      const running = runNative(options, {
        ...world.dependencies,
        environment: {
          ...world.dependencies.environment,
          TRELLAGE_CONFIG: configPath,
          TRELLAGE_DEV_SOURCES: process.env.TRELLAGE_DEV_SOURCES,
        },
        refreshHarness: async () => undefined,
      })
      if (outcome === "dry-run" || outcome === "launched") expect(await running).toBe(outcome === "dry-run" ? 0 : 23)
      else await expect(running).rejects.toMatchObject({ code: outcome })
      expect(world.launches.length).toBe(outcome === "launched" ? 1 : 0)
      expect(world.unexpected).toEqual([])
    } finally {
      await world.close()
    }
  }, 120000)
