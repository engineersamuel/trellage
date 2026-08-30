import { createHash } from "node:crypto"
import { execFile, spawn } from "node:child_process"
import {
  chmod,
  cp,
  link,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { once } from "node:events"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import { CopilotPluginError, readCopilotMarketplace } from "../src/copilot-plugin.js"

const roots: Array<string> = []
const execFilePromise = promisify(execFile)
const finalizer = fileURLToPath(new URL("../../../prototypes/trellage/finalize-copilot-seed.mjs", import.meta.url))

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const marketplaceSource = async (source: string): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), "harness-copilot-plugin-"))
  roots.push(root)
  const directory = path.join(root, ".github", "plugin")
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "marketplace.json"), `${source}\n`)
  return root
}

const marketplace = (value: unknown): Promise<string> => marketplaceSource(JSON.stringify(value))

const valid = {
  name: "hve-core",
  metadata: { description: "HVE Core", version: "3.3.101", pluginRoot: "./plugins" },
  owner: { name: "Microsoft" },
  plugins: [
    {
      name: "hve-core",
      source: "hve-core",
      description: "HVE Core plugin",
      version: "3.3.101",
    },
  ],
}

const errorOf = (root: string, expected: string, selections: ReadonlyArray<string>) =>
  Effect.runPromise(Effect.flip(readCopilotMarketplace(root, expected, selections)))

describe("readCopilotMarketplace", () => {
  it("extracts exact selected HVE plugin versions", async () => {
    const root = await marketplace(valid)

    const versions = await Effect.runPromise(readCopilotMarketplace(root, "hve-core", ["hve-core"]))

    expect(versions).toEqual({ "hve-core": "3.3.101" })
    expect(Object.getPrototypeOf(versions)).toBeNull()
    expect(Object.isFrozen(versions)).toBe(true)
  })

  it("resolves hve-core 3.3.101 from the captured official marketplace", async () => {
    const official = await readFile(new URL("./fixtures/hve-core-marketplace-v3.3.101.json", import.meta.url), "utf8")
    const root = await marketplaceSource(official)

    await expect(Effect.runPromise(readCopilotMarketplace(root, "hve-core", ["hve-core"]))).resolves.toEqual({
      "hve-core": "3.3.101",
    })
  })

  it("pins machine-checkable provenance for the normalized official fixture", async () => {
    const fixtureUrl = new URL("./fixtures/hve-core-marketplace-v3.3.101.json", import.meta.url)
    const provenanceUrl = new URL("./fixtures/hve-core-marketplace-v3.3.101.provenance.json", import.meta.url)
    const fixture = await readFile(fixtureUrl)
    const provenance = JSON.parse(await readFile(provenanceUrl, "utf8")) as Record<string, unknown>
    const upstream = fixture.subarray(0, fixture.length - 1)
    const header = Buffer.from(`blob ${upstream.length}\0`)
    const gitBlobSha1 = createHash("sha1").update(header).update(upstream).digest("hex")

    expect(provenance).toEqual({
      repository: "https://github.com/microsoft/hve-core",
      commit: "130ab64338bb77e912e603693672c31f14bc60c6",
      path: ".github/plugin/marketplace.json",
      git_blob_sha1: "2aa7520b181c1d69792e01e2e00a03fa243fc6a4",
      upstream_bytes: 3228,
      fixture_bytes: 3229,
      normalization: "append exactly one trailing LF",
    })
    expect(fixture.at(-1)).toBe(0x0a)
    expect(fixture.at(-2)).not.toBe(0x0a)
    expect(upstream.length).toBe(provenance.upstream_bytes)
    expect(fixture.length).toBe(provenance.fixture_bytes)
    expect(gitBlobSha1).toBe(provenance.git_blob_sha1)
  })

  it("returns selected versions in deterministic name order", async () => {
    const root = await marketplace({
      ...valid,
      plugins: [
        { name: "zeta", source: "zeta", description: "Zeta", version: "2.0.0" },
        { name: "alpha", source: "alpha", description: "Alpha", version: "1.0.0" },
      ],
    })

    const versions = await Effect.runPromise(readCopilotMarketplace(root, "hve-core", ["zeta", "alpha"]))

    expect(Object.keys(versions)).toEqual(["alpha", "zeta"])
    expect(versions).toEqual({ alpha: "1.0.0", zeta: "2.0.0" })
  })

  it("rejects duplicate plugins before constructing a record", async () => {
    const root = await marketplace({
      ...valid,
      plugins: [valid.plugins[0], valid.plugins[0]],
    })

    const error = await errorOf(root, "hve-core", ["hve-core"])

    expect(error).toBeInstanceOf(CopilotPluginError)
    expect(error.message).toMatch(/duplicate plugin/)
  })

  it("rejects a missing selection", async () => {
    const root = await marketplace(valid)

    await expect(errorOf(root, "hve-core", ["missing"])).resolves.toMatchObject({
      message: expect.stringMatching(/selection/),
    })
  })

  it.each(["", ".", "..", "../hve-core", "plugins/hve-core", "plugins\\hve-core", "/hve-core", "C:\\hve-core"])(
    "rejects unsafe plugin source %j",
    async (source) => {
      const root = await marketplace({
        name: "hve-core",
        metadata: valid.metadata,
        owner: valid.owner,
        plugins: [{ name: "hve-core", source, description: "HVE Core plugin", version: "3.3.101" }],
      })

      await expect(errorOf(root, "hve-core", ["hve-core"])).resolves.toMatchObject({
        message: expect.stringMatching(/source/),
      })
    },
  )

  it("rejects a marketplace-name mismatch", async () => {
    const root = await marketplace(valid)

    await expect(errorOf(root, "other", ["hve-core"])).resolves.toMatchObject({
      message: expect.stringMatching(/marketplace name/),
    })
  })

  it.each(["", ".", "..", "../hve-core", "plugins/hve-core", "plugins\\hve-core", "/hve-core", "C:\\hve-core"])(
    "rejects unsafe matching marketplace identifier %j",
    async (name) => {
      const root = await marketplace({ ...valid, name })

      await expect(errorOf(root, name, ["hve-core"])).resolves.toMatchObject({
        message: expect.stringMatching(/marketplace name is unsafe/),
      })
    },
  )

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects dangerous matching marketplace identifier %j",
    async (name) => {
      const root = await marketplace({ ...valid, name })

      await expect(errorOf(root, name, ["hve-core"])).resolves.toMatchObject({
        message: expect.stringMatching(/marketplace name is unsafe/),
      })
    },
  )

  it("validates the expected marketplace identifier before comparing it", async () => {
    const root = await marketplace(valid)

    await expect(errorOf(root, "../hve-core", ["hve-core"])).resolves.toMatchObject({
      message: expect.stringMatching(/expected marketplace name is unsafe/),
    })
  })

  it.each(["__proto__", "constructor", "prototype", "toString"])("rejects dangerous plugin key %j", async (name) => {
    const root = await marketplace({
      ...valid,
      plugins: [{ name, source: "hve-core", description: "HVE Core plugin", version: "3.3.101" }],
    })

    await expect(errorOf(root, "hve-core", [name])).resolves.toMatchObject({
      message: expect.stringMatching(/plugin name/),
    })
  })

  it("rejects empty and duplicate selections", async () => {
    const root = await marketplace(valid)

    await expect(errorOf(root, "hve-core", [])).resolves.toMatchObject({ message: expect.stringMatching(/selection/) })
    await expect(errorOf(root, "hve-core", ["hve-core", "hve-core"])).resolves.toMatchObject({
      message: expect.stringMatching(/duplicate selection/),
    })
  })

  it.each(["", "latest", "^3.3.101", "3.x"])("rejects unpinned version %j", async (version) => {
    const root = await marketplace({
      ...valid,
      plugins: [{ name: "hve-core", source: "hve-core", description: "HVE Core plugin", version }],
    })

    await expect(errorOf(root, "hve-core", ["hve-core"])).resolves.toMatchObject({
      message: expect.stringMatching(/version/),
    })
  })

  it.each([
    { ...valid, extra: true },
    { ...valid, plugins: [{ ...valid.plugins[0], extra: true }] },
    { ...valid, metadata: { ...valid.metadata, extra: true } },
    { ...valid, owner: { ...valid.owner, extra: true } },
  ])("strictly rejects unknown marketplace fields", async (value) => {
    const root = await marketplace(value)

    await expect(errorOf(root, "hve-core", ["hve-core"])).resolves.toMatchObject({
      message: expect.stringMatching(/invalid/),
    })
  })

  it.each(["", ".", "..", "../plugins", "/plugins", "plugins\\nested", "C:\\plugins"])(
    "rejects unsafe pluginRoot %j",
    async (pluginRoot) => {
      const root = await marketplace({
        ...valid,
        metadata: { ...valid.metadata, pluginRoot },
      })

      await expect(errorOf(root, "hve-core", ["hve-core"])).resolves.toMatchObject({
        message: expect.stringMatching(/pluginRoot/),
      })
    },
  )

  it("accepts escaped quotes and backslashes in descriptive values", async () => {
    const root = await marketplace({
      ...valid,
      metadata: { ...valid.metadata, description: 'HVE "Core" \\ docs' },
      plugins: [{ ...valid.plugins[0], description: 'Plugin "description" \\ docs' }],
    })

    await expect(Effect.runPromise(readCopilotMarketplace(root, "hve-core", ["hve-core"]))).resolves.toEqual({
      "hve-core": "3.3.101",
    })
  })

  it.each([
    [
      "duplicate root key",
      '{"name":"hve-core","name":"hve-core","plugins":[{"name":"hve-core","source":"hve-core","version":"3.3.101"}]}',
    ],
    [
      "escaped-equivalent root key",
      '{"name":"hve-core","n\\u0061me":"hve-core","plugins":[{"name":"hve-core","source":"hve-core","version":"3.3.101"}]}',
    ],
    [
      "duplicate plugin name",
      '{"name":"hve-core","plugins":[{"name":"hve-core","name":"hve-core","source":"hve-core","version":"3.3.101"}]}',
    ],
    [
      "duplicate plugin source",
      '{"name":"hve-core","plugins":[{"name":"hve-core","source":"hve-core","source":"hve-core","version":"3.3.101"}]}',
    ],
    [
      "duplicate plugin version",
      '{"name":"hve-core","plugins":[{"name":"hve-core","source":"hve-core","version":"3.3.101","version":"3.3.101"}]}',
    ],
    [
      "escaped-equivalent plugin key",
      '{"name":"hve-core","plugins":[{"name":"hve-core","sour\\u0063e":"hve-core","source":"hve-core","version":"3.3.101"}]}',
    ],
  ])("rejects %s", async (_label, source) => {
    const root = await marketplaceSource(source)

    await expect(errorOf(root, "hve-core", ["hve-core"])).resolves.toMatchObject({
      message: expect.stringMatching(/duplicate JSON key/),
    })
  })

  it.each([
    String.raw`{"a\"b":1,"a\u0022b":2}`,
    String.raw`{"a\\b":1,"a\u005cb":2}`,
    String.raw`{"\uD83D\uDE00":1,"😀":2}`,
  ])("rejects decoded-equivalent escaped or surrogate keys in %s", async (source) => {
    const root = await marketplaceSource(source)

    await expect(errorOf(root, "hve-core", ["hve-core"])).resolves.toMatchObject({
      message: expect.stringMatching(/duplicate JSON key/),
    })
  })

  it("scans valid JSON number and literal grammar before detecting a later duplicate", async () => {
    const source = '{"scanner":[-1.2e+3,true,false,null],"scanner":[]}'
    const root = await marketplaceSource(source)

    await expect(errorOf(root, "hve-core", ["hve-core"])).resolves.toMatchObject({
      message: "duplicate JSON key",
    })
  })

  it.each(["[01]", "[1.]", "[truefalse]", "[--1]"])(
    "maps malformed number or literal grammar %j to CopilotPluginError",
    async (source) => {
      const root = await marketplaceSource(source)

      await expect(errorOf(root, "hve-core", ["hve-core"])).resolves.toBeInstanceOf(CopilotPluginError)
    },
  )

  it("rejects trailing JSON tokens through CopilotPluginError", async () => {
    const root = await marketplaceSource(`${JSON.stringify(valid)} true`)

    await expect(errorOf(root, "hve-core", ["hve-core"])).resolves.toBeInstanceOf(CopilotPluginError)
  })

  it("accepts JSON at the scanner size limit and rejects the next character", async () => {
    const serialized = JSON.stringify(valid)
    const atLimit = `${serialized}${" ".repeat(1_000_000 - serialized.length - 1)}`
    const acceptedRoot = await marketplaceSource(atLimit)
    const rejectedRoot = await marketplaceSource(`${atLimit} `)

    await expect(Effect.runPromise(readCopilotMarketplace(acceptedRoot, "hve-core", ["hve-core"]))).resolves.toEqual({
      "hve-core": "3.3.101",
    })
    await expect(errorOf(rejectedRoot, "hve-core", ["hve-core"])).resolves.toBeInstanceOf(CopilotPluginError)
  })

  it("scans JSON at the depth limit before detecting a later duplicate", async () => {
    const nested = `${"[".repeat(127)}${"]".repeat(127)}`
    const root = await marketplaceSource(`{"probe":${nested},"probe":null}`)

    await expect(errorOf(root, "hve-core", ["hve-core"])).resolves.toMatchObject({
      message: "duplicate JSON key",
    })
  })

  it("rejects JSON one level above the depth limit through CopilotPluginError", async () => {
    const nested = `${"[".repeat(128)}${"]".repeat(128)}`
    const root = await marketplaceSource(`{"probe":${nested},"probe":null}`)

    await expect(errorOf(root, "hve-core", ["hve-core"])).resolves.toMatchObject({
      message: expect.stringMatching(/invalid/),
    })
  })

  it("rejects very deep JSON without overflowing the stack", async () => {
    const root = await marketplaceSource(`${"[".repeat(10_000)}${"]".repeat(10_000)}`)

    await expect(errorOf(root, "hve-core", ["hve-core"])).resolves.toBeInstanceOf(CopilotPluginError)
  })

  it("maps malformed JSON scanner failures to CopilotPluginError", async () => {
    const root = await marketplaceSource('{"name":"hve-core","plugins":[}')

    const error = await errorOf(root, "hve-core", ["hve-core"])

    expect(error).toBeInstanceOf(CopilotPluginError)
    expect(error.message).toMatch(/invalid/)
  })
})

interface NativeSeed {
  readonly root: string
  readonly seed: string
  readonly installed: string
  readonly settings: Record<string, unknown>
}

const nativeManifest = (installed: string): string => path.join(installed, ".github", "plugin", "plugin.json")

const nativeSeed = async (): Promise<NativeSeed> => {
  const root = await mkdtemp(path.join(tmpdir(), "trellage-copilot-finalize-"))
  roots.push(root)
  const seed = path.join(root, "copilot-seed")
  const installed = path.join(seed, "installed-plugins", "hve-core", "hve-core")
  await mkdir(path.dirname(nativeManifest(installed)), { recursive: true })
  await mkdir(path.join(root, "hve-core"), { recursive: true })
  const source = await readFile(new URL("./fixtures/copilot-native-install/settings.json", import.meta.url), "utf8")
  const settings = JSON.parse(source.replace("__HVE_SOURCE__", path.join(root, "hve-core"))) as Record<string, unknown>
  await writeFile(path.join(seed, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`)
  await writeFile(path.join(seed, "config.json"), '{"auth":"must-be-removed"}\n')
  await writeFile(
    nativeManifest(installed),
    await readFile(
      new URL(
        "./fixtures/copilot-native-install/installed-plugins/hve-core/hve-core/.github/plugin/plugin.json",
        import.meta.url,
      ),
    ),
  )
  await writeFile(path.join(installed, "README.md"), "# HVE Core\n")
  return { root, seed, installed, settings }
}

const runFinalizer = (seed: string, ...args: ReadonlyArray<string>) =>
  execFilePromise(process.execPath, [finalizer, seed, "hve-core", "hve-core", "3.3.101", ...args])

const runFinalizerWithUmask = (seed: string) =>
  execFilePromise("/bin/sh", [
    "-c",
    'umask 077; exec "$@"',
    "finalize-copilot-seed",
    process.execPath,
    finalizer,
    seed,
    "hve-core",
    "hve-core",
    "3.3.101",
  ])

const exists = async (file: string): Promise<boolean> => {
  try {
    await lstat(file)
    return true
  } catch {
    return false
  }
}

interface SeedIdentity {
  readonly path: string
  readonly dev: string
  readonly ino: string
}

interface OwnedLockFixture {
  readonly publicPath: string
  readonly privatePath: string
  readonly record: Record<string, unknown>
}

const identityOf = async (directory: string): Promise<SeedIdentity> => {
  const status = await lstat(directory)
  return { path: await realpath(directory), dev: String(status.dev), ino: String(status.ino) }
}

const ownedLockPair = async (
  fixture: NativeSeed,
  kind: "main" | "recovery",
  pid = 99_999_999,
  nonce = `${kind}-dead-owner`,
): Promise<OwnedLockFixture> => {
  const prefix = kind === "main" ? ".copilot-finalize-lock-" : ".copilot-finalize-recovery-"
  const publicPath = path.join(fixture.seed, kind === "main" ? ".finalize.lock" : ".finalize.recovery")
  const privatePath = path.join(fixture.root, `${prefix}${nonce}`)
  const handle = await open(privatePath, "wx", 0o600)
  let record: Record<string, unknown>
  try {
    const privateStatus = await handle.stat()
    record = {
      schema: 1,
      kind,
      pid,
      nonce,
      seed: await identityOf(fixture.seed),
      private: {
        name: path.basename(privatePath),
        dev: String(privateStatus.dev),
        ino: String(privateStatus.ino),
      },
    }
    await handle.writeFile(`${JSON.stringify(record)}\n`)
  } finally {
    await handle.close()
  }
  await link(privatePath, publicPath)
  return { publicPath, privatePath, record }
}

const authenticatedStage = async (
  fixture: NativeSeed,
  phase: string,
  nonce = `stage-${phase}`,
  pid = 99_999_999,
): Promise<string> => {
  const stage = path.join(fixture.seed, `.finalize-stage-${nonce}`)
  await mkdir(stage, { mode: 0o700 })
  const stageStatus = await lstat(stage)
  await writeFile(
    path.join(stage, "state.json"),
    `${JSON.stringify({
      schema: 1,
      seed: await identityOf(fixture.seed),
      pid,
      nonce,
      stage: { dev: String(stageStatus.dev), ino: String(stageStatus.ino) },
      phase,
    })}\n`,
    { mode: 0o600 },
  )
  return stage
}

const authenticatedPrivateStage = async (
  fixture: NativeSeed,
  nonce: string,
  pid = 99_999_999,
  recordSeed?: SeedIdentity,
): Promise<string> => {
  const stage = path.join(fixture.root, `.copilot-finalize-stage-${nonce}`)
  await mkdir(stage, { mode: 0o700 })
  const stageStatus = await lstat(stage)
  await writeFile(
    path.join(stage, "state.json"),
    `${JSON.stringify({
      schema: 1,
      seed: recordSeed ?? (await identityOf(fixture.seed)),
      pid,
      nonce,
      stage: { dev: String(stageStatus.dev), ino: String(stageStatus.ino) },
      phase: "staged",
    })}\n`,
    { mode: 0o600 },
  )
  return stage
}

const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error("timed out waiting for child finalizer state")
}

interface SnapshotEntry {
  readonly path: string
  readonly type: "directory" | "file" | "symlink" | "special"
  readonly mode: number
  readonly content?: string
  readonly target?: string
}

const snapshotTree = async (root: string): Promise<ReadonlyArray<SnapshotEntry>> => {
  const result: Array<SnapshotEntry> = []
  const visit = async (directory: string) => {
    const names = (await readdir(directory)).sort()
    for (const name of names) {
      const absolute = path.join(directory, name)
      const relative = path.relative(root, absolute).split(path.sep).join("/")
      const status = await lstat(absolute)
      if (status.isSymbolicLink()) {
        result.push({ path: relative, type: "symlink", mode: status.mode & 0o777, target: await readlink(absolute) })
      } else if (status.isDirectory()) {
        result.push({ path: relative, type: "directory", mode: status.mode & 0o777 })
        await visit(absolute)
      } else if (status.isFile()) {
        result.push({
          path: relative,
          type: "file",
          mode: status.mode & 0o777,
          content: (await readFile(absolute)).toString("base64"),
        })
      } else {
        result.push({ path: relative, type: "special", mode: status.mode & 0o777 })
      }
    }
  }
  await visit(root)
  return result
}

const expectFinalSeed = async (seed: string): Promise<void> => {
  expect((await readdir(seed)).sort()).toEqual([
    "installed-plugins",
    "managed-files.txt",
    "managed-lock.json",
    "managed-settings.json",
    "managed.sha256",
  ])
}

describe("finalize-copilot-seed", () => {
  it("uses the captured authoritative HVE plugin manifest layout", async () => {
    const manifestUrl = new URL(
      "./fixtures/copilot-native-install/installed-plugins/hve-core/hve-core/.github/plugin/plugin.json",
      import.meta.url,
    )
    const fixture = await readFile(manifestUrl)
    const manifest = JSON.parse(fixture.toString("utf8"))
    const provenance = JSON.parse(
      await readFile(
        new URL("./fixtures/copilot-native-install/plugin-manifest.provenance.json", import.meta.url),
        "utf8",
      ),
    )
    const upstream = fixture.subarray(0, fixture.length - 1)
    const header = Buffer.from(`blob ${upstream.length}\0`)
    const gitBlobSha1 = createHash("sha1").update(header).update(upstream).digest("hex")

    expect(manifest).toMatchObject({ name: "hve-core", version: "3.3.101" })
    expect(provenance).toEqual({
      repository: "https://github.com/microsoft/hve-core",
      commit: "130ab64338bb77e912e603693672c31f14bc60c6",
      path: "plugins/hve-core/.github/plugin/plugin.json",
      git_blob_sha1: "628cd9c935109142c915ec9d22cf82631d5f337d",
      upstream_bytes: 552,
      fixture_bytes: 553,
      normalization: "append exactly one trailing LF",
      version: "3.3.101",
    })
    expect(fixture.at(-1)).toBe(0x0a)
    expect(fixture.at(-2)).not.toBe(0x0a)
    expect(upstream.length).toBe(provenance.upstream_bytes)
    expect(fixture.length).toBe(provenance.fixture_bytes)
    expect(gitBlobSha1).toBe(provenance.git_blob_sha1)
  })

  it("rewrites only managed settings and produces deterministic inventories, hashes, and lock marker", async () => {
    const left = await nativeSeed()
    const right = await nativeSeed()
    await Promise.all([
      chmod(left.installed, 0o700),
      chmod(right.installed, 0o700),
      chmod(path.join(left.installed, "README.md"), 0o600),
      chmod(path.join(right.installed, "README.md"), 0o600),
    ])

    await runFinalizer(left.seed)
    await runFinalizer(right.seed)

    const outputs = ["managed-settings.json", "managed-files.txt", "managed.sha256", "managed-lock.json"]
    for (const output of outputs) {
      expect(await readFile(path.join(left.seed, output), "utf8")).toBe(
        await readFile(path.join(right.seed, output), "utf8"),
      )
    }
    expect(JSON.parse(await readFile(path.join(left.seed, "managed-settings.json"), "utf8"))).toEqual({
      extraKnownMarketplaces: {
        "hve-core": { source: { source: "github", repo: "microsoft/hve-core" } },
      },
      enabledPlugins: { "hve-core@hve-core": true },
    })
    expect(await readFile(path.join(left.seed, "managed-files.txt"), "utf8")).toBe(
      [
        "installed-plugins/hve-core/hve-core/.github/plugin/plugin.json",
        "installed-plugins/hve-core/hve-core/README.md",
        "managed-lock.json",
        "managed-settings.json",
        "",
      ].join("\n"),
    )
    expect(await readFile(path.join(left.seed, "managed.sha256"), "utf8")).toMatch(/^(?:[0-9a-f]{64}  [^\n]+\n)+$/)
    const readmeHash = createHash("sha256").update("# HVE Core\n").digest("hex")
    const manifestHash = createHash("sha256")
      .update(await readFile(nativeManifest(left.installed)))
      .digest("hex")
    expect(JSON.parse(await readFile(path.join(left.seed, "managed-lock.json"), "utf8"))).toEqual({
      schema: 1,
      marketplace: "hve-core",
      plugin: "hve-core",
      version: "3.3.101",
      files: [
        {
          path: "installed-plugins/hve-core/hve-core",
          kind: "directory",
          mode: "0700",
        },
        {
          path: "installed-plugins/hve-core/hve-core/.github",
          kind: "directory",
          mode: "0755",
        },
        {
          path: "installed-plugins/hve-core/hve-core/.github/plugin",
          kind: "directory",
          mode: "0755",
        },
        {
          path: "installed-plugins/hve-core/hve-core/.github/plugin/plugin.json",
          kind: "file",
          mode: "0644",
          sha256: manifestHash,
        },
        {
          path: "installed-plugins/hve-core/hve-core/README.md",
          kind: "file",
          mode: "0600",
          sha256: readmeHash,
        },
      ],
    })
    await expect(exists(path.join(left.seed, "settings.json"))).resolves.toBe(false)
    await expect(exists(path.join(left.seed, "config.json"))).resolves.toBe(false)
    expect((await stat(left.installed)).mode & 0o777).toBe(0o700)
    expect((await stat(path.join(left.installed, "README.md"))).mode & 0o777).toBe(0o600)
    expect((await stat(path.join(left.seed, "managed-lock.json"))).mode & 0o777).toBe(0o644)
    await expectFinalSeed(left.seed)
  })

  it("retains generic skills and managed global instructions in the finalized seed", async () => {
    const fixture = await nativeSeed()
    await mkdir(path.join(fixture.seed, "skills", "caveman"), { recursive: true })
    await writeFile(path.join(fixture.seed, "skills", "caveman", "SKILL.md"), "ACTIVE EVERY RESPONSE\n")
    await writeFile(path.join(fixture.seed, "copilot-instructions.md"), "ACTIVE EVERY RESPONSE\n")

    await runFinalizer(fixture.seed)

    const managed = await readFile(path.join(fixture.seed, "managed-files.txt"), "utf8")
    expect(managed).toContain("skills/caveman/SKILL.md\n")
    expect(managed).toContain("copilot-instructions.md\n")
    await expect(readFile(path.join(fixture.seed, "skills", "caveman", "SKILL.md"), "utf8")).resolves.toBe(
      "ACTIVE EVERY RESPONSE\n",
    )
    await expect(readFile(path.join(fixture.seed, "copilot-instructions.md"), "utf8")).resolves.toBe(
      "ACTIVE EVERY RESPONSE\n",
    )
  })

  it("records every plugin file and directory with its observed mode without mutating the tree", async () => {
    const restrictive = await nativeSeed()
    const permissive = await nativeSeed()
    const restrictiveModes = [
      [restrictive.installed, 0o700],
      [path.join(restrictive.installed, ".github"), 0o710],
      [path.join(restrictive.installed, ".github", "plugin"), 0o750],
      [nativeManifest(restrictive.installed), 0o600],
      [path.join(restrictive.installed, "README.md"), 0o640],
    ] as const
    const permissiveModes = [
      [permissive.installed, 0o755],
      [path.join(permissive.installed, ".github"), 0o755],
      [path.join(permissive.installed, ".github", "plugin"), 0o755],
      [nativeManifest(permissive.installed), 0o644],
      [path.join(permissive.installed, "README.md"), 0o644],
    ] as const
    await Promise.all([...restrictiveModes, ...permissiveModes].map(([entry, mode]) => chmod(entry, mode)))
    const before = await snapshotTree(restrictive.installed)

    await runFinalizer(restrictive.seed)
    await runFinalizer(permissive.seed)

    expect(await snapshotTree(restrictive.installed)).toEqual(before)
    const marker = JSON.parse(await readFile(path.join(restrictive.seed, "managed-lock.json"), "utf8")) as {
      files: ReadonlyArray<Record<string, unknown>>
    }
    expect(marker.files).toEqual([
      { kind: "directory", path: "installed-plugins/hve-core/hve-core", mode: "0700" },
      { kind: "directory", path: "installed-plugins/hve-core/hve-core/.github", mode: "0710" },
      { kind: "directory", path: "installed-plugins/hve-core/hve-core/.github/plugin", mode: "0750" },
      {
        kind: "file",
        path: "installed-plugins/hve-core/hve-core/.github/plugin/plugin.json",
        mode: "0600",
        sha256: createHash("sha256")
          .update(await readFile(nativeManifest(restrictive.installed)))
          .digest("hex"),
      },
      {
        kind: "file",
        path: "installed-plugins/hve-core/hve-core/README.md",
        mode: "0640",
        sha256: createHash("sha256").update("# HVE Core\n").digest("hex"),
      },
    ])
    const represented = marker.files.map((entry) => entry.path)
    expect(represented).toEqual([
      "installed-plugins/hve-core/hve-core",
      ...before.map((entry) => `installed-plugins/hve-core/hve-core/${entry.path}`),
    ])
    expect(await readFile(path.join(restrictive.seed, "managed-lock.json"), "utf8")).not.toBe(
      await readFile(path.join(permissive.seed, "managed-lock.json"), "utf8"),
    )
  })

  it.each([
    [
      "setuid file",
      (fixture: NativeSeed) => path.join(fixture.installed, "README.md"),
      0o4755,
      /managed file has special permission bits/,
    ],
    [
      "setgid directory",
      (fixture: NativeSeed) => fixture.installed,
      0o2750,
      /managed directory has special permission bits/,
    ],
    [
      "sticky directory",
      (fixture: NativeSeed) => path.join(fixture.installed, ".github"),
      0o1750,
      /managed directory has special permission bits/,
    ],
  ])("rejects a %s without mutating the seed", async (_label, selectedPath, mode, expected) => {
    const fixture = await nativeSeed()
    await chmod(selectedPath(fixture), mode)
    const before = await snapshotTree(fixture.seed)

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(expected)

    expect(await snapshotTree(fixture.seed)).toEqual(before)
  })

  it("is byte-identical when rerun on the same finalized seed", async () => {
    const fixture = await nativeSeed()
    await runFinalizer(fixture.seed)
    const before = await snapshotTree(fixture.seed)

    await runFinalizer(fixture.seed)

    expect(await snapshotTree(fixture.seed)).toEqual(before)
  })

  it("leaves the complete seed byte-identical when config.json is not a regular file", async () => {
    const fixture = await nativeSeed()
    await rm(path.join(fixture.seed, "config.json"))
    await mkdir(path.join(fixture.seed, "config.json"))
    await writeFile(path.join(fixture.seed, "config.json", "nested"), "preserve me\n")
    for (const output of ["managed-settings.json", "managed-files.txt", "managed.sha256", "managed-lock.json"]) {
      await writeFile(path.join(fixture.seed, output), `existing ${output}\n`, { mode: 0o640 })
    }
    const before = await snapshotTree(fixture.seed)

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/config\.json must be a regular file/)

    expect(await snapshotTree(fixture.seed)).toEqual(before)
  })

  it("does not mutate plugin modes when installed version validation fails", async () => {
    const fixture = await nativeSeed()
    await chmod(fixture.installed, 0o700)
    await chmod(path.join(fixture.installed, "README.md"), 0o600)
    await chmod(nativeManifest(fixture.installed), 0o600)
    await writeFile(nativeManifest(fixture.installed), '{"name":"hve-core","version":"0.0.0"}\n', { mode: 0o600 })
    const before = await snapshotTree(fixture.installed)

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/installed plugin version mismatch/)

    expect(await snapshotTree(fixture.installed)).toEqual(before)
  })

  it("publishes all managed outputs as 0644 under umask 077", async () => {
    const fixture = await nativeSeed()

    await runFinalizerWithUmask(fixture.seed)

    for (const output of ["managed-settings.json", "managed-files.txt", "managed.sha256", "managed-lock.json"]) {
      expect((await stat(path.join(fixture.seed, output))).mode & 0o777).toBe(0o644)
    }
  })

  it("rejects a non-local marketplace source", async () => {
    const fixture = await nativeSeed()
    const settings = fixture.settings as { extraKnownMarketplaces: Record<string, { source: { source: string } }> }
    settings.extraKnownMarketplaces["hve-core"]!.source.source = "github"
    await writeFile(path.join(fixture.seed, "settings.json"), JSON.stringify(settings))

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/native marketplace source is not local/)
  })

  it("rejects a local marketplace source that is not a directory", async () => {
    const fixture = await nativeSeed()
    const sourceFile = path.join(fixture.root, "hve-core")
    await rm(sourceFile, { recursive: true })
    await writeFile(sourceFile, "not a checkout\n")
    const settings = fixture.settings as { extraKnownMarketplaces: Record<string, { source: { path: string } }> }
    settings.extraKnownMarketplaces["hve-core"]!.source.path = sourceFile
    await writeFile(path.join(fixture.seed, "settings.json"), JSON.stringify(settings))

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/native marketplace path must be a directory/)
  })

  it("rejects an alternate in-build-root marketplace directory", async () => {
    const fixture = await nativeSeed()
    const alternate = path.join(fixture.root, "alternate-hve")
    await mkdir(alternate)
    const settings = fixture.settings as { extraKnownMarketplaces: Record<string, { source: { path: string } }> }
    settings.extraKnownMarketplaces["hve-core"]!.source.path = alternate
    await writeFile(path.join(fixture.seed, "settings.json"), JSON.stringify(settings))

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(
      /marketplace directory must equal materialized hve-core source/,
    )
  })

  it("rejects an additional recognized plugin manifest", async () => {
    const fixture = await nativeSeed()
    await writeFile(path.join(fixture.installed, "plugin.json"), '{"name":"hve-core","version":"0.0.0"}\n')

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/ambiguous plugin manifest/)
  })

  it("requires the authoritative manifest name", async () => {
    const fixture = await nativeSeed()
    await writeFile(nativeManifest(fixture.installed), '{"version":"3.3.101"}\n')

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/installed plugin name mismatch/)
  })

  it("rejects a disabled native plugin", async () => {
    const fixture = await nativeSeed()
    const settings = fixture.settings as { enabledPlugins: Record<string, boolean> }
    settings.enabledPlugins["hve-core@hve-core"] = false
    await writeFile(path.join(fixture.seed, "settings.json"), JSON.stringify(settings))

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/native plugin is not enabled/)
  })

  it("rejects an installed plugin version that differs from the lock", async () => {
    const fixture = await nativeSeed()
    await writeFile(nativeManifest(fixture.installed), '{"name":"hve-core","version":"3.3.100"}\n')

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/installed plugin version mismatch/)
  })

  it("rejects symlinks in the installed plugin", async () => {
    const fixture = await nativeSeed()
    await symlink("README.md", path.join(fixture.installed, "current.md"))

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/symlink rejected/)
  })

  it("rejects special files in the installed plugin", async () => {
    const fixture = await nativeSeed()
    await execFilePromise("mkfifo", [path.join(fixture.installed, "pipe")])

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/special file rejected/)
  })

  it("rejects temporary build-root strings in managed content", async () => {
    const fixture = await nativeSeed()
    await writeFile(path.join(fixture.installed, "leak.txt"), `source=${fixture.root}/hve-core\n`)

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/temporary build root leaked/)
  })

  it("retains generic /src documentation while rejecting exact materialized paths", async () => {
    const fixture = await nativeSeed()
    const reference = path.join(fixture.installed, "REFERENCE.md")
    await writeFile(
      reference,
      [
        "diff --git a/src/middleware/auth.ts b/src/middleware/auth.ts",
        "--- a/src/middleware/auth.ts",
        "+++ b/src/middleware/auth.ts",
        "generic container example: /src/middleware/auth.ts",
        `generic mounted-tree example: ${fixture.root}/middleware/auth.ts`,
        "",
      ].join("\n"),
    )

    await runFinalizer(fixture.seed)

    await expect(readFile(reference, "utf8")).resolves.toContain("/src/middleware/auth.ts")
    await expect(readFile(path.join(fixture.seed, "managed-files.txt"), "utf8")).resolves.toContain(
      "installed-plugins/hve-core/hve-core/REFERENCE.md",
    )
  })

  it.each(["/src/finalize-copilot-seed.mjs", "/src/build-support", "/src/oci"])(
    "rejects known build-only path %s",
    async (buildPath) => {
      const fixture = await nativeSeed()
      await writeFile(path.join(fixture.installed, "build-path-leak.txt"), `build=${buildPath}\n`)

      await expect(runFinalizer(fixture.seed)).rejects.toThrow(/temporary build root leaked/)
    },
  )

  it("rejects the exact materialized Copilot seed path in managed content", async () => {
    const fixture = await nativeSeed()
    await writeFile(path.join(fixture.installed, "seed-leak.txt"), `seed=${fixture.seed}\n`)

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/temporary build root leaked/)
  })

  it("rejects a top-level build log containing the temporary build root", async () => {
    const fixture = await nativeSeed()
    await writeFile(path.join(fixture.seed, "install.log"), `root=${fixture.root}\n`)

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/unexpected seed path: install\.log/)
  })

  it("rejects a benign unmanaged top-level file", async () => {
    const fixture = await nativeSeed()
    await writeFile(path.join(fixture.seed, "notes.txt"), "benign\n")

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/unexpected seed path: notes\.txt/)
  })

  it("removes Copilot's empty plugin-operation lock before finalizing the seed", async () => {
    const fixture = await nativeSeed()
    const pluginLock = path.join(fixture.seed, "installed-plugins.lock")
    await writeFile(pluginLock, "")

    await runFinalizer(fixture.seed)

    await expect(exists(pluginLock)).resolves.toBe(false)
    await expectFinalSeed(fixture.seed)
  })

  it("materializes a Copilot live-loaded local plugin into the immutable seed", async () => {
    const fixture = await nativeSeed()
    const sourcePlugin = path.join(fixture.root, "hve-core", "plugins", "hve-core")
    await mkdir(path.dirname(sourcePlugin), { recursive: true })
    await cp(fixture.installed, sourcePlugin, { recursive: true })
    await writeFile(path.join(fixture.root, "hve-core", "shared.md"), "shared target\n")
    await symlink("../../shared.md", path.join(sourcePlugin, "linked.md"))
    await rm(path.join(fixture.seed, "installed-plugins"), { recursive: true })
    await writeFile(path.join(fixture.seed, "installed-plugins.lock"), "")

    await runFinalizer(fixture.seed)

    await expect(readFile(nativeManifest(fixture.installed), "utf8")).resolves.toContain('"version": "3.3.101"')
    await expect(readFile(path.join(fixture.installed, "README.md"), "utf8")).resolves.toBe("# HVE Core\n")
    await expect(readFile(path.join(fixture.installed, "linked.md"), "utf8")).resolves.toBe("shared target\n")
    expect((await lstat(path.join(fixture.installed, "linked.md"))).isSymbolicLink()).toBe(false)
    await expectFinalSeed(fixture.seed)
  })

  it("rejects a live plugin symlink that escapes the locked marketplace", async () => {
    const fixture = await nativeSeed()
    const sourcePlugin = path.join(fixture.root, "hve-core", "plugins", "hve-core")
    await mkdir(path.dirname(sourcePlugin), { recursive: true })
    await cp(fixture.installed, sourcePlugin, { recursive: true })
    await writeFile(path.join(fixture.root, "outside.txt"), "builder secret\n")
    await symlink("../../../outside.txt", path.join(sourcePlugin, "escaped.txt"))
    await rm(path.join(fixture.seed, "installed-plugins"), { recursive: true })
    await writeFile(path.join(fixture.seed, "installed-plugins.lock"), "")

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/live plugin symlink target escapes the marketplace/u)
  })

  it("rejects a nonempty Copilot plugin-operation lock", async () => {
    const fixture = await nativeSeed()
    await writeFile(path.join(fixture.seed, "installed-plugins.lock"), "unexpected\n")

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/installed-plugins\.lock must be an empty regular file/)
  })

  it("rejects control characters in managed paths", async () => {
    const fixture = await nativeSeed()
    await writeFile(path.join(fixture.installed, "bad\nname.txt"), "ambiguous\n")

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/control character in managed path/)
  })

  it("rejects multiply-linked managed files", async () => {
    const fixture = await nativeSeed()
    const external = path.join(fixture.root, "external.txt")
    await writeFile(external, "shared inode\n")
    await link(external, path.join(fixture.installed, "hardlink.txt"))

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/managed file must have exactly one link/)
  })

  it("serializes concurrent finalizers and converges on one deterministic seed", async () => {
    const fixture = await nativeSeed()

    await Promise.all(Array.from({ length: 4 }, () => runFinalizer(fixture.seed)))

    await expectFinalSeed(fixture.seed)
    await runFinalizer(fixture.seed)
    await expectFinalSeed(fixture.seed)
  })

  it("retries when a lock owner releases between open and validation", async () => {
    const fixture = await nativeSeed()
    const owned = await ownedLockPair(fixture, "main", process.pid, "release-turnover")
    const marker = path.join(fixture.root, "release-turnover-observed")
    const preload = path.join(fixture.root, "release-turnover-preload.mjs")
    const publicPath = await realpath(owned.publicPath)
    const privatePath = await realpath(owned.privatePath)
    await writeFile(
      preload,
      `
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"

const originalOpen = fsPromises.open
let released = false
fsPromises.open = async (file, ...args) => {
  const handle = await originalOpen(file, ...args)
  if (!released && String(file) === process.env.TRELLAGE_TEST_RELEASE_PUBLIC) {
    released = true
    await fsPromises.rm(process.env.TRELLAGE_TEST_RELEASE_PUBLIC, { force: true })
    await fsPromises.rm(process.env.TRELLAGE_TEST_RELEASE_PRIVATE, { force: true })
    fs.writeFileSync(process.env.TRELLAGE_TEST_RELEASE_MARKER, "released\\n")
  }
  return handle
}
syncBuiltinESMExports()
`,
    )

    await expect(
      execFilePromise(
        process.execPath,
        ["--import", preload, finalizer, fixture.seed, "hve-core", "hve-core", "3.3.101"],
        {
          env: {
            ...process.env,
            TRELLAGE_TEST_RELEASE_PUBLIC: publicPath,
            TRELLAGE_TEST_RELEASE_PRIVATE: privatePath,
            TRELLAGE_TEST_RELEASE_MARKER: marker,
          },
        },
      ),
    ).resolves.toBeDefined()

    await expect(readFile(marker, "utf8")).resolves.toBe("released\n")
    await expectFinalSeed(fixture.seed)
    await expect(exists(owned.publicPath)).resolves.toBe(false)
    await expect(exists(owned.privatePath)).resolves.toBe(false)
  })

  it("recovers an authenticated dead finalization lock and removes its private hard link", async () => {
    const fixture = await nativeSeed()
    const stale = await ownedLockPair(fixture, "main")

    await runFinalizer(fixture.seed)

    await expectFinalSeed(fixture.seed)
    await expect(exists(stale.privatePath)).resolves.toBe(false)
  })

  it("recovers an authenticated stale recovery mutex", async () => {
    const fixture = await nativeSeed()
    const stale = await ownedLockPair(fixture, "recovery")

    await runFinalizer(fixture.seed)

    await expectFinalSeed(fixture.seed)
    await expect(exists(stale.privatePath)).resolves.toBe(false)
  })

  it("waits for a live recovery owner and proceeds after that owner dies", async () => {
    const fixture = await nativeSeed()
    const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    const live = await ownedLockPair(fixture, "recovery", owner.pid!)
    const running = runFinalizer(fixture.seed)
    await new Promise((resolve) => setTimeout(resolve, 100))

    await expect(exists(live.publicPath)).resolves.toBe(true)
    owner.kill("SIGKILL")
    await once(owner, "exit")
    await running

    await expectFinalSeed(fixture.seed)
    await expect(exists(live.privatePath)).resolves.toBe(false)
  })

  it("fails fast without deleting a malformed recovery mutex", async () => {
    const fixture = await nativeSeed()
    const recovery = path.join(fixture.seed, ".finalize.recovery")
    await writeFile(recovery, "not-json\n")
    const started = Date.now()

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/invalid recovery lock/)

    expect(Date.now() - started).toBeLessThan(1_000)
    await expect(readFile(recovery, "utf8")).resolves.toBe("not-json\n")
  })

  it("fails closed and leaves hostile prefixed stages untouched", async () => {
    const fixture = await nativeSeed()
    const hostile = path.join(fixture.seed, ".finalize-stage-hostile")
    await mkdir(hostile)
    await writeFile(path.join(hostile, "precious"), "do not delete\n")

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/invalid finalization stage/)

    await expect(readFile(path.join(hostile, "precious"), "utf8")).resolves.toBe("do not delete\n")
  })

  it("leaves authenticated live and foreign-seed stages untouched", async () => {
    const liveFixture = await nativeSeed()
    const foreignFixture = await nativeSeed()
    const live = await authenticatedStage(liveFixture, "staged", "live-stage", process.pid)
    const foreign = await authenticatedStage(foreignFixture, "staged", "foreign-stage")
    const statePath = path.join(foreign, "state.json")
    const state = JSON.parse(await readFile(statePath, "utf8")) as { seed: SeedIdentity }
    state.seed = await identityOf(liveFixture.seed)
    await writeFile(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 })

    await expect(runFinalizer(liveFixture.seed)).rejects.toThrow(/live finalization stage/)
    await expect(runFinalizer(foreignFixture.seed)).rejects.toThrow(/invalid finalization stage/)

    await expect(exists(live)).resolves.toBe(true)
    await expect(exists(foreign)).resolves.toBe(true)
  })

  it("fails closed without deleting a malformed main lock", async () => {
    const fixture = await nativeSeed()
    const lock = path.join(fixture.seed, ".finalize.lock")
    await writeFile(lock, "not-json\n")

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/invalid main lock/)

    await expect(readFile(lock, "utf8")).resolves.toBe("not-json\n")
  })

  it("never deletes an unrelated private path named by a forged main lock", async () => {
    const fixture = await nativeSeed()
    const owned = await ownedLockPair(fixture, "main", 99_999_999, "forged")
    const precious = path.join(fixture.root, ".copilot-finalize-lock-precious")
    await writeFile(precious, "unrelated\n")
    const forged = {
      ...owned.record,
      nonce: "precious",
      private: {
        name: path.basename(precious),
        dev: (owned.record.private as { dev: string }).dev,
        ino: (owned.record.private as { ino: string }).ino,
      },
    }
    await writeFile(owned.publicPath, `${JSON.stringify(forged)}\n`)

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/invalid main lock/)

    await expect(readFile(precious, "utf8")).resolves.toBe("unrelated\n")
  })

  it("cleans authenticated dead orphan private links without deleting unrelated lookalikes", async () => {
    const fixture = await nativeSeed()
    const main = await ownedLockPair(fixture, "main", 99_999_999, "orphan-main")
    await rm(main.publicPath)
    const recovery = await ownedLockPair(fixture, "recovery", 99_999_999, "orphan-recovery")
    await rm(recovery.publicPath)
    const unrelated = path.join(fixture.root, ".copilot-finalize-lock-unrelated")
    await writeFile(unrelated, "precious\n")

    await runFinalizer(fixture.seed)

    await expect(exists(main.privatePath)).resolves.toBe(false)
    await expect(exists(recovery.privatePath)).resolves.toBe(false)
    await expect(readFile(unrelated, "utf8")).resolves.toBe("precious\n")
  })

  it("removes only authenticated dead orphan private stages for the exact seed and inode", async () => {
    const fixture = await nativeSeed()
    const foreignFixture = await nativeSeed()
    const dead = await authenticatedPrivateStage(fixture, "dead-private-stage")
    const live = await authenticatedPrivateStage(fixture, "live-private-stage", process.pid)
    const foreign = await authenticatedPrivateStage(
      fixture,
      "foreign-private-stage",
      99_999_999,
      await identityOf(foreignFixture.seed),
    )
    const wrongInode = await authenticatedPrivateStage(fixture, "wrong-inode-stage")
    const wrongStatePath = path.join(wrongInode, "state.json")
    const wrongState = JSON.parse(await readFile(wrongStatePath, "utf8")) as { stage: { ino: string } }
    wrongState.stage.ino = "0"
    await writeFile(wrongStatePath, `${JSON.stringify(wrongState)}\n`)
    const malformed = path.join(fixture.root, ".copilot-finalize-stage-malformed")
    await mkdir(malformed)
    await writeFile(path.join(malformed, "precious"), "preserve\n")
    const unrelated = path.join(fixture.root, ".copilot-finalize-stage-unrelated")
    await writeFile(unrelated, "preserve\n")

    await runFinalizer(fixture.seed)

    await expect(exists(dead)).resolves.toBe(false)
    for (const preserved of [live, foreign, wrongInode, malformed, unrelated]) {
      await expect(exists(preserved)).resolves.toBe(true)
    }
    await expect(readFile(path.join(malformed, "precious"), "utf8")).resolves.toBe("preserve\n")
  })

  it("recovers a real SIGKILL after authenticated private-stage publication before public rename", async () => {
    const fixture = await nativeSeed()
    const child = spawn(process.execPath, [finalizer, fixture.seed, "hve-core", "hve-core", "3.3.101"], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        TRELLAGE_TEST_FINALIZER_STOP_AFTER_PRIVATE_STAGE: "1",
      },
      stdio: "ignore",
    })
    let privateName: string | undefined
    await waitFor(async () => {
      privateName = (await readdir(fixture.root)).find((name) => name.startsWith(".copilot-finalize-stage-"))
      return privateName !== undefined && (await exists(path.join(fixture.root, privateName!, "state.json")))
    }, 1_000)
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited

    await runFinalizer(fixture.seed)

    await expectFinalSeed(fixture.seed)
    await expect(exists(path.join(fixture.root, privateName!))).resolves.toBe(false)
    expect((await readdir(fixture.root)).filter((name) => name.startsWith(".copilot-finalize-"))).toEqual([])
  })

  it("rescans private stages after a waiter recovers a main lock from a stopped owner", async () => {
    const fixture = await nativeSeed()
    const owner = spawn(process.execPath, [finalizer, fixture.seed, "hve-core", "hve-core", "3.3.101"], {
      env: {
        ...process.env,
        NODE_ENV: "test",
        TRELLAGE_TEST_FINALIZER_STOP_AFTER_PRIVATE_STAGE: "1",
      },
      stdio: "ignore",
    })
    await waitFor(async () => {
      const privateStage = (await readdir(fixture.root)).find((name) => name.startsWith(".copilot-finalize-stage-"))
      return privateStage !== undefined && (await exists(path.join(fixture.root, privateStage, "state.json")))
    }, 1_000)
    const waiter = spawn(process.execPath, [finalizer, fixture.seed, "hve-core", "hve-core", "3.3.101"], {
      stdio: "ignore",
    })
    const ownerExited = once(owner, "exit")
    const waiterExited = once(waiter, "exit")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(waiter.exitCode).toBeNull()

    owner.kill("SIGKILL")
    await ownerExited
    const [waiterCode, waiterSignal] = await waiterExited

    expect(waiterCode).toBe(0)
    expect(waiterSignal).toBeNull()
    await expectFinalSeed(fixture.seed)
    expect((await readdir(fixture.root)).filter((name) => name.startsWith(".copilot-finalize-"))).toEqual([])
  })

  it("recovers a real SIGKILL after main-lock publication and cleans its private hard link", async () => {
    const fixture = await nativeSeed()
    await writeFile(path.join(fixture.installed, "slow.bin"), Buffer.alloc(64 * 1024 * 1024, 0x61))
    const child = spawn(process.execPath, [finalizer, fixture.seed, "hve-core", "hve-core", "3.3.101"], {
      stdio: "ignore",
    })
    await waitFor(async () => exists(path.join(fixture.seed, ".finalize.lock")))
    const privateName = (await readdir(fixture.root)).find((name) => name.startsWith(".copilot-finalize-lock-"))
    expect(privateName).toBeDefined()
    child.kill("SIGKILL")
    await once(child, "exit")

    await runFinalizer(fixture.seed)

    await expectFinalSeed(fixture.seed)
    await expect(exists(path.join(fixture.root, privateName!))).resolves.toBe(false)
  })

  it.each([
    "staged",
    "published-settings",
    "published-files",
    "published-hashes",
    "published-marker",
    "removed-settings",
    "removed-config",
  ])("recovers an authenticated dead finalization stage after %s", async (phase) => {
    const fixture = await nativeSeed()
    const settings = await readFile(path.join(fixture.seed, "settings.json"))
    const config = await readFile(path.join(fixture.seed, "config.json"))
    if (["published-marker", "removed-settings", "removed-config"].includes(phase)) {
      await runFinalizer(fixture.seed)
      if (phase === "published-marker") {
        await writeFile(path.join(fixture.seed, "settings.json"), settings)
        await writeFile(path.join(fixture.seed, "config.json"), config)
      } else if (phase === "removed-settings") {
        await writeFile(path.join(fixture.seed, "config.json"), config)
      }
    } else if (phase !== "staged") {
      await writeFile(path.join(fixture.seed, "managed-settings.json"), "partial\n")
      if (["published-files", "published-hashes"].includes(phase)) {
        await writeFile(path.join(fixture.seed, "managed-files.txt"), "partial\n")
      }
      if (phase === "published-hashes") await writeFile(path.join(fixture.seed, "managed.sha256"), "partial\n")
    }
    await authenticatedStage(fixture, phase)

    await runFinalizer(fixture.seed)

    await expectFinalSeed(fixture.seed)
  })

  it("rejects extra arguments and unsafe identifiers or paths", async () => {
    const fixture = await nativeSeed()

    await expect(runFinalizer(fixture.seed, "extra")).rejects.toThrow(/expected exactly 4 arguments/)
    await expect(
      execFilePromise(process.execPath, [finalizer, fixture.seed, "../hve", "hve-core", "3.3.101"]),
    ).rejects.toThrow(/unsafe marketplace identifier/)
    await expect(
      execFilePromise(process.execPath, [finalizer, "relative-seed", "hve-core", "hve-core", "3.3.101"]),
    ).rejects.toThrow(/seed path must be absolute/)
  })

  it("preserves stale outputs and native settings after validation failure", async () => {
    const fixture = await nativeSeed()
    for (const output of ["managed-settings.json", "managed-files.txt", "managed.sha256", "managed-lock.json"]) {
      await writeFile(path.join(fixture.seed, output), "stale\n")
    }
    await writeFile(nativeManifest(fixture.installed), '{"name":"hve-core","version":"0.0.0"}\n')

    await expect(runFinalizer(fixture.seed)).rejects.toThrow(/installed plugin version mismatch/)
    for (const output of ["managed-settings.json", "managed-files.txt", "managed.sha256", "managed-lock.json"]) {
      await expect(readFile(path.join(fixture.seed, output), "utf8")).resolves.toBe("stale\n")
    }
    await expect(exists(path.join(fixture.seed, "settings.json"))).resolves.toBe(true)
    await expect(exists(path.join(fixture.seed, "config.json"))).resolves.toBe(true)
  })
})
