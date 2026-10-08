import { afterEach, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { Effect } from "effect"
import { loadTrellageConfig, parseTrellageConfig } from "@trellage/runtime/native-config"

const execFilePromise = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true })
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-native-config-"))
  roots.push(root)
  return root
}

test("reads an explicit Native capability catalog alongside existing environment settings", async () => {
  const config = await Effect.runPromise(
    parseTrellageConfig(`
schema_version = 1

[environment]
enabled = false
path = "environment"

[native.sources.superpowers]
repository = "obra/superpowers"

[native.sources.office]
repository = "example/office"
tag = "v1.2.3"

[native.sources.tools]
repository = "example/tools"
commit = "0123456789abcdef0123456789abcdef01234567"

[native.profiles.work]
label = "Work"
skills = [{ source = "superpowers", names = ["brainstorming", "writing-plans"] }]
plugins = [{ source = "office", harness = "claude", path = "." }]
`),
  )

  expect(config).toEqual({
    schema_version: 1,
    environment: {
      provider: "varlock",
      enabled: false,
      path: "environment",
      required: false,
      strict_permissions: true,
    },
    native: {
      instructions: {},
      sources: {
        superpowers: { repository: "obra/superpowers" },
        office: { repository: "example/office", tag: "v1.2.3" },
        tools: { repository: "example/tools", commit: "0123456789abcdef0123456789abcdef01234567" },
      },
      profiles: {
        work: {
          label: "Work",
          always: false,
          instructions: [],
          skills: [{ source: "superpowers", names: ["brainstorming", "writing-plans"] }],
          plugins: [{ source: "office", harness: "claude", path: "." }],
        },
      },
    },
  })
})

test.each([
  'repository = "https://github.com/example/skills"',
  'repository = "../skills"',
  'repository = "example/skills"\ntag = "v1"\ncommit = "0123456789abcdef0123456789abcdef01234567"',
  'repository = "example/skills"\ncommit = "0123456"',
  'repository = "example/skills"\ntag = "main..release"',
  'repository = "example/skills"\ntag = "release branch"',
  'repository = "example/skills"\ntag = "release\\u001F"',
  'repository = "example/skills"\nref = "main"',
])("rejects an unsafe or ambiguous source declaration: %s", async (declaration) => {
  await expect(Effect.runPromise(parseTrellageConfig(`[native.sources.example]\n${declaration}\n`))).rejects.toThrow(
    "invalid [native] configuration",
  )
})

test.each([
  'skills = [{ source = "missing", names = ["writing-plans"] }]',
  'skills = [{ source = "known", names = ["*"] }]',
  'skills = [{ source = "known", names = ["../outside"] }]',
  'skills = [{ source = "known", names = [] }]',
  'plugins = [{ source = "missing", harness = "claude", path = "." }]',
  'plugins = [{ source = "known", harness = "claude", path = "../outside" }]',
  'plugins = [{ source = "known", harness = "claude", path = "/tmp/plugin" }]',
  'plugins = [{ source = "known", harness = "claude", path = "a/../../outside" }]',
  'plugins = [{ source = "known", harness = "claude", path = "a\\\\b" }]',
  'plugins = [{ source = "known", harness = "claude", path = "a\\u007Fb" }]',
  'plugin = "ignored-typo"',
])("rejects undeclared or unsafe profile content: %s", async (selection) => {
  await expect(
    Effect.runPromise(
      parseTrellageConfig(
        `[native.sources.known]\nrepository = "example/skills"\n[native.profiles.work]\n${selection}\n`,
      ),
    ),
  ).rejects.toThrow("invalid [native] configuration")
})

test("loads the explicit user config without rewriting comments or adding a skill baseline", async () => {
  const home = await fixture()
  const source = "# Keep this authored comment.\n[environment]\nenabled = false\n"
  const configPath = path.join(home, "custom.toml")
  await writeFile(configPath, source, { mode: 0o600 })

  const loaded = await Effect.runPromise(
    loadTrellageConfig({
      home,
      cwd: home,
      environment: { TRELLAGE_CONFIG: "~/custom.toml", XDG_CONFIG_HOME: path.join(home, "ignored") },
    }),
  )

  expect(loaded.path).toBe(configPath)
  expect(loaded.present).toBe(true)
  expect(loaded.config.environment.enabled).toBe(false)
  expect(loaded.config.native).toEqual({ sources: {}, instructions: {}, profiles: {} })
  expect(await readFile(configPath, "utf8")).toBe(source)
})

test.each([
  { name: "default", environment: {}, suffix: ".config/trellage/config.toml" },
  { name: "XDG", environment: { XDG_CONFIG_HOME: "settings" }, suffix: "settings/trellage/config.toml" },
  { name: "relative override", environment: { TRELLAGE_CONFIG: "custom.toml" }, suffix: "custom.toml" },
])("resolves $name config paths and keeps absent configuration optional", async ({ environment, suffix }) => {
  const home = await fixture()
  const result = await Effect.runPromise(loadTrellageConfig({ home, cwd: home, environment }))
  expect(result.path).toBe(path.join(home, suffix))
  expect(result.present).toBe(false)
  expect(result.config).toEqual({
    schema_version: 1,
    environment: { provider: "varlock", enabled: true, required: false, strict_permissions: true },
    native: { sources: {}, instructions: {}, profiles: {} },
  })
})

test("rejects symbolic links, directories, and writable user config files", async () => {
  const home = await fixture()
  const configPath = path.join(home, "config.toml")
  const target = path.join(home, "target.toml")
  const load = () => Effect.runPromise(loadTrellageConfig({ home, environment: { TRELLAGE_CONFIG: configPath } }))
  await writeFile(target, "[environment]\nenabled = false\n", { mode: 0o600 })
  await symlink(target, configPath)
  await expect(load()).rejects.toThrow(/Trellage config/)
  await rm(configPath)
  await symlink(path.join(home, "missing.toml"), configPath)
  await expect(load()).rejects.toThrow(/Trellage config/)
  await rm(configPath)
  await mkdir(configPath)
  await expect(load()).rejects.toThrow(/regular file/)
  await rm(configPath, { recursive: true })
  await writeFile(configPath, "", { mode: 0o600 })
  await chmod(configPath, 0o622)
  await expect(load()).rejects.toThrow(/must not be writable by group or other users/)
})

test.each([
  "schema_version = 2",
  'schema_version = "1"',
  "[native]\nunrecognized = true",
  '[native.sources.Invalid]\nrepository = "example/skills"',
  '[native.profiles."../outside"]',
  '[native.sources.known]\nrepository = "example/skills"\n[native.profiles.work]\nskills = [{ source = "constructor", names = ["known"] }]',
])("rejects invalid schema versions, keys, and catalog identifiers: %s", async (source) => {
  await expect(Effect.runPromise(parseTrellageConfig(source))).rejects.toThrow(/invalid/)
})

test("does not expose rejected values in configuration errors", async () => {
  for (const source of [
    '[environment]\npath = ["fixture-value-do-not-echo"]',
    '[native.sources.known]\nrepository = "https://fixture-value-do-not-echo@example.test"',
    '[native.sources.known]\ntag = "fixture-value-do-not-echo',
  ]) {
    const failure = await Effect.runPromise(parseTrellageConfig(source).pipe(Effect.flip))
    expect(failure.message).toMatch(/invalid/)
    expect(failure.message).not.toContain("fixture-value-do-not-echo")
  }
})

test("leaves other top-level configuration sections available to their own consumers", async () => {
  const result = await Effect.runPromise(parseTrellageConfig('[other]\nsetting = "preserved elsewhere"\n'))
  expect(result.native).toEqual({ sources: {}, instructions: {}, profiles: {} })
  expect(result.environment.enabled).toBe(true)
})

test("normalizes repository and commit identities without changing tag spelling", async () => {
  const result = await Effect.runPromise(
    parseTrellageConfig(`
[native.sources.commit]
repository = "Example/Skills"
commit = "ABCDEF0123456789ABCDEF0123456789ABCDEF01"
[native.sources.tag]
repository = "Example/Skills"
tag = "Release-1"
`),
  )
  expect(result.native.sources).toEqual({
    commit: { repository: "example/skills", commit: "abcdef0123456789abcdef0123456789abcdef01" },
    tag: { repository: "example/skills", tag: "Release-1" },
  })
})

test("rejects a named-pipe config without waiting for a writer", async () => {
  const home = await fixture()
  const configPath = path.join(home, "config.toml")
  await execFilePromise("mkfifo", [configPath])
  await expect(
    execFilePromise(
      process.execPath,
      [
        "--no-install",
        "--no-env-file",
        "--config=/dev/null",
        "-e",
        'import { Effect } from "effect"; import { loadTrellageConfig } from "@trellage/runtime/native-config"; await Effect.runPromise(loadTrellageConfig());',
      ],
      { cwd: import.meta.dirname, env: { HOME: home, TRELLAGE_CONFIG: configPath }, timeout: 2000 },
    ),
  ).rejects.toThrow("regular file")
})
