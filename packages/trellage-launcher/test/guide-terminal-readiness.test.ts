import { fileURLToPath } from "node:url"
import { expect, test } from "vitest"
import { FixtureMode } from "./fixtures/guide-integration-data.ts"
import { createGuideTerminal } from "./helpers/guide-terminal.ts"

test("a painted guide with a revoked input-enable marker does not accept input", async ({ onTestFailed }) => {
  const guide = await createGuideTerminal(
    fileURLToPath(new URL("./fixtures/guide-input-disabled.ts", import.meta.url)),
    onTestFailed,
  )
  try {
    await expect(guide.start(FixtureMode.Terminal)).rejects.toThrow("Guide terminal input is not enabled")
  } finally {
    await guide.close()
  }
}, 10_000)
