import { afterEach, expect, test } from "bun:test"
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import path from "node:path"
import { pruneGenerations } from "../../src/native-run/lease.ts"
import { prepareRun, runNative, type RunDependencies } from "../../src/native-run/run.ts"
import { gitSourceTransport } from "../../src/native-run/source.ts"
import { WORKER_GENERATION_MARKER } from "../../src/native-run/worker-handoff.ts"
import { cleanupFixtures, fixturePaths, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)

const base = { dryRun: false, allowUnprovenIsolation: true, forwardedArgs: [] as string[] }

const world = async () => {
  const root = await tempRoot("workers")
  const home = path.join(root, "fleet")
  await mkdir(home)
  const shims = path.join(root, ".local", "share", "mise", "shims")
  await mkdir(shims, { recursive: true })
  const configPath = path.join(root, "config.toml")
  await writeFile(
    configPath,
    `[native.profiles.fleet]\nharnesses = ["claude", "pi"]\ncurrent_working_directory = ${JSON.stringify(home)}\nworkers = "firstmate"\n`,
    { mode: 0o600 },
  )
  const lifecycle = path.join(root, "claude-lifecycle")
  await writeFile(lifecycle, `#!/bin/sh\nprintf '{"pluginDir":null}'\n`, { mode: 0o755 })
  const paths = await fixturePaths(root)
  const dependencies: RunDependencies = {
    environment: { PATH: process.env.PATH ?? "", TRELLAGE_CONFIG: configPath, HOME: root, TRELLAGE_CLAUDE_LIFECYCLE_BIN: lifecycle },
    paths,
    cwd: root,
    transport: gitSourceTransport(() => {
      throw new Error("no sources")
    }),
    write: () => undefined,
    refreshHarness: async () => undefined,
    spawner: async (_launch, _environment, _cwd, onSpawn) => {
      onSpawn(undefined)
      return 0
    },
  }
  return { root, home, shims, paths, dependencies }
}

test("a Claude supervisor's workers find the proxy setup in the shared config directory", async () => {
  const { dependencies, shims } = await world()
  const options = { ...base, harness: "claude", profiles: ["fleet"] }
  expect(await runNative(options, dependencies)).toBe(0)
  const prepared = await prepareRun(options, dependencies)
  const settings = JSON.parse(await readFile(path.join(prepared.layout.generationPath, "settings.json"), "utf8"))
  expect(settings.env).toMatchObject({
    ANTHROPIC_BASE_URL: "http://127.0.0.1:8080",
    ANTHROPIC_AUTH_TOKEN: "trellage-local-proxy",
  })
  expect(settings.model).toBe("opusplan")
  expect(settings.env.PATH.split(path.delimiter)[0]).toBe(shims)
  expect(settings.env.PATH).toContain(process.env.PATH?.split(path.delimiter)[0] ?? "")
  expect(existsSync(path.join(prepared.layout.generationPath, WORKER_GENERATION_MARKER))).toBe(true)
})

test("a Pi supervisor pins Firstmate's Pi workers, and a Claude run clears only that pin", async () => {
  const { home, shims, dependencies } = await world()
  expect(await runNative({ ...base, harness: "pi", profiles: ["fleet"] }, dependencies)).toBe(0)
  const piSettings = JSON.parse(
    await readFile(
      path.join((await prepareRun({ ...base, harness: "pi", profiles: ["fleet"] }, dependencies)).layout.generationPath, "settings.json"),
      "utf8",
    ),
  )
  expect(piSettings.shellCommandPrefix).toStartWith(`export PATH='${shims}':`)
  expect(piSettings.shellCommandPrefix).toEndWith(`:"$PATH";`)
  const prepared = await prepareRun({ ...base, harness: "pi", profiles: ["fleet"] }, dependencies)
  expect(await readFile(path.join(home, "config", "pi-account"), "utf8")).toBe(
    `${prepared.layout.generationPath}\ncopilot-proxy-rs\n`,
  )
  const dispatch = JSON.parse(await readFile(path.join(home, "config", "crew-dispatch.json"), "utf8"))
  expect(dispatch.default).toMatchObject({ harness: "pi", model: "copilot-proxy-rs/gpt-6-astra", effort: "medium" })

  expect(await runNative({ ...base, harness: "claude", profiles: ["fleet"] }, dependencies)).toBe(0)
  expect(existsSync(path.join(home, "config", "pi-account"))).toBe(false)
  expect(existsSync(path.join(home, "config", "crew-dispatch.json"))).toBe(false)
})

test("worker config files the user wrote are never replaced or removed", async () => {
  const { home, dependencies } = await world()
  await mkdir(path.join(home, "config"))
  await writeFile(path.join(home, "config", "crew-dispatch.json"), '{"rules":[]}\n')
  await expect(runNative({ ...base, harness: "pi", profiles: ["fleet"] }, dependencies)).rejects.toThrow(/was not written by trx/)
  expect(await runNative({ ...base, harness: "claude", profiles: ["fleet"] }, dependencies)).toBe(0)
  expect(await readFile(path.join(home, "config", "crew-dispatch.json"), "utf8")).toBe('{"rules":[]}\n')
})

test("pruning keeps a generation with recent workers and collects an old one", async () => {
  const { root, paths } = await world()
  const owner = path.join(root, "owner")
  const old = new Date(Date.now() - 60_000)
  for (const name of ["a", "b", "c", "d", "e"]) {
    await mkdir(path.join(owner, "generations", name), { recursive: true })
    await utimes(path.join(owner, "generations", name), old, old)
  }
  await writeFile(path.join(owner, "generations", "d", WORKER_GENERATION_MARKER), "now\n")
  const stale = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  await writeFile(path.join(owner, "generations", "e", WORKER_GENERATION_MARKER), "then\n")
  await utimes(path.join(owner, "generations", "e", WORKER_GENERATION_MARKER), stale, stale)
  await utimes(path.join(owner, "generations", "d"), old, old)
  await utimes(path.join(owner, "generations", "e"), old, old)
  const removed = await pruneGenerations(paths, owner, 0, "a")
  expect(removed.sort()).toEqual(["b", "c", "e"])
})
