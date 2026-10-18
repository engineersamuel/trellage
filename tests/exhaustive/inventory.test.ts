import { expect, test } from "bun:test"
import { discoverFlags, assertFlagInventory, assertRootOptionInventory } from "./inventory.ts"
import { exhaustiveDomains } from "./domains.ts"
import { shippedRituals } from "../../packages/trellage-launcher/src/ritual-catalog.ts"

test("guide domain includes every shipped ritual as a valid positional input", async () => {
  const declaration = await exhaustiveDomains(new URL("../../", import.meta.url).pathname)
  const positional = declaration.matrices.guide.find((domain) => domain.name === "positional")!
  for (const ritual of shippedRituals) expect(positional.values.some((value) => value.argv[0] === ritual.id)).toBe(true)
})

test("inventory drift rejects a parser flag that has no exhaustive domain", () => {
  const original = 'const flags = { "--dry-run": () => true, "--plan": () => true }'
  expect(discoverFlags(original)).toEqual(["--dry-run", "--plan"])
  expect(() => assertFlagInventory(original, ["--dry-run", "--plan"])).not.toThrow()
  expect(() => assertFlagInventory(original.replace('"--plan"', '"--future"'), ["--dry-run", "--plan"])).toThrow(
    "Flag inventory changed",
  )
})

test("inline forms and repeated parser branches do not invent extra option names", () => {
  expect(discoverFlags('arg === "--model" || arg.startsWith("--model="); flags["--model"]')).toEqual(["--model"])
})

test("root inventory detects added flags and help aliases before matrix execution", async () => {
  const source = await Bun.file(new URL("../../prototypes/trellage-router/bin/trx", import.meta.url)).text()
  expect(() => assertRootOptionInventory(source)).not.toThrow()
  expect(() =>
    assertRootOptionInventory(source.replace("  -h|--help|help)", "  --future) exit 0 ;;\n  -h|--help|help)")),
  ).toThrow("Root option inventory changed")
  expect(() => assertRootOptionInventory(source.replace("  -h|--help|help)", "  -h|--help|help|assist)"))).toThrow(
    "Root help aliases changed",
  )
})
