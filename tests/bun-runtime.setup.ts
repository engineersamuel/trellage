import assert from "node:assert/strict"

process.env.TRELLAGE_TEST_OFFLINE = "1"

assert.ok(
  process.versions.bun,
  `First-party tests must run with Bun, not ${process.execPath}. Use the package's explicit Bun script: bun run test.`,
)
