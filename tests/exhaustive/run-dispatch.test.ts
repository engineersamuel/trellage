import assert from "node:assert/strict"
import path from "node:path"
import { test } from "bun:test"
import { guideWorld } from "./guide-world.ts"
import { commandInventory } from "./inventory.ts"
import { observeRunDispatch, expectedRunDispatch } from "./run-dispatch.ts"

test("actual router dispatch preserves operands and applies first-argument precedence", async () => {
  const root = path.resolve(import.meta.dir, "../..")
  const inventory = await commandInventory(root)
  const world = await guideWorld(root)
  const suffixes = [[], ["--model", "quote ' $() `literal`\n日本語", "--", "-p", "--help"]]
  const prefixes = [
    [],
    [""],
    ...[
      ...inventory.harnesses,
      "-h",
      "--help",
      "help",
      "--dry-run",
      "--no-always",
      "--allow-unproven-isolation",
      "--require-proven-isolation",
      "unknown-harness",
      "--plan",
      "--model",
      "office",
    ].map((value) => [value]),
  ]
  let ordinal = 0n
  try {
    for (const prefix of prefixes)
      for (const suffix of suffixes) {
        const argv = [...prefix, ...suffix]
        assert.deepEqual(
          await observeRunDispatch(world, argv, ordinal++),
          expectedRunDispatch(argv, inventory.harnesses),
          JSON.stringify(argv),
        )
      }
  } finally {
    await world.dispose()
  }
}, 60000)
