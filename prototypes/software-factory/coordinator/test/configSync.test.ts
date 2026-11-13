import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { syncConfig, syncUserConfig } from "../src/configSync.ts"
import { defaultsPath, loadFactoryConfig } from "../src/config.ts"

const shipped = `# header
[models]
# Workers.
worker = "w"
# New one.
judge = "j"

# Gate workers: no short limit.
[workers]
# Silent this long.
stuck_quiet_minutes = 10
retries = 1
`

test("missing sections and keys are appended commented out; the user's lines stay as they are", () => {
  const user = `# mine
[models]
worker = "mine" # keep
`
  const r = syncConfig(shipped, user)
  expect(r).toMatchObject({ sections: ["workers"], keys: ["models.judge"] })
  expect(r.text).toBe(`# mine
[models]
worker = "mine" # keep
# New one.
# judge = "j"

# Gate workers: no short limit.
[workers]
# Silent this long.
# stuck_quiet_minutes = 10
# retries = 1
`)
  // A second sync adds nothing: commented-out keys count as present.
  expect(syncConfig(shipped, r.text)).toEqual({ text: r.text, sections: [], keys: [] })
})

test("a key goes at the end of its own section, before the next section's description", () => {
  const user = `[models]
worker = "w"

# my workers
[workers]
# stuck_quiet_minutes = 10
# retries = 1
`
  const r = syncConfig(shipped, user)
  expect(r.keys).toEqual(["models.judge"])
  expect(r.text).toBe(`[models]
worker = "w"
# New one.
# judge = "j"

# my workers
[workers]
# stuck_quiet_minutes = 10
# retries = 1
`)
})

test("syncing the real shipped config into an empty file adds every section, and the result keeps the defaults", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sf-cfgsync-"))
  const file = path.join(dir, "config.toml")
  writeFileSync(file, "")
  const dry = syncUserConfig(true, file)
  expect(readFileSync(file, "utf8")).toBe("")
  expect(dry.sections).toContain("workers")
  syncUserConfig(false, file)
  const text = readFileSync(file, "utf8")
  expect(syncUserConfig(true, file).sections).toEqual([])
  // Every added line is a comment: the file parses, sets nothing, and the loaded config is the defaults.
  expect(
    Bun.TOML.parse(
      text
        .split("\n")
        .filter((l) => !/^\[/.test(l))
        .join("\n"),
    ),
  ).toEqual({})
  expect(loadFactoryConfig(file)).toEqual(loadFactoryConfig(path.join(dir, "missing.toml")))
  expect(text).toContain("# stuck_quiet_minutes = 10")
  void defaultsPath
})
