// Test isolation: the factory config, its runtime overrides and the state dir point at a fresh temp folder.
// Bun may run several test files in one process: after every test, restore the env and drop any config store a test
// installed, so a test never sees another file's config (e.g. a changed fix-round limit).
import { afterEach } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { resetConfigStore } from "../src/config.ts"

const root = mkdtempSync(path.join(tmpdir(), "sf-test-"))
const env = { SF_CONFIG: path.join(root, "factory", "config.toml"), SF_STATE_DIR: path.join(root, "state") }
Object.assign(process.env, env)

afterEach(() => {
  Object.assign(process.env, env)
  resetConfigStore()
})
