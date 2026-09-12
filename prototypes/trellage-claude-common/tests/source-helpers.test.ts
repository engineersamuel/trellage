import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "bun:test"
import { fileURLToPath } from "node:url"
import { bunArguments, bunExecutable } from "@trellage/runtime"

const repository = fileURLToPath(new URL("../../../", import.meta.url))

test("environment source ignores caller environment files and Bun preloads", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trellage-source-helpers-"))
  try {
    const home = path.join(directory, "home")
    const config = path.join(home, ".config", "trellage", "config.toml")
    await mkdir(path.dirname(config), { recursive: true, mode: 0o700 })
    await writeFile(config, "[environment]\nenabled = false\n", { mode: 0o600 })
    await writeFile(path.join(directory, ".env"), "TRELLAGE_ENVIRONMENT=invalid-fixture-value\n")
    const preload = path.join(directory, "preload.ts")
    await writeFile(preload, 'throw new Error("Unexpected caller Bun preload")\n')
    await writeFile(path.join(directory, "bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`)
    await writeFile(path.join(home, ".bunfig.toml"), `preload = [${JSON.stringify(preload)}]\n`)
    const result = spawnSync(bunExecutable(), bunArguments(path.join(repository, "scripts", "native-environment.ts")), {
      cwd: directory,
      env: { HOME: home, PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 10_000,
    })

    assert.equal(result.status, 0, `${result.stderr}\n${result.error ?? ""}`)
    assert.equal(result.stderr, "")
    assert.deepEqual(JSON.parse(result.stdout), {
      config_path: config,
      config_present: true,
      provider: "varlock",
      enabled: false,
      path: path.dirname(config),
      source_present: false,
      required: false,
      strict_permissions: true,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("Codex role source preflights every destination before publishing managed files", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "trellage-role-source-"))
  try {
    const source = path.join(directory, "source")
    const target = path.join(directory, "target")
    await mkdir(source)
    await mkdir(target)
    const names = ["explorer", "worker", "tester", "researcher", "reviewer"]
    for (const name of names) {
      await writeFile(path.join(source, `${name}.toml`), `model = "fixture-${name}"\n`)
    }
    const collision = path.join(target, "reviewer.toml")
    await writeFile(collision, "# User-owned role\n")
    const run = (command: string) =>
      spawnSync(
        bunExecutable(),
        bunArguments(path.join(repository, "prototypes/trellage-codex-common/codex-agents.ts"), [
          command,
          target,
          source,
        ]),
        { cwd: directory, encoding: "utf8", timeout: 10_000 },
      )

    const refused = run("install")
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /unmanaged role name collision/)
    assert.deepEqual(await readdir(target), ["reviewer.toml"])
    assert.equal(await readFile(collision, "utf8"), "# User-owned role\n")

    await rm(collision)
    const installed = run("install")
    assert.equal(installed.status, 0, installed.stderr)
    assert.deepEqual((await readdir(target)).sort(), [
      "explorer.toml",
      "researcher.toml",
      "reviewer.toml",
      "tester.toml",
      "worker.toml",
    ])
    for (const name of names) {
      const file = path.join(target, `${name}.toml`)
      assert.equal(await readFile(file, "utf8"), `# trellage-managed-codex-role-v1\nmodel = "fixture-${name}"\n`)
      assert.equal((await lstat(file)).mode & 0o777, 0o600)
    }
    const verified = run("verify")
    assert.equal(verified.status, 0, verified.stderr)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
