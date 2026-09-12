import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { bunExecutable, sourceWorkspaceRoot } from "@trellage/runtime"
import plugin from "../herdr-plugin.toml"

const prefix = ["env", "BUN_RUNTIME_TRANSPILER_CACHE_PATH=0", "bun"]
const runtimePrefix = [...prefix, "--no-install", "--no-env-file", "--config=/dev/null"]
const commands = [...plugin.actions, ...plugin.events, ...plugin.panes].map((entry) => entry.command)

const fixtureTree = async (root: string) => {
  const entries = (await readdir(root, { recursive: true })).sort()
  return Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry)
    const status = await lstat(target)
    return { path: entry, mode: status.mode, content: status.isFile() ? await readFile(target) : null }
  }))
}

test("PoC launch commands isolate Bun before plugin-relative source execution", async (t) => {
  assert.equal(commands.length, 11)
  for (const command of commands) {
    assert.deepEqual(command.slice(0, runtimePrefix.length), runtimePrefix)
    assert.equal(command.length, runtimePrefix.length + 2)
    assert.match(command.at(-2), /^[a-z-]+\.ts$/)
    assert.equal(command.at(-1), "--")
  }

  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-poc-runtime-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, "home")
  const cwd = path.join(root, "plugin")
  await mkdir(home, { mode: 0o700 })
  await mkdir(cwd, { mode: 0o700 })
  const preload = path.join(root, "untrusted-preload.ts")
  await writeFile(preload, 'throw new Error("Untrusted Bun preload executed")\n')
  const config = `preload = [${JSON.stringify(preload)}]\n`
  await writeFile(path.join(home, ".bunfig.toml"), config)
  await writeFile(path.join(cwd, "bunfig.toml"), config)
  await writeFile(path.join(cwd, ".env"), "CONVERSATION_TEST_ENV_SENTINEL=must-not-load\n")
  for (const name of new Set(commands.map((command) => command.at(-2)))) {
    await writeFile(path.join(cwd, name), `
const message: string = "owned-plugin-fixture"
process.stdout.write(JSON.stringify({
  message,
  argv: process.argv.slice(2),
  bun: process.versions.bun,
  cache: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH,
  environmentLoaded: process.env.CONVERSATION_TEST_ENV_SENTINEL !== undefined,
}))
`)
  }
  const before = await fixtureTree(root)
  const forwarded = ["--eval", "throw new Error('arguments executed')", "--config=/does-not-exist"]
  for (const command of commands) {
    const result = spawnSync(command[0], [...command.slice(1), ...forwarded], {
      cwd,
      env: {
        PATH: [path.dirname(bunExecutable()), "/usr/bin", "/bin"].join(path.delimiter),
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(home, "must-not-create-cache"),
      },
      encoding: "utf8",
      timeout: 5_000,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, "")
    assert.deepEqual(JSON.parse(result.stdout), {
      message: "owned-plugin-fixture",
      argv: forwarded,
      bun: "1.3.3",
      cache: "0",
      environmentLoaded: false,
    })
  }
  assert.deepEqual(await fixtureTree(root), before)
})

test("PoC dependency preparation is an explicit frozen build command", () => {
  assert.equal(plugin.build.length, 1)
  assert.deepEqual(plugin.build[0].command, ["bash", "prepare.sh"])
})

test("prepared plugin links retain the canonical source workspace", async () => {
  const pluginRoot = path.resolve(import.meta.dir, "..")
  for (const name of ["conversation-source", "guide-core", "runtime"]) {
    const dependency = path.join(pluginRoot, "node_modules", "@trellage", name)
    assert.equal((await lstat(dependency)).isSymbolicLink(), true)
    assert.equal(await realpath(dependency), path.join(sourceWorkspaceRoot(), "packages", `trellage-${name}`))
  }
})
