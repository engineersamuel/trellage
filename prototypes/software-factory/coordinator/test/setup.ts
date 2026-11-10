// Test isolation: the factory config, its runtime overrides and the state dir point at a fresh temp folder.
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const root = mkdtempSync(path.join(tmpdir(), "sf-test-"))
process.env.SF_CONFIG = path.join(root, "factory", "config.toml")
process.env.SF_STATE_DIR = path.join(root, "state")
