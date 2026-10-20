import { expect, test } from "bun:test"
import { parseGuideHeadlessArgv } from "../packages/trellage-launcher/src/guide-api.ts"
import { createGuideWorld } from "./exhaustive-guide-world.ts"
import { assertGuideJsonService } from "./exhaustive-guide-json.ts"

const world = await createGuideWorld()
for (const entry of world.catalog.native)
  test(`JSON generation reaches ${entry.launcher}/${entry.name}`, async () => {
    const args = parseGuideHeadlessArgv([
      "--json",
      "--profile",
      `native:${entry.launcher}/${entry.name}`,
      "--intent",
      "Inspect this repository",
      "--model",
      "fixture-model",
      "--effort",
      "high",
    ])
    expect(await assertGuideJsonService(args, world, "profile generation")).toBe("generation")
  })

for (const [name, argv, expected] of [
  ["stdin matching", ["--json"], "match"],
  ["explicit matching", ["--json", "--intent", "Inspect this repository"], "match"],
  ["unknown profile", ["--json", "--profile", "native:unknown/unknown"], "unknown-profile"],
  ["legacy Prime alias", ["--json", "--profile", "native:prx/default"], "unknown-profile"],
  ["legacy Agency profile", ["--json", "--profile", "native:agency/trellage-azure"], "unknown-profile"],
  ["undeclared Prime profile", ["--json", "--profile", "native:copilot/prime-agent"], "unknown-profile"],
  ["help", ["--help"], "help"],
  ["interactive intent", [], "interactive-intent"],
  ["interactive stdin", ["--intent-stdin"], "interactive-intent"],
  ["review scopes", ["--review"], "review-target"],
  ["review explicit base", ["--review", "--base", "origin/main"], "review-target"],
  ["review missing base", ["--review", "--base", "a"], "review-target"],
  ["review routing", ["--review", "--model", "fixture-model", "--effort", "medium"], "review-target"],
  ["ritual default selection", ["--prompts"], "ritual-ui"],
  ["ritual selected ID", ["--prompts", "progress-page"], "ritual-ui"],
  ["ritual missing ID", ["--prompts", "review-code"], "ritual-ui"],
  ["continuation launch", ["--next-steps"], "next-steps-launch"],
  [
    "continuation routing options reach the private draft",
    ["--effort", "high", "--model", "fixture-model", "--next-steps"],
    "next-steps-launch",
  ],
  ["ritual print", ["--prompts", "progress-page", "--print"], "ritual-print"],
  ["ritual copy", ["--prompts", "progress-page", "--copy"], "ritual-copy"],
  ["unknown ritual print", ["--prompts", "review-code", "--print"], "unknown-ritual"],
  ["unknown ritual copy", ["--prompts", "review-code", "--copy"], "unknown-ritual"],
] as const)
  test(
    name,
    async () => {
      expect(await assertGuideJsonService(parseGuideHeadlessArgv(argv), world, name, argv)).toBe(expected)
    },
    argv.some((argument) => argument === "--review") ? 3_600_000 : 35_000,
  )
