import assert from "node:assert/strict"

assert.equal(process.versions.bun, "1.4.2")
process.stdout.write(
  JSON.stringify({
    sentinel: "TRELLAGE_BUN_SOURCE_EXECUTED",
    args: process.argv.slice(2),
  }) + "\n",
)
