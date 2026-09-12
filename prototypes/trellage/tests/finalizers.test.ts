import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { once } from "node:events"
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, describe, it } from "node:test"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

assert.equal(process.versions.bun, "1.3.3", "finalizer contracts require Bun 1.3.3")

const execFilePromise = promisify(execFile)
const roots: string[] = []
const finalizers = {
  claude: fileURLToPath(new URL("../finalize-claude-seed.ts", import.meta.url)),
  copilot: fileURLToPath(new URL("../finalize-copilot-seed.ts", import.meta.url)),
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const fixtureRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "trellage-bun-finalizers-"))
  roots.push(root)
  await mkdir(path.join(root, "home"))
  await mkdir(path.join(root, "unrelated-cwd"))
  return root
}

const runFinalizer = (root: string, finalizer: string, args: string[], timeout = 0) =>
  execFilePromise(process.execPath, ["--no-env-file", "--no-install", "--config=/dev/null", finalizer, ...args], {
    cwd: path.join(root, "unrelated-cwd"),
    timeout,
    killSignal: "SIGKILL",
    env: {
      HOME: path.join(root, "home"),
      XDG_CONFIG_HOME: path.join(root, "home", ".config"),
      XDG_CACHE_HOME: path.join(root, "home", ".cache"),
      PATH: "/usr/bin:/bin",
      NODE_ENV: "test",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    },
  })

const writeJson = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value)}\n`)

const withUnixSocket = async (root: string, target: string, run: () => Promise<void>): Promise<void> => {
  const server = createServer()
  const socketPath = path.join(root, "s")
  try {
    const listening = once(server, "listening")
    server.listen(socketPath)
    await listening
    assert.ok(server.listening)
    // Bind to a short address before moving into the deeper plugin fixture.
    await rename(socketPath, target)
    assert.ok((await lstat(target)).isSocket())
    await run()
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error)
          else resolve()
        })
      })
    }
  }
}

const claudeFixture = async () => {
  const root = await fixtureRoot()
  const seed = path.join(root, "claude-seed")
  const source = path.join(root, "marketplace")
  const cache = path.join(seed, "plugins", "cache", "catalog", "writer", "1.2.3")
  await mkdir(path.join(source, ".claude-plugin"), { recursive: true })
  await mkdir(path.join(source, "skills", "writer"), { recursive: true })
  await mkdir(path.join(source, "commands"))
  await writeJson(path.join(source, ".claude-plugin", "marketplace.json"), {
    plugins: [{ name: "writer", source: "./" }],
  })
  await writeFile(path.join(source, "instructions.md"), "# Synthetic writer\n")
  await writeFile(path.join(source, "run.sh"), "#!/bin/sh\nprintf 'fixture\\n'\n")
  await chmod(path.join(source, "run.sh"), 0o751)
  await symlink("../../instructions.md", path.join(source, "skills", "writer", "SKILL.md"))
  await symlink("../run.sh", path.join(source, "commands", "run.sh"))
  await cp(source, cache, { recursive: true, verbatimSymlinks: true })
  await writeJson(path.join(seed, "settings.json"), {
    enabledPlugins: { "writer@catalog": true },
    pluginConfigs: {
      "writer@catalog": { options: { enabled: true, limit: 3, tone: "concise" } },
    },
  })
  await writeJson(path.join(seed, "plugins", "installed_plugins.json"), {
    plugins: {
      "writer@catalog": [{ scope: "user", version: "1.2.3", installPath: cache, installedAt: "transient" }],
    },
  })
  await writeJson(path.join(seed, "plugins", "known_marketplaces.json"), { path: source })
  await writeJson(path.join(seed, ".claude.json"), { machineID: "synthetic-transient" })
  await writeJson(path.join(seed, "default-user-settings.json"), { outputStyle: "Rundown" })
  const manifest = path.join(root, "marketplaces.json")
  await writeJson(manifest, {
    marketplaces: [
      {
        marketplace: "catalog",
        source,
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        plugins: [{ plugin: "writer", version: "1.2.3" }],
      },
    ],
  })
  await writeJson(path.join(root, "claude-plugin-configs.json"), {
    pluginConfigs: { "writer@catalog": { enabled: "true", limit: "3", tone: "concise" } },
  })
  return { root, seed, source, cache, manifest }
}

const copilotFixture = async () => {
  const root = await fixtureRoot()
  const seed = path.join(root, "copilot-seed")
  const source = path.join(root, "hve-core")
  const sourcePlugin = path.join(source, "plugins", "hve-core")
  await mkdir(path.join(source, ".github", "plugin"), { recursive: true })
  await mkdir(path.join(sourcePlugin, "skills", "writer"), { recursive: true })
  await writeJson(path.join(source, ".github", "plugin", "marketplace.json"), {
    name: "hve-core",
    metadata: { pluginRoot: "./plugins" },
    plugins: [{ name: "hve-core", source: "hve-core", version: "3.3.101" }],
  })
  await writeJson(path.join(sourcePlugin, "plugin.json"), { name: "hve-core", version: "3.3.101" })
  await writeFile(path.join(sourcePlugin, "README.md"), "# Synthetic plugin\n")
  await writeFile(path.join(sourcePlugin, "run.sh"), "#!/bin/sh\nprintf 'fixture\\n'\n")
  await chmod(path.join(sourcePlugin, "run.sh"), 0o700)
  await symlink("../../README.md", path.join(sourcePlugin, "skills", "writer", "SKILL.md"))
  await mkdir(path.join(seed, "skills", "synthetic"), { recursive: true })
  await writeFile(path.join(seed, "skills", "synthetic", "SKILL.md"), "# Synthetic skill\n")
  await writeJson(path.join(seed, "settings.json"), {
    extraKnownMarketplaces: { "hve-core": { source: { source: "directory", path: source } } },
    enabledPlugins: { "hve-core@hve-core": true },
  })
  await writeJson(path.join(seed, "config.json"), { lastUser: "synthetic-user" })
  return { root, seed, source, sourcePlugin, installed: path.join(seed, "installed-plugins", "hve-core", "hve-core") }
}

describe("source-only seed finalizers", () => {
  it("finalizes Claude state from another cwd and preserves typed options and executable file modes", async () => {
    const fixture = await claudeFixture()

    const result = await runFinalizer(fixture.root, finalizers.claude, [fixture.seed, fixture.manifest, "2.1.222"])

    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
    assert.deepEqual(JSON.parse(await readFile(path.join(fixture.seed, "plugin-settings.json"), "utf8")), {
      enabledPlugins: { "writer@catalog": true },
      pluginConfigs: { "writer@catalog": { options: { enabled: true, limit: 3, tone: "concise" } } },
    })
    assert.deepEqual(JSON.parse(await readFile(path.join(fixture.seed, "default-onboarding.json"), "utf8")), {
      hasCompletedOnboarding: true,
      lastOnboardingVersion: "2.1.222",
      shiftEnterKeyBindingInstalled: true,
    })
    assert.equal(
      await readFile(path.join(fixture.seed, "default-user-settings.json"), "utf8"),
      '{"outputStyle":"Rundown"}\n',
    )
    const registry = await readFile(path.join(fixture.seed, "plugins", "installed_plugins.json"), "utf8")
    assert.deepEqual(JSON.parse(registry), {
      version: 2,
      plugins: {
        "writer@catalog": [
          {
            scope: "user",
            installPath: "/home/agent/.claude/plugins/cache/catalog/writer/1.2.3",
            version: "1.2.3",
            gitCommitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ],
      },
    })
    assert.ok(!registry.includes(fixture.root))
    assert.equal(
      await readFile(path.join(fixture.cache, "skills", "writer", "SKILL.md"), "utf8"),
      "# Synthetic writer\n",
    )
    const executable = await lstat(path.join(fixture.cache, "commands", "run.sh"))
    assert.ok(executable.isFile() && !executable.isSymbolicLink())
    assert.equal(executable.mode & 0o777, 0o751)
    assert.equal((await lstat(path.join(fixture.seed, "plugin-settings.json"))).mode & 0o777, 0o600)
    await assert.rejects(lstat(path.join(fixture.seed, ".claude.json")), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(fixture.seed, "settings.json")), { code: "ENOENT" })
  })

  it("finalizes Copilot source without Node and preserves deterministic manifests and copied modes", async () => {
    const fixture = await copilotFixture()
    const args = [fixture.seed, "hve-core", "hve-core", "3.3.101"]

    const result = await runFinalizer(fixture.root, finalizers.copilot, args)

    assert.equal(result.stdout, "")
    assert.equal(result.stderr, "")
    assert.deepEqual(JSON.parse(await readFile(path.join(fixture.seed, "managed-settings.json"), "utf8")), {
      extraKnownMarketplaces: { "hve-core": { source: { source: "github", repo: "microsoft/hve-core" } } },
      enabledPlugins: { "hve-core@hve-core": true },
    })
    const copied = await lstat(path.join(fixture.installed, "skills", "writer", "SKILL.md"))
    assert.ok(copied.isFile() && !copied.isSymbolicLink())
    assert.equal(copied.mode & 0o777, 0o644)
    assert.equal((await lstat(path.join(fixture.installed, "run.sh"))).mode & 0o777, 0o755)
    assert.equal(
      await readFile(path.join(fixture.installed, "skills", "writer", "SKILL.md"), "utf8"),
      "# Synthetic plugin\n",
    )
    const names = ["managed-settings.json", "managed-files.txt", "managed.sha256", "managed-lock.json"]
    const first = await Promise.all(names.map((name) => readFile(path.join(fixture.seed, name), "utf8")))
    for (const content of first) assert.ok(!content.includes(fixture.root))
    for (const name of names) assert.equal((await lstat(path.join(fixture.seed, name))).mode & 0o777, 0o644)
    await assert.rejects(lstat(path.join(fixture.seed, "config.json")), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(fixture.seed, "settings.json")), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(fixture.seed, ".finalize.lock")), { code: "ENOENT" })

    await runFinalizer(fixture.root, finalizers.copilot, args)

    assert.deepEqual(await Promise.all(names.map((name) => readFile(path.join(fixture.seed, name), "utf8"))), first)
  })

  it("serializes concurrent Bun finalizers and keeps the published Copilot seed deterministic", async () => {
    const fixture = await copilotFixture()
    const args = [fixture.seed, "hve-core", "hve-core", "3.3.101"]

    await Promise.all(Array.from({ length: 4 }, () => runFinalizer(fixture.root, finalizers.copilot, args)))

    const names = ["managed-settings.json", "managed-files.txt", "managed.sha256", "managed-lock.json"]
    const first = await Promise.all(names.map((name) => readFile(path.join(fixture.seed, name), "utf8")))
    await assert.rejects(lstat(path.join(fixture.seed, ".finalize.lock")), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(fixture.seed, ".finalize.recovery")), { code: "ENOENT" })

    await runFinalizer(fixture.root, finalizers.copilot, args)

    assert.deepEqual(await Promise.all(names.map((name) => readFile(path.join(fixture.seed, name), "utf8"))), first)
  })

  for (const [name, finalizer, diagnostic] of [
    ["Claude", finalizers.claude, /usage: finalize-claude-seed <seed> <marketplaces.json> <harness-version>/],
    ["Copilot", finalizers.copilot, /expected exactly 4 arguments: seed marketplace plugin expected-version/],
  ] as const) {
    it(`keeps ${name} CLI argument errors explicit`, async () => {
      const root = await fixtureRoot()

      await assert.rejects(runFinalizer(root, finalizer, []), { code: 1, stdout: "", stderr: diagnostic })
    })
  }

  it("rejects an escaping Claude cache symlink without changing its target or publishing a manifest", async () => {
    const fixture = await claudeFixture()
    const target = path.join(fixture.root, "outside-cache.txt")
    await writeFile(target, "synthetic protected content\n", { mode: 0o600 })
    const link = path.join(fixture.cache, "skills", "writer", "SKILL.md")
    await unlink(link)
    await symlink(target, link)
    const settings = await readFile(path.join(fixture.seed, "settings.json"), "utf8")

    await assert.rejects(runFinalizer(fixture.root, finalizers.claude, [fixture.seed, fixture.manifest, "2.1.222"]), {
      code: 1,
      stderr: /plugin symlink escapes root/,
    })

    assert.equal(await readFile(target, "utf8"), "synthetic protected content\n")
    assert.equal((await lstat(target)).mode & 0o777, 0o600)
    assert.equal(await readFile(path.join(fixture.seed, "settings.json"), "utf8"), settings)
    await assert.rejects(lstat(path.join(fixture.seed, "managed-paths.txt")), { code: "ENOENT" })
  })

  it("rejects an escaping Copilot source symlink before copying the plugin or publishing state", async () => {
    const fixture = await copilotFixture()
    const target = path.join(fixture.root, "outside-source.txt")
    await writeFile(target, "synthetic protected content\n", { mode: 0o600 })
    const link = path.join(fixture.sourcePlugin, "skills", "writer", "SKILL.md")
    await unlink(link)
    await symlink(target, link)

    await assert.rejects(
      runFinalizer(fixture.root, finalizers.copilot, [fixture.seed, "hve-core", "hve-core", "3.3.101"]),
      { code: 1, stderr: /live plugin symlink target escapes the marketplace/ },
    )

    assert.equal(await readFile(target, "utf8"), "synthetic protected content\n")
    assert.equal((await lstat(target)).mode & 0o777, 0o600)
    await assert.rejects(lstat(fixture.installed), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(fixture.seed, "managed-lock.json")), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(fixture.seed, ".finalize.lock")), { code: "ENOENT" })
  })

  for (const leakedPath of ["/src/finalize-copilot-seed.ts", "/src/finalize-copilot-seed.mjs"]) {
    it(`rejects build-only ${leakedPath} content instead of publishing it`, async () => {
      const fixture = await copilotFixture()
      await writeFile(path.join(fixture.sourcePlugin, "README.md"), `${leakedPath}\n`)

      await assert.rejects(
        runFinalizer(fixture.root, finalizers.copilot, [fixture.seed, "hve-core", "hve-core", "3.3.101"]),
        { code: 1, stderr: /temporary build root leaked in managed content/ },
      )

      await assert.rejects(lstat(path.join(fixture.seed, "managed-lock.json")), { code: "ENOENT" })
      await assert.rejects(lstat(path.join(fixture.seed, ".finalize.lock")), { code: "ENOENT" })
    })
  }

  it("rejects an unsupported Copilot source FIFO without publishing state", async () => {
    const fixture = await copilotFixture()
    await execFilePromise("mkfifo", [path.join(fixture.sourcePlugin, "unsupported-pipe")], {
      env: { PATH: "/usr/bin:/bin" },
    })

    await assert.rejects(
      runFinalizer(fixture.root, finalizers.copilot, [fixture.seed, "hve-core", "hve-core", "3.3.101"]),
      { code: 1, stderr: /live plugin source contains an unsupported path/ },
    )

    await assert.rejects(lstat(fixture.installed), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(fixture.seed, "managed-lock.json")), { code: "ENOENT" })
  })

  it("rejects an installed Copilot FIFO without waiting for a pipe writer or mutating settings", async () => {
    const fixture = await copilotFixture()
    await cp(fixture.sourcePlugin, fixture.installed, { recursive: true, dereference: true })
    const pipe = path.join(fixture.installed, "unsupported-pipe")
    await execFilePromise("mkfifo", [pipe], { env: { PATH: "/usr/bin:/bin" } })
    const settings = await readFile(path.join(fixture.seed, "settings.json"), "utf8")

    await assert.rejects(
      runFinalizer(fixture.root, finalizers.copilot, [fixture.seed, "hve-core", "hve-core", "3.3.101"], 4_000),
      { code: 1, stderr: /special file rejected/ },
    )

    assert.ok((await lstat(pipe)).isFIFO())
    assert.equal(await readFile(path.join(fixture.seed, "settings.json"), "utf8"), settings)
    await assert.rejects(lstat(path.join(fixture.seed, "managed-lock.json")), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(fixture.seed, ".finalize.lock")), { code: "ENOENT" })
  })

  it("rejects a Copilot generic-skill FIFO before canonicalizing it", async () => {
    const fixture = await copilotFixture()
    const pipe = path.join(fixture.seed, "skills", "synthetic", "unsupported-pipe")
    await execFilePromise("mkfifo", [pipe], { env: { PATH: "/usr/bin:/bin" } })

    await assert.rejects(
      runFinalizer(fixture.root, finalizers.copilot, [fixture.seed, "hve-core", "hve-core", "3.3.101"], 4_000),
      { code: 1, stderr: /unsupported generic skill entry/ },
    )

    assert.ok((await lstat(pipe)).isFIFO())
    await assert.rejects(lstat(path.join(fixture.seed, "managed-lock.json")), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(fixture.seed, ".finalize.lock")), { code: "ENOENT" })
  })

  it("rejects a Copilot source symlink to a FIFO before resolving its real path", async () => {
    const fixture = await copilotFixture()
    const pipe = path.join(fixture.source, "unsupported-pipe")
    await execFilePromise("mkfifo", [pipe], { env: { PATH: "/usr/bin:/bin" } })
    const link = path.join(fixture.sourcePlugin, "skills", "writer", "SKILL.md")
    await unlink(link)
    await symlink(pipe, link)

    await assert.rejects(
      runFinalizer(fixture.root, finalizers.copilot, [fixture.seed, "hve-core", "hve-core", "3.3.101"], 4_000),
      { code: 1, stderr: /live plugin symlink target must be a regular file or directory/ },
    )

    assert.ok((await lstat(pipe)).isFIFO())
    await assert.rejects(lstat(fixture.installed), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(fixture.seed, ".finalize.lock")), { code: "ENOENT" })
  })

  it("rejects a Claude plugin FIFO before resolving its real path", async () => {
    const fixture = await claudeFixture()
    const pipe = path.join(fixture.cache, "unsupported-pipe")
    await execFilePromise("mkfifo", [pipe], { env: { PATH: "/usr/bin:/bin" } })
    const settings = await readFile(path.join(fixture.seed, "settings.json"), "utf8")

    await assert.rejects(
      runFinalizer(fixture.root, finalizers.claude, [fixture.seed, fixture.manifest, "2.1.222"], 4_000),
      { code: 1, stderr: /unsupported plugin entry/ },
    )

    assert.ok((await lstat(pipe)).isFIFO())
    assert.equal(await readFile(path.join(fixture.seed, "settings.json"), "utf8"), settings)
    await assert.rejects(lstat(path.join(fixture.seed, "managed-paths.txt")), { code: "ENOENT" })
  })

  it("rejects a Claude cache symlink to a FIFO before resolving its real path", async () => {
    const fixture = await claudeFixture()
    const pipe = path.join(fixture.cache, "zz-unsupported-pipe")
    await execFilePromise("mkfifo", [pipe], { env: { PATH: "/usr/bin:/bin" } })
    const link = path.join(fixture.cache, "skills", "writer", "SKILL.md")
    await unlink(link)
    await symlink("../../zz-unsupported-pipe", link)

    await assert.rejects(
      runFinalizer(fixture.root, finalizers.claude, [fixture.seed, fixture.manifest, "2.1.222"], 4_000),
      { code: 1, stderr: /unsupported plugin symlink target/ },
    )

    assert.ok((await lstat(pipe)).isFIFO())
    assert.ok((await lstat(link)).isSymbolicLink())
    await assert.rejects(lstat(path.join(fixture.seed, "managed-paths.txt")), { code: "ENOENT" })
  })

  it("rejects a Claude cache root that is a FIFO", async () => {
    const fixture = await claudeFixture()
    await rm(fixture.cache, { recursive: true })
    await execFilePromise("mkfifo", [fixture.cache], { env: { PATH: "/usr/bin:/bin" } })

    await assert.rejects(
      runFinalizer(fixture.root, finalizers.claude, [fixture.seed, fixture.manifest, "2.1.222"], 4_000),
      { code: 1, stderr: /plugin root must be a directory/ },
    )

    assert.ok((await lstat(fixture.cache)).isFIFO())
    await assert.rejects(lstat(path.join(fixture.seed, "managed-paths.txt")), { code: "ENOENT" })
  })

  it("rejects a Copilot marketplace root that is a FIFO", async () => {
    const fixture = await copilotFixture()
    await rm(fixture.source, { recursive: true })
    await execFilePromise("mkfifo", [fixture.source], { env: { PATH: "/usr/bin:/bin" } })

    await assert.rejects(
      runFinalizer(fixture.root, finalizers.copilot, [fixture.seed, "hve-core", "hve-core", "3.3.101"], 4_000),
      { code: 1, stderr: /native marketplace path must be a directory/ },
    )

    assert.ok((await lstat(fixture.source)).isFIFO())
    await assert.rejects(lstat(path.join(fixture.seed, "managed-lock.json")), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(fixture.seed, ".finalize.lock")), { code: "ENOENT" })
  })

  it("rejects a Copilot marketplace manifest FIFO before reading from it", async () => {
    const fixture = await copilotFixture()
    const manifest = path.join(fixture.source, ".github", "plugin", "marketplace.json")
    await unlink(manifest)
    await execFilePromise("mkfifo", [manifest], { env: { PATH: "/usr/bin:/bin" } })

    await assert.rejects(
      runFinalizer(fixture.root, finalizers.copilot, [fixture.seed, "hve-core", "hve-core", "3.3.101"], 4_000),
      { code: 1, stderr: /native marketplace manifest must be a regular file/ },
    )

    assert.ok((await lstat(manifest)).isFIFO())
    await assert.rejects(lstat(fixture.installed), { code: "ENOENT" })
    await assert.rejects(lstat(path.join(fixture.seed, ".finalize.lock")), { code: "ENOENT" })
  })

  it("rejects an installed Copilot Unix socket with the special-file diagnostic", async () => {
    const fixture = await copilotFixture()
    await cp(fixture.sourcePlugin, fixture.installed, { recursive: true, dereference: true })
    const socket = path.join(fixture.installed, "unsupported-socket")

    await withUnixSocket(fixture.root, socket, async () => {
      await assert.rejects(
        runFinalizer(fixture.root, finalizers.copilot, [fixture.seed, "hve-core", "hve-core", "3.3.101"], 4_000),
        { code: 1, stderr: /special file rejected/ },
      )

      assert.ok((await lstat(socket)).isSocket())
      await assert.rejects(lstat(path.join(fixture.seed, "managed-lock.json")), { code: "ENOENT" })
      await assert.rejects(lstat(path.join(fixture.seed, ".finalize.lock")), { code: "ENOENT" })
    })
  })

  it("rejects a Claude cache Unix socket with the unsupported-entry diagnostic", async () => {
    const fixture = await claudeFixture()
    const socket = path.join(fixture.cache, "unsupported-socket")

    await withUnixSocket(fixture.root, socket, async () => {
      await assert.rejects(
        runFinalizer(fixture.root, finalizers.claude, [fixture.seed, fixture.manifest, "2.1.222"], 4_000),
        { code: 1, stderr: /unsupported plugin entry/ },
      )

      assert.ok((await lstat(socket)).isSocket())
      await assert.rejects(lstat(path.join(fixture.seed, "managed-paths.txt")), { code: "ENOENT" })
    })
  })

  for (const control of [0x00, 0x09, 0x0a, 0x0d, 0x1f, 0x7f]) {
    it(`rejects control character 0x${control.toString(16)} in the Copilot plugin root`, async () => {
      const fixture = await copilotFixture()
      await writeJson(path.join(fixture.source, ".github", "plugin", "marketplace.json"), {
        name: "hve-core",
        metadata: { pluginRoot: `./plugins${String.fromCharCode(control)}` },
        plugins: [{ name: "hve-core", source: "hve-core", version: "3.3.101" }],
      })

      await assert.rejects(
        runFinalizer(fixture.root, finalizers.copilot, [fixture.seed, "hve-core", "hve-core", "3.3.101"]),
        { code: 1, stderr: /native marketplace pluginRoot is unsafe/ },
      )

      await assert.rejects(lstat(path.join(fixture.seed, "managed-lock.json")), { code: "ENOENT" })
    })
  }

  it("rejects non-JSON whitespace without publishing a Copilot seed", async () => {
    const fixture = await copilotFixture()
    const manifest = path.join(fixture.source, ".github", "plugin", "marketplace.json")
    await writeFile(manifest, `\v${await readFile(manifest, "utf8")}`)

    await assert.rejects(
      runFinalizer(fixture.root, finalizers.copilot, [fixture.seed, "hve-core", "hve-core", "3.3.101"]),
      { code: 1, stderr: /native marketplace manifest is invalid/ },
    )

    await assert.rejects(lstat(path.join(fixture.seed, "managed-lock.json")), { code: "ENOENT" })
  })
})
