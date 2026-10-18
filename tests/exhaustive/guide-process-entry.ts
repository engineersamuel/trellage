import { existsSync, writeFileSync } from "node:fs"
import assert from "node:assert/strict"
import { mock } from "bun:test"
import path from "node:path"
import { installGuideModelFixture } from "./guide-model-fixture.ts"

if (process.env.TRELLAGE_TEST_OFFLINE !== "1") throw Error("Guide process fixtures require offline execution")
const receipt = process.env.TRELLAGE_GUIDE_TEST_AUDIT
if (!receipt || existsSync(receipt)) throw Error("A new mock-audit receipt path is required")
const fixture = await installGuideModelFixture()
let clipboard: string | undefined
const clipboardModule = await import("../../packages/trellage-launcher/src/ritual-clipboard.ts")
const copyWithFixtureIO = clipboardModule.copyTextToClipboard
mock.module("../../packages/trellage-launcher/src/ritual-clipboard.ts", () => ({
  ...clipboardModule,
  copyTextToClipboard: (value: string) =>
    fixture.audit.run("clipboard.copy", () => {
      assert.equal(process.env.TRELLAGE_GUIDE_TEST_ALLOW_CLIPBOARD, "1", "Unexpected clipboard access")
      copyWithFixtureIO(value, {
        run: (command, args, input) => {
          assert.equal(command, process.platform === "darwin" ? "pbcopy" : "wl-copy")
          assert.deepEqual(args, [])
          assert.equal(input, value)
          clipboard = input
          return { status: 0 }
        },
        read: () => ({ ok: clipboard !== undefined, value: clipboard ?? "" }),
      })
    }),
}))
fixture.configure({
  fallback: process.env.TRELLAGE_GUIDE_TEST_FALLBACK === "1",
  optimize: process.env.TRELLAGE_GUIDE_TEST_OPTIMIZE === "1",
})
process.on("exit", () => {
  let failure: string | undefined
  try {
    fixture.audit.assertClean()
  } catch (error) {
    failure = error instanceof Error ? error.stack : String(error)
    process.stderr.write(`${failure}\n`)
    process.exitCode = 2
  }
  writeFileSync(
    receipt,
    JSON.stringify({
      clean: failure === undefined,
      failure,
      calls: fixture.audit.snapshot(),
      expectedMatches: fixture.expectedMatches(),
      routing: fixture.providerRouting(),
      clipboard,
    }) + "\n",
    {
      flag: "wx",
      mode: 0o600,
    },
  )
})

process.argv[1] = path.resolve(import.meta.dir, "../../packages/trellage-launcher/src/cli.tsx")
try {
  const { main } = await import("../../packages/trellage-launcher/src/cli.tsx")
  await main()
  fixture.audit.assertClean()
} catch (error) {
  process.stderr.write(`trellage-launcher: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 2
}
