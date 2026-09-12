import assert from "node:assert/strict"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import { mock } from "bun:test"

import "../../../../tests/bun-runtime.setup.ts"

const publicPath = process.env.TRELLAGE_TEST_RELEASE_PUBLIC
const privatePath = process.env.TRELLAGE_TEST_RELEASE_PRIVATE
const marker = process.env.TRELLAGE_TEST_RELEASE_MARKER
assert.ok(publicPath, "The lock-release fixture requires a public lock path.")
assert.ok(privatePath, "The lock-release fixture requires a private lock path.")
assert.ok(marker, "The lock-release fixture requires a marker path.")
assert.notEqual(publicPath, privatePath, "The fixture requires two distinct hardlink paths.")

const originalOpen = fsPromises.open
let released = false

mock.module("node:fs/promises", () => ({
  ...fsPromises,
  open: async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args)
    if (!released && String(args[0]) === publicPath) {
      released = true
      await fsPromises.rm(publicPath, { force: true })
      await fsPromises.rm(privatePath, { force: true })
      assert.equal((await handle.stat()).nlink, 0, "Both lock links must be removed before validation.")
      fs.writeFileSync(marker, "released\n")
    }
    return handle
  },
}))
