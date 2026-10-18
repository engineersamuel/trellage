import path from "node:path"
import { test } from "bun:test"
import { guideWorld } from "./guide-world.ts"
import { verifyRootHelp } from "./root-help.ts"

test("root help takes precedence over run and guide arguments without starting Bun", async () => {
  const world = await guideWorld(path.resolve(import.meta.dir, "../.."))
  let ordinal = 0n
  try {
    for (const command of ["run", "guide"] as const)
      for (const alias of ["-h", "--help", "help"])
        for (const argv of [
          [],
          ["unknown-harness", "--model", ""],
          ["--json", "--review", "--forks", "unknown"],
          ["--", "quote ' $() `literal`\n日本語"],
        ])
          await verifyRootHelp(world, command, [alias], argv, ordinal++)
  } finally {
    await world.dispose()
  }
}, 60000)
