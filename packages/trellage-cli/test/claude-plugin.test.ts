import { execFile } from "node:child_process"
import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import {
  ClaudePluginError,
  pluginVersionFromCommit,
  pluginVersionFromRef,
  readClaudeMarketplace,
} from "../src/claude-plugin.js"

const roots: Array<string> = []
const execFilePromise = promisify(execFile)
const finalizer = fileURLToPath(new URL("../../../prototypes/trellage/finalize-claude-seed.mjs", import.meta.url))

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const marketplace = async (value: unknown): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-claude-marketplace-"))
  roots.push(root)
  const directory = path.join(root, ".claude-plugin")
  await mkdir(directory)
  await writeFile(path.join(directory, "marketplace.json"), `${JSON.stringify(value)}\n`)
  return root
}

const valid = {
  name: "social-media-skills",
  owner: { name: "Charlie Hills", url: "https://example.test" },
  plugins: [
    {
      name: "social-media-skills",
      source: ".",
      description: "Social media skills",
      version: "1.0.0",
      metadata: { categories: ["social"] },
    },
  ],
}

describe("readClaudeMarketplace", () => {
  it("extracts exact selected native Claude plugin versions", async () => {
    const root = await marketplace(valid)

    const versions = await Effect.runPromise(
      readClaudeMarketplace(root, "social-media-skills", ["social-media-skills"]),
    )

    expect(versions).toEqual({ "social-media-skills": "1.0.0" })
    expect(Object.getPrototypeOf(versions)).toBeNull()
    expect(Object.isFrozen(versions)).toBe(true)
  })

  describe("finalize Claude marketplace seed", () => {
    it("normalizes native plugin state without build paths or transient identity", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "trellage-claude-finalizer-"))
      roots.push(root)
      const source = path.join(root, "source")
      const seed = path.join(root, "seed")
      const cache = path.join(seed, "plugins", "cache", "social-media-skills", "social-media-skills", "1.0.0")
      await mkdir(path.join(source, ".claude-plugin"), { recursive: true })
      await mkdir(path.join(source, "skills", "writer"), { recursive: true })
      await writeFile(path.join(source, ".claude-plugin", "marketplace.json"), `${JSON.stringify(valid)}\n`)
      await writeFile(path.join(source, "skills", "writer", "SKILL.md"), "# Writer\n")
      await cp(source, cache, { recursive: true })
      await mkdir(path.join(seed, "skills", "caveman"), { recursive: true })
      await writeFile(path.join(seed, "skills", "caveman", "SKILL.md"), "ACTIVE EVERY RESPONSE\n")
      await writeFile(path.join(seed, "CLAUDE.md"), "ACTIVE EVERY RESPONSE\n")
      await mkdir(path.join(seed, "backups"))
      await writeFile(path.join(seed, "default-settings.json"), "{}\n")
      await writeFile(path.join(seed, "default-user-settings.json"), '{"outputStyle":"Rundown"}\n')
      await writeFile(path.join(seed, ".claude.json"), '{"machineID":"transient"}\n')
      await writeFile(
        path.join(seed, "settings.json"),
        `${JSON.stringify({
          enabledPlugins: { "social-media-skills@social-media-skills": true },
          pluginConfigs: {
            "social-media-skills@social-media-skills": {
              options: { hook_profile: "minimal", hooks_enabled: true },
            },
          },
        })}\n`,
      )
      await writeFile(
        path.join(seed, "plugins", "installed_plugins.json"),
        `${JSON.stringify({
          version: 2,
          plugins: {
            "social-media-skills@social-media-skills": [
              {
                scope: "user",
                installPath: cache,
                version: "1.0.0",
                installedAt: "nondeterministic",
              },
            ],
          },
        })}\n`,
      )
      await writeFile(path.join(seed, "plugins", "known_marketplaces.json"), `{"path":${JSON.stringify(source)}}\n`)
      const manifest = path.join(root, "marketplaces.json")
      await writeFile(
        manifest,
        `${JSON.stringify({
          marketplaces: [
            {
              marketplace: "social-media-skills",
              source,
              commit: "a".repeat(40),
              plugins: [
                {
                  plugin: "social-media-skills",
                  version: "1.0.0",
                },
              ],
            },
          ],
        })}\n`,
      )
      await writeFile(
        path.join(root, "claude-plugin-configs.json"),
        `${JSON.stringify({
          pluginConfigs: {
            "social-media-skills@social-media-skills": {
              hook_profile: "minimal",
              hooks_enabled: "true",
            },
          },
        })}\n`,
      )

      await execFilePromise(process.execPath, [finalizer, seed, manifest, "2.1.222"])

      const registry = await readFile(path.join(seed, "plugins", "installed_plugins.json"), "utf8")
      expect(registry).toContain("/home/agent/.claude/plugins/cache/social-media-skills/social-media-skills/1.0.0")
      expect(registry).toContain(`"gitCommitSha": "${"a".repeat(40)}"`)
      expect(registry).not.toMatch(/nondeterministic|trellage-claude-finalizer/)
      await expect(readFile(path.join(seed, ".claude.json"))).rejects.toMatchObject({ code: "ENOENT" })
      await expect(readFile(path.join(seed, "default-onboarding.json"), "utf8")).resolves.toBe(
        `${JSON.stringify(
          {
            hasCompletedOnboarding: true,
            lastOnboardingVersion: "2.1.222",
            theme: "dark",
            shiftEnterKeyBindingInstalled: true,
          },
          null,
          2,
        )}\n`,
      )
      await expect(readFile(path.join(seed, "default-user-settings.json"), "utf8")).resolves.toBe(
        '{"outputStyle":"Rundown"}\n',
      )
      await expect(readFile(path.join(seed, "plugin-marketplaces.json"), "utf8")).resolves.toBe(
        `${JSON.stringify(
          {
            "social-media-skills": {
              source: {
                source: "directory",
                path: "/home/agent/.claude/plugins/cache/social-media-skills/social-media-skills/1.0.0",
              },
              installLocation: "/home/agent/.claude/plugins/cache/social-media-skills/social-media-skills/1.0.0",
            },
          },
          null,
          2,
        )}\n`,
      )
      await expect(readFile(path.join(seed, "plugin-settings.json"), "utf8")).resolves.toBe(
        `${JSON.stringify(
          {
            enabledPlugins: { "social-media-skills@social-media-skills": true },
            pluginConfigs: {
              "social-media-skills@social-media-skills": {
                options: {
                  hook_profile: "minimal",
                  hooks_enabled: true,
                },
              },
            },
          },
          null,
          2,
        )}\n`,
      )
      const managed = await readFile(path.join(seed, "managed-paths.txt"), "utf8")
      expect(managed).toContain("plugins/cache/social-media-skills/social-media-skills/1.0.0/skills/writer/SKILL.md")
      expect(managed).toContain("plugins/installed_plugins.json")
      expect(managed).toContain("skills/caveman/SKILL.md")
      expect(managed).toContain("CLAUDE.md")
      expect(managed).not.toContain("[object Object]")
    })

    it("rejects generated plugin options that were not declared by the profile", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "trellage-claude-config-finalizer-"))
      roots.push(root)
      const source = path.join(root, "source")
      const seed = path.join(root, "seed")
      const cache = path.join(seed, "plugins", "cache", "ecc", "ecc", "2.2.0")
      await mkdir(path.join(source, ".claude-plugin"), { recursive: true })
      await mkdir(path.join(source, "skills", "ecc-guide"), { recursive: true })
      await writeFile(
        path.join(source, ".claude-plugin", "marketplace.json"),
        `${JSON.stringify({
          name: "ecc",
          owner: { name: "ECC" },
          plugins: [{ name: "ecc", source: "./", description: "ECC", version: "2.2.0" }],
        })}\n`,
      )
      await writeFile(path.join(source, "skills", "ecc-guide", "SKILL.md"), "# ECC Guide\n")
      await cp(source, cache, { recursive: true })
      await writeFile(
        path.join(seed, "settings.json"),
        `${JSON.stringify({
          enabledPlugins: { "ecc@ecc": true },
          pluginConfigs: { "ecc@ecc": { options: { hook_profile: "strict" } } },
        })}\n`,
      )
      await writeFile(
        path.join(seed, "plugins", "installed_plugins.json"),
        `${JSON.stringify({
          version: 2,
          plugins: {
            "ecc@ecc": [{ scope: "user", installPath: cache, version: "2.2.0" }],
          },
        })}\n`,
      )
      const manifest = path.join(root, "marketplaces.json")
      await writeFile(
        manifest,
        `${JSON.stringify({
          marketplaces: [
            {
              marketplace: "ecc",
              source,
              commit: "b".repeat(40),
              plugins: [{ plugin: "ecc", version: "2.2.0" }],
            },
          ],
        })}\n`,
      )

      await expect(execFilePromise(process.execPath, [finalizer, seed, manifest, "2.1.251"])).rejects.toThrow(
        /generated Claude plugin config does not match profile/,
      )
    })

    it("accepts relative in-tree skill symlinks when comparing installed plugin inventory", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "trellage-claude-symlink-"))
      roots.push(root)
      const source = path.join(root, "source")
      const seed = path.join(root, "seed")
      const cache = path.join(seed, "plugins", "cache", "council", "council", "1.2.0")
      await mkdir(path.join(source, ".claude-plugin"), { recursive: true })
      await mkdir(path.join(source, "skills", "council"), { recursive: true })
      await writeFile(
        path.join(source, ".claude-plugin", "marketplace.json"),
        `${JSON.stringify({
          name: "council",
          owner: { name: "0xNyk" },
          plugins: [{ name: "council", source: "./", description: "Council", version: "1.2.0" }],
        })}\n`,
      )
      await writeFile(path.join(source, "SKILL.md"), "# Council root skill\n")
      await symlink("../../SKILL.md", path.join(source, "skills", "council", "SKILL.md"))
      await cp(source, cache, { recursive: true, verbatimSymlinks: true })
      await writeFile(path.join(seed, "settings.json"), '{"enabledPlugins":{"council@council":true}}\n')
      await writeFile(
        path.join(seed, "plugins", "installed_plugins.json"),
        `${JSON.stringify({
          version: 2,
          plugins: {
            "council@council": [
              {
                scope: "user",
                installPath: cache,
                version: "1.2.0",
                installedAt: "nondeterministic",
              },
            ],
          },
        })}\n`,
      )
      const manifest = path.join(root, "marketplaces.json")
      await writeFile(
        manifest,
        `${JSON.stringify({
          marketplaces: [
            {
              marketplace: "council",
              source,
              commit: "b".repeat(40),
              plugins: [{ plugin: "council", version: "1.2.0" }],
            },
          ],
        })}\n`,
      )

      await execFilePromise(process.execPath, [finalizer, seed, manifest, "2.1.222"])

      const managed = await readFile(path.join(seed, "managed-paths.txt"), "utf8")
      expect(managed).toContain("plugins/cache/council/council/1.2.0/skills/council/SKILL.md")
      expect(managed).toContain("plugins/cache/council/council/1.2.0/SKILL.md")
      const skillLink = path.join(cache, "skills", "council", "SKILL.md")
      const skillStatus = await lstat(skillLink)
      expect(skillStatus.isSymbolicLink()).toBe(false)
      expect(skillStatus.isFile()).toBe(true)
      await expect(readFile(skillLink, "utf8")).resolves.toBe("# Council root skill\n")
      // Source may still be a symlink; only the baked cache must be a regular file.
      expect((await lstat(path.join(source, "skills", "council", "SKILL.md"))).isSymbolicLink()).toBe(true)
    })

    it("compares a nested plugin cache against the plugin subdirectory, not the marketplace root", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "trellage-claude-nested-finalizer-"))
      roots.push(root)
      const source = path.join(root, "source")
      const seed = path.join(root, "seed")
      const pluginRoot = path.join(source, "plugins", "beads")
      const cache = path.join(seed, "plugins", "cache", "beads-marketplace", "beads", "1.2.2")
      await mkdir(path.join(source, ".claude-plugin"), { recursive: true })
      await mkdir(path.join(pluginRoot, "skills", "beads"), { recursive: true })
      await writeFile(
        path.join(source, ".claude-plugin", "marketplace.json"),
        `${JSON.stringify({
          name: "beads-marketplace",
          owner: { name: "Steve Yegge" },
          plugins: [
            {
              name: "beads",
              source: "./plugins/beads",
              description: "Beads",
              version: "1.2.2",
            },
          ],
        })}\n`,
      )
      await writeFile(path.join(source, "README.md"), "# marketplace root must not be required in the cache\n")
      await writeFile(path.join(pluginRoot, "skills", "beads", "SKILL.md"), "# Beads\n")
      await cp(pluginRoot, cache, { recursive: true })
      await writeFile(path.join(seed, "settings.json"), '{"enabledPlugins":{"beads@beads-marketplace":true}}\n')
      await writeFile(
        path.join(seed, "plugins", "installed_plugins.json"),
        `${JSON.stringify({
          version: 2,
          plugins: {
            "beads@beads-marketplace": [
              { scope: "user", installPath: cache, version: "1.2.2", installedAt: "nondeterministic" },
            ],
          },
        })}\n`,
      )
      const manifest = path.join(root, "marketplaces.json")
      await writeFile(
        manifest,
        `${JSON.stringify({
          marketplaces: [
            {
              marketplace: "beads-marketplace",
              source,
              commit: "c".repeat(40),
              plugins: [{ plugin: "beads", version: "1.2.2" }],
            },
          ],
        })}\n`,
      )

      await execFilePromise(process.execPath, [finalizer, seed, manifest, "2.1.222"])

      const managed = await readFile(path.join(seed, "managed-paths.txt"), "utf8")
      expect(managed).toContain("plugins/cache/beads-marketplace/beads/1.2.2/skills/beads/SKILL.md")
      expect(managed).not.toContain("README.md")
    })

    it("accepts a Claude plugin cache that omits extra source-only harness files", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "trellage-claude-subset-finalizer-"))
      roots.push(root)
      const source = path.join(root, "source")
      const seed = path.join(root, "seed")
      const pluginRoot = path.join(source, "plugins", "beads")
      const cache = path.join(seed, "plugins", "cache", "beads-marketplace", "beads", "1.2.2")
      await mkdir(path.join(source, ".claude-plugin"), { recursive: true })
      await mkdir(path.join(pluginRoot, "skills", "beads"), { recursive: true })
      await mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true })
      await writeFile(
        path.join(source, ".claude-plugin", "marketplace.json"),
        `${JSON.stringify({
          name: "beads-marketplace",
          owner: { name: "Steve Yegge" },
          plugins: [
            {
              name: "beads",
              source: "./plugins/beads",
              description: "Beads",
              version: "1.2.2",
            },
          ],
        })}\n`,
      )
      await writeFile(path.join(pluginRoot, "skills", "beads", "SKILL.md"), "# Beads\n")
      await writeFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"), '{"name":"beads"}\n')
      await writeFile(path.join(pluginRoot, "copilot_manifest.go"), "package beads\n")
      await mkdir(path.join(cache, "skills", "beads"), { recursive: true })
      await writeFile(path.join(cache, "skills", "beads", "SKILL.md"), "# Beads\n")
      await writeFile(path.join(seed, "settings.json"), '{"enabledPlugins":{"beads@beads-marketplace":true}}\n')
      await writeFile(
        path.join(seed, "plugins", "installed_plugins.json"),
        `${JSON.stringify({
          version: 2,
          plugins: {
            "beads@beads-marketplace": [
              { scope: "user", installPath: cache, version: "1.2.2", installedAt: "nondeterministic" },
            ],
          },
        })}\n`,
      )
      const manifest = path.join(root, "marketplaces.json")
      await writeFile(
        manifest,
        `${JSON.stringify({
          marketplaces: [
            {
              marketplace: "beads-marketplace",
              source,
              commit: "c".repeat(40),
              plugins: [{ plugin: "beads", version: "1.2.2" }],
            },
          ],
        })}\n`,
      )

      await execFilePromise(process.execPath, [finalizer, seed, manifest, "2.1.222"])

      const managed = await readFile(path.join(seed, "managed-paths.txt"), "utf8")
      expect(managed).toContain("plugins/cache/beads-marketplace/beads/1.2.2/skills/beads/SKILL.md")
      expect(managed).not.toContain("copilot_manifest.go")
      expect(managed).not.toContain(".codex-plugin")
    })

    it("accepts node_modules generated from a locked root plugin package", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "trellage-claude-node-modules-finalizer-"))
      roots.push(root)
      const source = path.join(root, "source")
      const seed = path.join(root, "seed")
      const cache = path.join(seed, "plugins", "cache", "caveman", "caveman", "2.3.1")
      await mkdir(path.join(source, ".claude-plugin"), { recursive: true })
      await mkdir(path.join(source, "skills", "caveman"), { recursive: true })
      await writeFile(
        path.join(source, ".claude-plugin", "marketplace.json"),
        `${JSON.stringify({
          name: "caveman",
          owner: { name: "Julius Brussee" },
          plugins: [{ name: "caveman", source: "./", description: "Caveman", version: "2.3.1" }],
        })}\n`,
      )
      await writeFile(path.join(source, "package.json"), '{"name":"caveman","version":"2.3.1"}\n')
      await writeFile(
        path.join(source, "package-lock.json"),
        '{"name":"caveman","version":"2.3.1","lockfileVersion":3,"packages":{}}\n',
      )
      await writeFile(path.join(source, "skills", "caveman", "SKILL.md"), "# Caveman\n")
      await cp(source, cache, { recursive: true })
      await mkdir(path.join(cache, "node_modules", ".bin"), { recursive: true })
      await writeFile(path.join(cache, "node_modules", ".bin", "cave"), "#!/bin/sh\n", { mode: 0o755 })
      await writeFile(path.join(seed, "settings.json"), '{"enabledPlugins":{"caveman@caveman":true}}\n')
      await writeFile(
        path.join(seed, "plugins", "installed_plugins.json"),
        `${JSON.stringify({
          version: 2,
          plugins: {
            "caveman@caveman": [
              { scope: "user", installPath: cache, version: "2.3.1", installedAt: "nondeterministic" },
            ],
          },
        })}\n`,
      )
      const manifest = path.join(root, "marketplaces.json")
      await writeFile(
        manifest,
        `${JSON.stringify({
          marketplaces: [
            {
              marketplace: "caveman",
              source,
              commit: "c".repeat(40),
              plugins: [{ plugin: "caveman", version: "2.3.1" }],
            },
          ],
        })}\n`,
      )

      await execFilePromise(process.execPath, [finalizer, seed, manifest, "2.1.251"])

      const managed = await readFile(path.join(seed, "managed-paths.txt"), "utf8")
      expect(managed).toContain("plugins/cache/caveman/caveman/2.3.1/node_modules/.bin/cave")
    })

    it("rejects generated node_modules when the plugin source has no npm lockfile", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "trellage-claude-unlocked-node-modules-"))
      roots.push(root)
      const source = path.join(root, "source")
      const seed = path.join(root, "seed")
      const cache = path.join(seed, "plugins", "cache", "beads-marketplace", "beads", "1.2.2")
      await mkdir(path.join(source, ".claude-plugin"), { recursive: true })
      await mkdir(path.join(source, "plugins", "beads"), { recursive: true })
      await writeFile(
        path.join(source, ".claude-plugin", "marketplace.json"),
        `${JSON.stringify({
          name: "beads-marketplace",
          owner: { name: "Steve Yegge" },
          plugins: [{ name: "beads", source: "./plugins/beads", description: "Beads", version: "1.2.2" }],
        })}\n`,
      )
      await writeFile(path.join(source, "plugins", "beads", "package.json"), '{"name":"beads"}\n')
      await cp(path.join(source, "plugins", "beads"), cache, { recursive: true })
      await mkdir(path.join(cache, "node_modules"), { recursive: true })
      await writeFile(path.join(cache, "node_modules", "injected.js"), "injected\n")
      await writeFile(path.join(seed, "settings.json"), '{"enabledPlugins":{"beads@beads-marketplace":true}}\n')
      await writeFile(
        path.join(seed, "plugins", "installed_plugins.json"),
        `${JSON.stringify({
          version: 2,
          plugins: {
            "beads@beads-marketplace": [
              { scope: "user", installPath: cache, version: "1.2.2", installedAt: "nondeterministic" },
            ],
          },
        })}\n`,
      )
      const manifest = path.join(root, "marketplaces.json")
      await writeFile(
        manifest,
        `${JSON.stringify({
          marketplaces: [
            {
              marketplace: "beads-marketplace",
              source,
              commit: "c".repeat(40),
              plugins: [{ plugin: "beads", version: "1.2.2" }],
            },
          ],
        })}\n`,
      )

      await expect(execFilePromise(process.execPath, [finalizer, seed, manifest, "2.1.251"])).rejects.toThrow(
        /installed Claude plugin does not match locked marketplace source: beads@beads-marketplace/,
      )
    })

    it("rejects a plugin cache that adds files not in the marketplace source", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "trellage-claude-extra-cache-"))
      roots.push(root)
      const source = path.join(root, "source")
      const seed = path.join(root, "seed")
      const cache = path.join(seed, "plugins", "cache", "beads-marketplace", "beads", "1.2.2")
      await mkdir(path.join(source, ".claude-plugin"), { recursive: true })
      await mkdir(path.join(source, "plugins", "beads", "skills", "beads"), { recursive: true })
      await writeFile(
        path.join(source, ".claude-plugin", "marketplace.json"),
        `${JSON.stringify({
          name: "beads-marketplace",
          owner: { name: "Steve Yegge" },
          plugins: [{ name: "beads", source: "./plugins/beads", description: "Beads", version: "1.2.2" }],
        })}\n`,
      )
      await writeFile(path.join(source, "plugins", "beads", "skills", "beads", "SKILL.md"), "# Beads\n")
      await mkdir(path.join(cache, "skills", "beads"), { recursive: true })
      await writeFile(path.join(cache, "skills", "beads", "SKILL.md"), "# Beads\n")
      await writeFile(path.join(cache, "injected.txt"), "not in source\n")
      await writeFile(path.join(seed, "settings.json"), '{"enabledPlugins":{"beads@beads-marketplace":true}}\n')
      await writeFile(
        path.join(seed, "plugins", "installed_plugins.json"),
        `${JSON.stringify({
          version: 2,
          plugins: {
            "beads@beads-marketplace": [
              { scope: "user", installPath: cache, version: "1.2.2", installedAt: "nondeterministic" },
            ],
          },
        })}\n`,
      )
      const manifest = path.join(root, "marketplaces.json")
      await writeFile(
        manifest,
        `${JSON.stringify({
          marketplaces: [
            {
              marketplace: "beads-marketplace",
              source,
              commit: "c".repeat(40),
              plugins: [{ plugin: "beads", version: "1.2.2" }],
            },
          ],
        })}\n`,
      )

      await expect(execFilePromise(process.execPath, [finalizer, seed, manifest, "2.1.222"])).rejects.toThrow(
        /installed Claude plugin does not match locked marketplace source: beads@beads-marketplace/,
      )
    })
  })

  it.each(["", "..", "../plugin", "/plugin", "C:\\plugin", "plugins/../escape", "plugins//beads"])(
    "rejects unsafe native Claude plugin source %j",
    async (source) => {
      const root = await marketplace({
        ...valid,
        plugins: [{ ...valid.plugins[0], source }],
      })

      await expect(
        Effect.runPromise(readClaudeMarketplace(root, "social-media-skills", ["social-media-skills"])),
      ).rejects.toThrow(/source/)
    },
  )

  it.each(["./plugins/beads", "plugins/full-stack-orchestration"])(
    "accepts a relative in-tree Claude plugin source %j",
    async (source) => {
      const root = await marketplace({
        ...valid,
        plugins: [{ ...valid.plugins[0], source, version: "1.2.2" }],
      })

      await expect(
        Effect.runPromise(readClaudeMarketplace(root, "social-media-skills", ["social-media-skills"])),
      ).resolves.toEqual({ "social-media-skills": "1.2.2" })
    },
  )

  it("ignores unselected plugins whose source is not a path string", async () => {
    const root = await marketplace({
      ...valid,
      plugins: [
        valid.plugins[0],
        {
          name: "pensyve",
          source: { source: "git-subdir", url: "https://github.com/example/pensyve.git" },
          description: "External memory",
          version: "1.3.0",
        },
      ],
    })

    await expect(
      Effect.runPromise(readClaudeMarketplace(root, "social-media-skills", ["social-media-skills"])),
    ).resolves.toEqual({ "social-media-skills": "1.0.0" })
  })

  it("rejects a selected plugin whose source is not a path string", async () => {
    const root = await marketplace({
      ...valid,
      plugins: [
        {
          ...valid.plugins[0],
          source: { source: "git-subdir", url: "https://github.com/example/pensyve.git" },
        },
      ],
    })

    await expect(
      Effect.runPromise(readClaudeMarketplace(root, "social-media-skills", ["social-media-skills"])),
    ).rejects.toThrow(/source/)
  })

  it("reads an exact plugin manifest version from a nested plugin source", async () => {
    const root = await marketplace({
      ...valid,
      plugins: [{ ...valid.plugins[0], source: "./plugins/beads", version: undefined }],
    })
    await mkdir(path.join(root, "plugins", "beads", ".claude-plugin"), { recursive: true })
    await writeFile(
      path.join(root, "plugins", "beads", ".claude-plugin", "plugin.json"),
      '{"name":"social-media-skills","version":"1.2.2","description":"nested"}\n',
    )

    await expect(
      Effect.runPromise(readClaudeMarketplace(root, "social-media-skills", ["social-media-skills"])),
    ).resolves.toEqual({ "social-media-skills": "1.2.2" })
  })

  it("treats a plugin.json-only Claude repo as a one-plugin marketplace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-claude-plugin-json-"))
    roots.push(root)
    await mkdir(path.join(root, ".claude-plugin"))
    await writeFile(
      path.join(root, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({
        name: "insane-research",
        version: "2.9.0",
        description: "Multi-agent deep research",
        author: { name: "fivetaku" },
      })}\n`,
    )

    await expect(
      Effect.runPromise(readClaudeMarketplace(root, "insane-research", ["insane-research"])),
    ).resolves.toEqual({ "insane-research": "2.9.0" })
  })

  it("reads an exact plugin manifest version when the root marketplace omits it", async () => {
    const root = await marketplace({
      ...valid,
      plugins: [{ ...valid.plugins[0], source: "./", version: undefined }],
    })
    await writeFile(
      path.join(root, ".claude-plugin", "plugin.json"),
      '{"name":"social-media-skills","version":"2.9.1","description":"ignored"}\n',
    )

    await expect(
      Effect.runPromise(readClaudeMarketplace(root, "social-media-skills", ["social-media-skills"])),
    ).resolves.toEqual({ "social-media-skills": "2.9.1" })
  })

  it("uses a lock-time version fallback when marketplace and plugin manifests omit version", async () => {
    const root = await marketplace({
      ...valid,
      plugins: [{ ...valid.plugins[0], source: "./", version: undefined }],
    })
    await writeFile(
      path.join(root, ".claude-plugin", "plugin.json"),
      '{"name":"social-media-skills","description":"no version"}\n',
    )

    await expect(
      Effect.runPromise(
        readClaudeMarketplace(root, "social-media-skills", ["social-media-skills"], {
          versionFallback: "1.10.0",
        }),
      ),
    ).resolves.toEqual({ "social-media-skills": "1.10.0" })
  })

  it("accepts a generated commit-tied fallback for a versionless floating plugin", async () => {
    const root = await marketplace({
      ...valid,
      plugins: [{ ...valid.plugins[0], source: "./", version: undefined }],
    })
    await writeFile(
      path.join(root, ".claude-plugin", "plugin.json"),
      '{"name":"social-media-skills","description":"no version"}\n',
    )

    await expect(
      Effect.runPromise(
        readClaudeMarketplace(root, "social-media-skills", ["social-media-skills"], {
          versionFallback: "0.0.0-commit.abcdef012345",
        }),
      ),
    ).resolves.toEqual({ "social-media-skills": "0.0.0-commit.abcdef012345" })
  })

  it("prefers declared marketplace version over a version fallback", async () => {
    const root = await marketplace(valid)

    await expect(
      Effect.runPromise(
        readClaudeMarketplace(root, "social-media-skills", ["social-media-skills"], {
          versionFallback: "9.9.9",
        }),
      ),
    ).resolves.toEqual({ "social-media-skills": "1.0.0" })
  })

  it("rejects missing plugin versions without a fallback", async () => {
    const root = await marketplace({
      ...valid,
      plugins: [{ ...valid.plugins[0], source: "./", version: undefined }],
    })
    await writeFile(
      path.join(root, ".claude-plugin", "plugin.json"),
      '{"name":"social-media-skills","description":"no version"}\n',
    )

    await expect(
      Effect.runPromise(readClaudeMarketplace(root, "social-media-skills", ["social-media-skills"])),
    ).rejects.toThrow(/version is missing/)
  })

  it.each([
    ["v1.10.0", "1.10.0"],
    ["1.10.0", "1.10.0"],
    ["v0.1.0", "0.1.0"],
  ])("derives plugin version from pinned ref %j", (ref, version) => {
    expect(pluginVersionFromRef(ref)).toBe(version)
  })

  it.each(["main", "latest", "abc123", "v1.10", "1.10.0-beta.1", ""])(
    "does not derive plugin version from non-semver ref %j",
    (ref) => {
      expect(pluginVersionFromRef(ref)).toBeUndefined()
    },
  )

  it("derives a deterministic exact prerelease version from a resolved commit", () => {
    expect(pluginVersionFromCommit("abcdef0123456789abcdef0123456789abcdef01")).toBe("0.0.0-commit.abcdef012345")
    expect(pluginVersionFromCommit("main")).toBeUndefined()
  })

  it("rejects duplicate JSON keys before decoding", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "trellage-claude-marketplace-"))
    roots.push(root)
    await mkdir(path.join(root, ".claude-plugin"))
    await writeFile(
      path.join(root, ".claude-plugin", "marketplace.json"),
      '{"name":"social-media-skills","name":"social-media-skills","owner":{"name":"Owner"},"plugins":[]}',
    )

    const error = await Effect.runPromise(
      Effect.flip(readClaudeMarketplace(root, "social-media-skills", ["social-media-skills"])),
    )

    expect(error).toBeInstanceOf(ClaudePluginError)
    expect(error.message).toBe("duplicate JSON key")
  })

  it.each([
    ["marketplace mismatch", valid, "other", ["social-media-skills"]],
    ["missing selection", valid, "social-media-skills", ["missing"]],
    [
      "duplicate plugin",
      { ...valid, plugins: [valid.plugins[0], valid.plugins[0]] },
      "social-media-skills",
      ["social-media-skills"],
    ],
    [
      "unpinned version",
      { ...valid, plugins: [{ ...valid.plugins[0], version: "latest" }] },
      "social-media-skills",
      ["social-media-skills"],
    ],
  ])("rejects invalid Claude marketplace metadata: %s", async (_label, value, name, selections) => {
    const root = await marketplace(value)

    await expect(Effect.runPromise(readClaudeMarketplace(root, name, selections))).rejects.toThrow(
      /Claude|duplicate|selection|version/,
    )
  })
})
