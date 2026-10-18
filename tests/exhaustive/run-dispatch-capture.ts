import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import path from "node:path"

assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1")
const receipt = process.env.TRELLAGE_DISPATCH_RECEIPT
assert.ok(receipt)
const root = path.resolve(import.meta.dir, "../..")
const entries = [
  "packages/trellage-runtime/src/native-run/cli.ts",
  "packages/trellage-launcher/src/run-select-cli.tsx",
].map((entry) => path.join(root, entry))
const args = process.argv.slice(2)
const index = args.findIndex((arg) => entries.includes(arg))
assert.ok(index >= 0, "Expected the actual router's selected entrypoint")
writeFileSync(receipt, JSON.stringify({ entry: args[index], argv: args.slice(index + 1) }), { flag: "wx", mode: 0o600 })
if (args[index] === entries[0] && JSON.stringify(args.slice(index + 1)) === '["--help"]') {
  const { main } = await import("../../packages/trellage-runtime/src/native-run/run.ts")
  process.exitCode = await main(["--help"])
}
