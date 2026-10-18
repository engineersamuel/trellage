import path from "node:path"
import { guideWorld } from "./guide-world.ts"
import { verifyRunSelectorProcess } from "./run-selector-process.ts"

if (process.env.TRELLAGE_TEST_OFFLINE !== "1") throw Error("Run through scripts/test-offline.py")
const args = process.argv.slice(2)
if (args.length > 1 || (args.length === 1 && args[0] !== "--all-terminal-widths"))
  throw Error("Expected --all-terminal-widths or no arguments")
const widths = args.length ? [69, 70, 100] : [100]
const world = await guideWorld(path.resolve(import.meta.dir, "../.."))
let ordinal = 0n
try {
  for (const argv of [
    [],
    ["--dry-run"],
    ["--no-always"],
    ["--allow-unproven-isolation"],
    ["--require-proven-isolation"],
  ]) {
    for (const columns of widths) {
      await verifyRunSelectorProcess(world, argv, ordinal++, columns)
      await verifyRunSelectorProcess(world, argv, ordinal++, columns, "launch")
    }
    await verifyRunSelectorProcess(world, argv, ordinal++)
  }
  console.log(
    `Run selector PASS: ${ordinal} real router cases; terminal navigation/cancellation, launch propagation/status, detached rejection; audited model discovery`,
  )
} finally {
  await world.dispose()
}
