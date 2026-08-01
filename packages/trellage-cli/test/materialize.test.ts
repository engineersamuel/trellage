import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import {
  managedClaudeFiles,
  materializeChromiumArchives,
  normalizeHyperresearchSeed,
} from "../src/claude-materialize.js"
import { inventoryDirectory, verifyInventory } from "../src/inventory.js"
import { parseLock, renderLock } from "../src/lock-file.js"
import {
  createBuildContext,
  type ClaudeMaterializer,
  type PluginGenerator,
  type RuntimeSupport,
  type SkillGenerator,
} from "../src/materialize.js"
import { profileHash, type ProfileLock, type SourceLock } from "../src/lock.js"
import { createRuntimeSupportSnapshot } from "../src/runtime-support.js"
import { parseProfile } from "../src/profile.js"

const temporaryRoots: Array<string> = []
const execFilePromise = promisify(execFile)
const temporaryRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryRoots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const profileSource = (prompt = "") => `
schema = 1
name = "materialize"
[harness]
kind = "codex"
version = "0.144.6"
${prompt}
[harness.codex]
model = "gpt-5.5"
reasoning_effort = "medium"
model_provider = "proxy"
[harness.codex.providers.proxy]
base_url = "http://proxy:8080/v1"
wire_api = "responses"
[image]
platform = "linux/arm64"
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash", "fish"]
[[skills]]
repository = "https://github.com/example/skills.git"
ref = "v1"
select = ["one"]
[[plugins]]
adapter = "codex-native"
repository = "https://github.com/example/native.git"
ref = "v1"
select = ["native"]
[[plugins]]
adapter = "wshobson-agents"
repository = "https://github.com/wshobson/agents.git"
ref = "abc"
select = ["full-stack-orchestration"]
[secrets]
provider = "env"
required = ["DO_NOT_WRITE_ME"]
`

const fixture = async (root: string, kind: "skill" | "native" | "compat") => {
  const directory = path.join(root, kind)
  if (kind === "skill") {
    await mkdir(path.join(directory, "skills", "one"), { recursive: true })
    await writeFile(path.join(directory, "skills", "one", "SKILL.md"), "# One\n")
  } else if (kind === "native") {
    await mkdir(path.join(directory, "plugins", "native", ".codex", "agents"), { recursive: true })
    await writeFile(path.join(directory, "plugins", "native", ".codex", "agents", "native.toml"), 'name = "native"\n')
  } else {
    await mkdir(path.join(directory, "plugins", "full-stack-orchestration"), { recursive: true })
    await writeFile(path.join(directory, "plugins", "full-stack-orchestration", "plugin.txt"), "source\n")
  }
  return directory
}

describe("Hyperresearch seed normalization", () => {
  it("defines the exact Claude settings used for first-launch initialization", async () => {
    const module = (await import("../src/claude-materialize.js")) as Record<string, unknown>

    expect(module.claudeDefaultSettings).toEqual({
      permissions: {
        defaultMode: "bypassPermissions",
        deny: [
          "EnterPlanMode",
          "ExitPlanMode",
          "NotebookEdit",
          "SendMessage",
          "PushNotification",
          "RemoteTrigger",
          "ReportFindings",
          "ScheduleWakeup",
          "CronCreate",
          "CronDelete",
          "CronList",
        ],
      },
      disableRemoteControl: true,
      disableClaudeAiConnectors: true,
      disableArtifact: true,
    })
  })

  it("lists the managed manifest in global C-locale order", async () => {
    const root = await temporaryRoot("trellage-hyperresearch-manifest-")
    await mkdir(path.join(root, "skills", "hyperresearch"), { recursive: true })
    await mkdir(path.join(root, "agents"), { recursive: true })
    await writeFile(path.join(root, "skills", "hyperresearch", "SKILL.md"), "skill\n")
    await writeFile(path.join(root, "agents", "hyperresearch-z.md"), "agent\n")

    await expect(managedClaudeFiles(root)).resolves.toEqual([
      "agents/hyperresearch-z.md",
      "skills/hyperresearch/SKILL.md",
    ])
  })

  it("replaces only the ephemeral installer executable with the image runtime path", async () => {
    const root = await temporaryRoot("trellage-hyperresearch-seed-")
    const agent = path.join(root, "agents", "critic.md")
    const skill = path.join(root, "skills", "hyperresearch", "SKILL.md")
    const realStaging = path.join(root, "private-staging")
    const lexicalStaging = path.join(root, "staging")
    const realExecutable = path.join(realStaging, "host-venv", "bin", "hyperresearch")
    const generatedExecutable = path.join(lexicalStaging, "host-venv", "bin", "hyperresearch")
    await mkdir(path.dirname(agent), { recursive: true })
    await mkdir(path.dirname(skill), { recursive: true })
    await mkdir(path.dirname(realExecutable), { recursive: true })
    await writeFile(realExecutable, "#!/bin/sh\n")
    await symlink(realStaging, lexicalStaging)
    const embeddedExecutable = await realpath(generatedExecutable)
    await writeFile(agent, `run ${embeddedExecutable} note show; keep /private/tmp/unrelated\n`)
    await writeFile(skill, `invoke ${embeddedExecutable}\n`)

    await Effect.runPromise(normalizeHyperresearchSeed(root, generatedExecutable))

    await expect(readFile(agent, "utf8")).resolves.toBe(
      "run /usr/local/bin/hyperresearch note show; keep /private/tmp/unrelated\n",
    )
    await expect(readFile(skill, "utf8")).resolves.toBe("invoke /usr/local/bin/hyperresearch\n")
  })
})

describe("locked Chromium materialization", () => {
  it("extracts the full browser and executable headless shell into Playwright's layouts", async () => {
    const root = await temporaryRoot("trellage-chromium-archives-")
    const source = path.join(root, "source")
    const context = path.join(root, "context")
    const staging = path.join(root, "staging")
    await mkdir(path.join(source, "chrome-linux"), { recursive: true })
    await mkdir(context)
    await mkdir(staging)

    await writeFile(path.join(source, "chrome-linux", "chrome"), "full browser\n", { mode: 0o755 })
    const chromiumArchive = path.join(root, "chromium.zip")
    await execFilePromise("zip", ["-q", "-r", chromiumArchive, "chrome-linux"], { cwd: source })
    await rm(path.join(source, "chrome-linux"), { recursive: true })
    await mkdir(path.join(source, "chrome-linux"), { recursive: true })
    await writeFile(path.join(source, "chrome-linux", "headless_shell"), "headless browser\n", { mode: 0o755 })
    const headlessArchive = path.join(root, "headless.zip")
    await execFilePromise("zip", ["-q", "-r", headlessArchive, "chrome-linux"], { cwd: source })

    const lockedArtifact = async (name: string, file: string) => ({
      name,
      version: "1228",
      integrity: `sha256:${createHash("sha256")
        .update(await readFile(file))
        .digest("hex")}`,
      url: `file://${file}`,
      size: (await readFile(file)).byteLength,
    })
    const request = {
      sourceDirectory: source,
      context,
      requirementsPath: path.join(root, "unused-requirements.lock"),
      browserAgentPath: path.join(root, "unused-browser-agent.md"),
      lock: {
        packages: {
          artifacts: [
            await lockedArtifact("chromium", chromiumArchive),
            await lockedArtifact("chromium-headless-shell", headlessArchive),
          ],
        },
      },
    } as unknown as Parameters<typeof materializeChromiumArchives>[0]

    await Effect.runPromise(materializeChromiumArchives(request, staging))

    await expect(readFile(path.join(context, "chromium-1228", "chrome-linux", "chrome"), "utf8")).resolves.toBe(
      "full browser\n",
    )
    await expect(
      readFile(path.join(context, "chromium-headless-shell-1228", "chrome-linux", "headless_shell"), "utf8"),
    ).resolves.toBe("headless browser\n")
  })
})

describe("atomic build context", () => {
  it("delegates Claude Hyperresearch assets to the focused materializer", async () => {
    const root = await temporaryRoot("trellage-materialize-claude-")
    const document = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "claude-hyperresearch"
[harness]
kind = "claude"
version = "2.1.218"
[harness.claude]
default_auth = "proxy"
model = "claude-opus-5"
gateway = "http://copilot-proxy-rs:8080"
[image]
platform = "linux/arm64"
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[plugins]]
adapter = "hyperresearch"
repository = "https://github.com/jordan-gibbs/hyperresearch.git"
ref = "main"
select = ["full"]
`,
        path.join(root, "profile.toml"),
      ),
    )
    const checkout = path.join(root, "hyperresearch")
    await mkdir(checkout)
    await writeFile(path.join(checkout, "pyproject.toml"), '[project]\nname = "hyperresearch"\nversion = "0.9.1"\n')
    const files = await Effect.runPromise(inventoryDirectory(checkout))
    const lock: ProfileLock = {
      schema: 1,
      source_date_epoch: 1784379906,
      profile_hash: profileHash(document),
      sources: [
        {
          kind: "plugin",
          adapter: "hyperresearch",
          repository: "https://github.com/jordan-gibbs/hyperresearch.git",
          ref: "main",
          select: ["full"],
          commit: "183443aefec8d0444f4b53095cee17bf77ad5fb2",
          integrity: `sha256:${createHash("sha256").update(JSON.stringify(files)).digest("hex")}`,
          files,
        },
      ],
      packages: {
        harness: {
          kind: "claude",
          selector: "2.1.218",
          version: "2.1.218",
          integrity: `sha256:${"c".repeat(64)}`,
          url: "https://example.test/claude.tgz",
          size: 1,
        },
        runtime: [{ name: "bash", version: "5.2", integrity: `sha256:${"d".repeat(64)}` }],
      },
      image: { base: document.profile.image.base, base_digest: `sha256:${"b".repeat(64)}` },
    }
    const entry = path.join(root, "runtime-claude-entry.sh")
    const requirements = path.join(root, "requirements.lock")
    const browserAgent = path.join(root, "browser-agent.md")
    await writeFile(entry, "#!/bin/sh\n")
    await writeFile(requirements, "pydantic==2.13.4 --hash=sha256:test\n")
    await writeFile(browserAgent, "browser adapter\n")
    const calls: Array<string> = []
    const materializeClaude: ClaudeMaterializer = (request) =>
      Effect.tryPromise({
        try: async () => {
          calls.push(request.sourceDirectory)
          await mkdir(path.join(request.context, "hyperresearch-site"), { recursive: true })
          await mkdir(path.join(request.context, "claude-seed"), { recursive: true })
          await mkdir(path.join(request.context, "chromium-1228"), { recursive: true })
          await mkdir(path.join(request.context, "obscura"), { recursive: true })
          await writeFile(path.join(request.context, "hyperresearch-wrapper.sh"), "#!/bin/sh\n")
          await writeFile(path.join(request.context, "obscura", "obscura"), "binary")
          await writeFile(path.join(request.context, "obscura", "obscura-worker"), "binary")
        },
        catch: (cause) => cause,
      })
    const unused = () => Effect.fail("unexpected generator call")
    const context = await Effect.runPromise(
      createBuildContext(
        document,
        lock,
        [checkout],
        {
          codexEntry: path.join(root, "unused-codex.sh"),
          copilotEntry: path.join(root, "unused-copilot.sh"),
          finalizeCopilotSeed: path.join(root, "unused-finalizer.mjs"),
          claudeEntry: entry,
          hyperresearchRequirements: requirements,
          claudeBrowserAgent: browserAgent,
        },
        root,
        unused,
        unused,
        materializeClaude,
      ),
    )

    expect(calls).toEqual([checkout])
    await expect(readFile(path.join(context, "runtime-claude-entry.sh"), "utf8")).resolves.toBe("#!/bin/sh\n")
    await expect(readFile(path.join(context, "hyperresearch-wrapper.sh"), "utf8")).resolves.toBe("#!/bin/sh\n")
    const miseLock = await readFile(path.join(context, "mise.lock"), "utf8")
    expect(miseLock).toContain("[[tools.python]]")
    expect(miseLock).toContain('[tools."npm:@anthropic-ai/claude-code".options]\nnpm_args = "--ignore-scripts=false"')
  })
  it("materializes a legacy Codex lock from a self-verified executable source", async () => {
    const root = await temporaryRoot("harness-materialize-legacy-codex-")
    const document = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "legacy-codex"
[harness]
kind = "codex"
version = "0.144.6"
[harness.codex]
model = "gpt-5.5"
reasoning_effort = "medium"
model_provider = "proxy"
[harness.codex.providers.proxy]
base_url = "http://proxy:8080/v1"
wire_api = "responses"
[image]
platform = "linux/arm64"
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[skills]]
repository = "https://github.com/example/skills.git"
ref = "v1"
select = ["one"]
`,
        path.join(root, "profile.toml"),
      ),
    )
    const checkout = path.join(root, "checkout")
    const executable = path.join(checkout, "skills", "one", "install.sh")
    await mkdir(path.dirname(executable), { recursive: true })
    await writeFile(executable, "#!/bin/sh\n")
    await chmod(executable, 0o755)
    const cachedInventory = await Effect.runPromise(inventoryDirectory(checkout))
    await expect(Effect.runPromise(verifyInventory(checkout, cachedInventory))).resolves.toBeUndefined()
    const legacyFiles = cachedInventory.map((file) => {
      if (file.kind !== "file") throw new Error("expected file-only Codex fixture")
      return { kind: "file" as const, path: file.path, sha256: file.sha256 }
    })
    const legacyIntegrity = `sha256:${createHash("sha256")
      .update(JSON.stringify(legacyFiles.map(({ path, sha256 }) => ({ path, sha256 }))))
      .digest("hex")}`
    const lock: ProfileLock = {
      schema: 1,
      source_date_epoch: 1784379906,
      profile_hash: profileHash(document),
      sources: [
        {
          kind: "skill",
          repository: "https://github.com/example/skills.git",
          ref: "v1",
          select: ["one"],
          commit: "a".repeat(40),
          integrity: legacyIntegrity,
          files: legacyFiles,
        },
      ],
      packages: {
        harness: {
          kind: "codex",
          selector: "0.144.6",
          version: "0.144.6",
          integrity: "sha256:codex",
          url: "https://example.test/codex.tar.gz",
          size: 1024,
        },
        runtime: [{ name: "bash", version: "5.2", integrity: "sha256:bash" }],
      },
      image: { base: document.profile.image.base, base_digest: "sha256:base", final_digest: "sha256:final" },
    }
    const runtimeEntry = path.join(root, "runtime-entry.sh")
    await writeFile(runtimeEntry, "#!/usr/bin/env bash\n")
    const generateSkill: SkillGenerator = (_source, _selection, destination) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(path.join(destination, ".agents", "skills", "one"), { recursive: true })
          await writeFile(path.join(destination, ".agents", "skills", "one", "SKILL.md"), "# One\n")
        },
        catch: (cause) => cause,
      })
    const unusedPlugin: PluginGenerator = () => Effect.fail("unexpected plugin generator call")

    const parsedLock = await Effect.runPromise(
      parseLock(`
schema = 1
source_date_epoch = 1784379906
profile_hash = ${JSON.stringify(lock.profile_hash)}

[[sources]]
kind = "skill"
repository = "https://github.com/example/skills.git"
ref = "v1"
select = ["one"]
commit = "${"a".repeat(40)}"
integrity = ${JSON.stringify(legacyIntegrity)}

[[sources.files]]
path = ${JSON.stringify(legacyFiles[0]!.path)}
sha256 = ${JSON.stringify(legacyFiles[0]!.sha256)}

[packages]
codex = "0.144.6"
codex_integrity = "sha256:codex"
codex_url = "https://example.test/codex.tar.gz"
codex_size = 1024

[[packages.runtime]]
name = "bash"
version = "5.2"
integrity = "sha256:bash"

[image]
base = ${JSON.stringify(document.profile.image.base)}
base_digest = "sha256:base"
final_digest = "sha256:final"
`),
    )
    const context = await Effect.runPromise(
      createBuildContext(
        document,
        parsedLock,
        [checkout],
        {
          codexEntry: runtimeEntry,
          copilotEntry: path.join(root, "unused-copilot-entry.sh"),
          finalizeCopilotSeed: path.join(root, "unused-finalizer.mjs"),
        },
        root,
        generateSkill,
        unusedPlugin,
      ),
    )

    await expect(readFile(path.join(context, "assets", "skills", "one", "SKILL.md"), "utf8")).resolves.toBe("# One\n")
  })

  it("does not let legacy alternate integrity disable modern Codex mode checks", async () => {
    const root = await temporaryRoot("harness-materialize-modern-codex-mode-")
    const document = await Effect.runPromise(parseProfile(profileSource(), path.join(root, "profile.toml")))
    const directories = [await fixture(root, "skill"), await fixture(root, "native"), await fixture(root, "compat")]
    const sourceLocks: Array<SourceLock> = []
    for (const [index, request] of [
      ...document.profile.skills.map((item) => ({ kind: "skill" as const, ...item })),
      ...document.profile.plugins.map((item) => ({ kind: "plugin" as const, ...item })),
    ].entries()) {
      const files = await Effect.runPromise(inventoryDirectory(directories[index]!))
      sourceLocks.push({
        kind: request.kind,
        ...(request.kind === "plugin" ? { adapter: request.adapter } : {}),
        repository: request.repository,
        ref: request.ref,
        select: request.select,
        commit: String(index).repeat(40),
        integrity: `sha256:${createHash("sha256").update(JSON.stringify(files)).digest("hex")}`,
        files,
      })
    }
    const firstSource = sourceLocks[0]!
    const legacyFiles = firstSource.files.map((file) => {
      if (file.kind !== "file") throw new Error("expected file-only fixture")
      return { path: file.path, sha256: file.sha256 }
    })
    sourceLocks[0] = {
      ...firstSource,
      integrity: `sha256:${createHash("sha256").update(JSON.stringify(legacyFiles)).digest("hex")}`,
    }
    await chmod(path.join(directories[0]!, "skills", "one", "SKILL.md"), 0o755)
    const lock: ProfileLock = {
      schema: 1,
      source_date_epoch: 1784379906,
      profile_hash: profileHash(document),
      sources: sourceLocks,
      packages: {
        harness: {
          kind: "codex",
          selector: "0.144.6",
          version: "0.144.6",
          integrity: "sha256:codex",
          url: "https://example.test/codex.tar.gz",
          size: 1024,
        },
        runtime: [
          { name: "bash", version: "5.2", integrity: "sha256:bash" },
          { name: "fish", version: "3.6", integrity: "sha256:fish" },
        ],
      },
      image: { base: document.profile.image.base, base_digest: "sha256:base", final_digest: "sha256:final" },
    }
    const unused = () => Effect.fail("unexpected generator call")

    const reparsed = await Effect.runPromise(parseLock(renderLock(lock)))
    const error = await Effect.runPromise(
      Effect.flip(
        createBuildContext(
          document,
          reparsed,
          directories,
          {
            codexEntry: path.join(root, "runtime-entry.sh"),
            copilotEntry: path.join(root, "unused-copilot-entry.sh"),
            finalizeCopilotSeed: path.join(root, "unused-finalizer.mjs"),
          },
          root,
          unused,
          unused,
        ),
      ),
    )

    expect(error.message).toBe("source inventory mismatch: https://github.com/example/skills.git")
  })

  it("rejects an unexpected executable bit for Copilot even with legacy-shaped source integrity", async () => {
    const root = await temporaryRoot("harness-materialize-copilot-legacy-mode-")
    const document = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "copilot-legacy-mode"
[harness]
kind = "copilot"
version = "latest"
[harness.copilot]
auth = "host-or-login"
[image]
platform = "linux/arm64"
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[plugins]]
adapter = "copilot-marketplace"
repository = "https://github.com/microsoft/hve-core.git"
ref = "main"
marketplace = "hve-core"
select = ["hve-core"]
`,
        path.join(root, "profile.toml"),
      ),
    )
    const checkout = path.join(root, "hve-core")
    const command = path.join(checkout, "plugins", "hve-core", "commands", "review.md")
    await mkdir(path.dirname(command), { recursive: true })
    await writeFile(command, "# Review\n")
    const modernFiles = await Effect.runPromise(inventoryDirectory(checkout, { allowSymlinks: true }))
    const legacyFiles = modernFiles.map((file) => {
      if (file.kind !== "file") throw new Error("expected file-only Copilot fixture")
      return { kind: "file" as const, path: file.path, sha256: file.sha256 }
    })
    const legacyIntegrity = `sha256:${createHash("sha256")
      .update(JSON.stringify(legacyFiles.map(({ path, sha256 }) => ({ path, sha256 }))))
      .digest("hex")}`
    await chmod(command, 0o755)
    const lock: ProfileLock = {
      schema: 1,
      source_date_epoch: 1784379906,
      profile_hash: profileHash(document),
      sources: [
        {
          kind: "plugin",
          adapter: "copilot-marketplace",
          marketplace: "hve-core",
          plugin_versions: { "hve-core": "3.3.101" },
          repository: "https://github.com/microsoft/hve-core.git",
          ref: "main",
          select: ["hve-core"],
          commit: "a".repeat(40),
          integrity: legacyIntegrity,
          files: legacyFiles,
        },
      ],
      packages: {
        harness: {
          kind: "copilot",
          selector: "latest",
          version: "1.0.75",
          integrity: "sha256:copilot",
          url: "https://example.test/copilot.tar.gz",
          size: 1024,
        },
        runtime: [{ name: "bash", version: "5.2", integrity: "sha256:bash" }],
      },
      image: { base: document.profile.image.base, base_digest: "sha256:base", final_digest: "sha256:final" },
    }
    const unused = () => Effect.fail("unexpected generator call")

    const error = await Effect.runPromise(
      Effect.flip(
        createBuildContext(
          document,
          lock,
          [checkout],
          {
            codexEntry: path.join(root, "unused-codex-entry.sh"),
            copilotEntry: path.join(root, "runtime-copilot-entry.sh"),
            finalizeCopilotSeed: path.join(root, "finalize-copilot-seed.mjs"),
          },
          root,
          unused,
          unused,
        ),
      ),
    )

    expect(error.message).toBe("source inventory mismatch: https://github.com/microsoft/hve-core.git")
  })

  it("materializes selected skills, native plugins, compatibility output, config, and prompt", async () => {
    const root = await temporaryRoot("harness-materialize-")
    await writeFile(path.join(root, "prompt.md"), "Start here\n")
    const document = await Effect.runPromise(
      parseProfile(profileSource('initial_prompt = "./prompt.md"'), path.join(root, "profile.toml")),
    )
    const directories = [await fixture(root, "skill"), await fixture(root, "native"), await fixture(root, "compat")]
    const sourceLocks: Array<SourceLock> = []
    for (const [index, request] of [
      ...document.profile.skills.map((item) => ({ kind: "skill" as const, ...item })),
      ...document.profile.plugins.map((item) => ({ kind: "plugin" as const, ...item })),
    ].entries()) {
      sourceLocks.push({
        kind: request.kind,
        ...(request.kind === "plugin" ? { adapter: request.adapter } : {}),
        repository: request.repository,
        ref: request.ref,
        select: request.select,
        commit: String(index).repeat(40),
        integrity: `sha256:${index}`,
        files: await Effect.runPromise(inventoryDirectory(directories[index]!)),
      })
    }
    const lock: ProfileLock = {
      schema: 1,
      source_date_epoch: 1784379906,
      profile_hash: profileHash(document),
      sources: sourceLocks,
      packages: {
        harness: {
          kind: "codex",
          selector: "0.144.6",
          version: "0.144.6",
          integrity: "sha256:codex",
          url: "https://example.test/codex.tar.gz",
          size: 1024,
        },
        runtime: [
          { name: "bash", version: "5.2", integrity: "sha256:bash" },
          { name: "fish", version: "3.6", integrity: "sha256:fish" },
        ],
      },
      image: { base: document.profile.image.base, base_digest: "sha256:base", final_digest: "sha256:final" },
    }
    const generator: PluginGenerator = (_source, _selection, destination) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(path.join(destination, ".codex", "skills", "compat"), { recursive: true })
          await writeFile(path.join(destination, ".codex", "skills", "compat", "SKILL.md"), "# Compat\n")
        },
        catch: (cause) => cause,
      })
    const skillGenerator: SkillGenerator = (_source, _selection, destination) =>
      Effect.tryPromise({
        try: async () => {
          await mkdir(path.join(destination, ".agents", "skills", "one"), { recursive: true })
          await writeFile(path.join(destination, ".agents", "skills", "one", "SKILL.md"), "# Generated One\n")
        },
        catch: (cause) => cause,
      })
    const runtimeEntry = path.join(root, "runtime-entry.sh")
    await writeFile(runtimeEntry, "#!/usr/bin/env bash\n")

    const context = await Effect.runPromise(
      createBuildContext(
        document,
        lock,
        directories,
        {
          codexEntry: runtimeEntry,
          copilotEntry: path.join(root, "unused-copilot-entry.sh"),
          finalizeCopilotSeed: path.join(root, "unused-finalizer.mjs"),
        },
        root,
        skillGenerator,
        generator,
      ),
    )

    expect.soft(path.basename(context)).toMatch(/^trellage-build-/)
    await expect(readFile(path.join(context, "assets", "skills", "one", "SKILL.md"), "utf8")).resolves.toBe(
      "# Generated One\n",
    )
    await expect(readFile(path.join(context, "assets", "agents", "native.toml"), "utf8")).resolves.toContain("native")
    await expect(readFile(path.join(context, "assets", "skills", "compat", "SKILL.md"), "utf8")).resolves.toBe(
      "# Compat\n",
    )
    await expect(readFile(path.join(context, "initial-prompt.md"), "utf8")).resolves.toBe("Start here\n")
    await expect(readFile(path.join(context, "build-support", "apt-get"), "utf8")).resolves.toContain(
      '/usr/bin/apt-get "$@"',
    )
    const miseLock = await readFile(path.join(context, "mise.lock"), "utf8")
    expect.soft(miseLock).toMatch(/^# @generated by Trellage profile compiler\n/)
    expect.soft(miseLock).not.toContain("# @generated by harness profile compiler")
    const allText = await Promise.all(
      ["mise.toml", "codex-config.toml", "profile.lock.toml", "initial-prompt.md"].map((file) =>
        readFile(path.join(context, file), "utf8"),
      ),
    )
    expect(allText.join("\n")).not.toContain("DO_NOT_WRITE_ME=")
  })

  it("rejects an initial prompt changed after profile validation", async () => {
    const root = await temporaryRoot("harness-materialize-prompt-change-")
    const prompt = path.join(root, "prompt.md")
    await writeFile(prompt, "Original prompt\n")
    const document = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "prompt-change"
[harness]
kind = "codex"
version = "0.144.6"
initial_prompt = "./prompt.md"
[harness.codex]
model = "gpt-5.5"
reasoning_effort = "medium"
model_provider = "proxy"
[harness.codex.providers.proxy]
base_url = "http://proxy:8080/v1"
wire_api = "responses"
[image]
platform = "linux/arm64"
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
`,
        path.join(root, "profile.toml"),
      ),
    )
    const lock: ProfileLock = {
      schema: 1,
      source_date_epoch: 1784379906,
      profile_hash: profileHash(document),
      sources: [],
      packages: {
        harness: {
          kind: "codex",
          selector: "0.144.6",
          version: "0.144.6",
          integrity: "sha256:codex",
          url: "https://example.test/codex.tar.gz",
          size: 1024,
        },
        runtime: [{ name: "bash", version: "5.2", integrity: "sha256:bash" }],
      },
      image: { base: document.profile.image.base, base_digest: "sha256:base" },
    }
    const runtimeEntry = path.join(root, "runtime-entry.sh")
    await writeFile(runtimeEntry, "#!/bin/sh\n")
    await writeFile(prompt, "Changed prompt\n")
    const unused = () => Effect.fail("unexpected generator call")

    await expect(
      Effect.runPromise(
        createBuildContext(
          document,
          lock,
          [],
          {
            codexEntry: runtimeEntry,
            copilotEntry: path.join(root, "unused-copilot-entry.sh"),
            finalizeCopilotSeed: path.join(root, "unused-finalizer.mjs"),
          },
          root,
          unused,
          unused,
        ),
      ),
    ).rejects.toThrow("initial prompt changed after profile validation; rerun profile validation and build")
  })

  it("materializes a complete verified native Copilot source without Codex or host state", async () => {
    const root = await temporaryRoot("harness-materialize-copilot-")
    await writeFile(path.join(root, "prompt.md"), "Review this repository\n")
    const document = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "copilot"
[harness]
kind = "copilot"
version = "latest"
initial_prompt = "./prompt.md"
[harness.copilot]
auth = "host-or-login"
[image]
platform = "linux/arm64"
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[plugins]]
adapter = "copilot-marketplace"
repository = "https://github.com/microsoft/hve-core.git"
ref = "main"
marketplace = "hve-core"
select = ["hve-core"]
`,
        path.join(root, "profile.toml"),
      ),
    )
    const hve = path.join(root, "verified-hve")
    await mkdir(path.join(hve, ".github", "plugin"), { recursive: true })
    await mkdir(path.join(hve, "plugins", "hve-core", "commands"), { recursive: true })
    await writeFile(
      path.join(hve, ".github", "plugin", "marketplace.json"),
      JSON.stringify({
        name: "hve-core",
        metadata: { description: "HVE Core", version: "3.3.101", pluginRoot: "./plugins" },
        owner: { name: "Microsoft" },
        plugins: [{ name: "hve-core", source: "hve-core", description: "HVE", version: "3.3.101" }],
      }),
    )
    await writeFile(path.join(hve, "plugins", "hve-core", "commands", "review.md"), "# Review\n")
    await symlink("review.md", path.join(hve, "plugins", "hve-core", "commands", "current.md"))
    const files = await Effect.runPromise(inventoryDirectory(hve, { allowSymlinks: true }))
    const lock: ProfileLock = {
      schema: 1,
      source_date_epoch: 1784379906,
      profile_hash: profileHash(document),
      sources: [
        {
          kind: "plugin",
          adapter: "copilot-marketplace",
          marketplace: "hve-core",
          plugin_versions: { "hve-core": "3.3.101" },
          repository: "https://github.com/microsoft/hve-core.git",
          ref: "main",
          select: ["hve-core"],
          commit: "a".repeat(40),
          integrity: `sha256:${"b".repeat(64)}`,
          files,
        },
      ],
      packages: {
        harness: {
          kind: "copilot",
          selector: "latest",
          version: "1.0.75",
          integrity: "sha256:0911f12dd816f612d27c4a360d4f00b62d933845a98d6c913e8d7400a69c6809",
          url: "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz",
          size: 106111479,
        },
        runtime: [],
      },
      image: { base: document.profile.image.base, base_digest: "sha256:base" },
    }
    const unused = () => Effect.fail("unexpected generator call")
    const copilotEntry = path.join(root, "runtime-copilot-entry.sh")
    const finalizer = path.join(root, "finalize-copilot-seed.mjs")
    await writeFile(copilotEntry, '#!/bin/sh\nexec copilot "$@"\n')
    await writeFile(finalizer, "// finalizer fixture\n")
    const support: RuntimeSupport = {
      codexEntry: path.join(root, "unused-codex-entry.sh"),
      copilotEntry,
      finalizeCopilotSeed: finalizer,
    }
    await writeFile(support.codexEntry, "codex fixture\n")
    const wrongHarnessSnapshot = await Effect.runPromise(createRuntimeSupportSnapshot("codex", support))
    await expect(
      Effect.runPromise(
        createBuildContext(document, lock, [hve], wrongHarnessSnapshot, root, unused, unused).pipe(Effect.flip),
      ),
    ).resolves.toMatchObject({
      _tag: "MaterializeError",
      message: "runtime support snapshot harness kind does not match profile",
    })
    const snapshot = await Effect.runPromise(createRuntimeSupportSnapshot("copilot", support))
    await writeFile(copilotEntry, "mutated after snapshot\n")
    await writeFile(finalizer, "mutated finalizer after snapshot\n")

    const context = await Effect.runPromise(createBuildContext(document, lock, [hve], snapshot, root, unused, unused))

    await expect(
      readFile(path.join(context, "hve-core", "plugins", "hve-core", "commands", "review.md"), "utf8"),
    ).resolves.toBe("# Review\n")
    await expect(
      readlink(path.join(context, "hve-core", "plugins", "hve-core", "commands", "current.md")),
    ).resolves.toBe("review.md")
    await expect(readFile(path.join(context, "runtime-copilot-entry.sh"), "utf8")).resolves.toContain("exec copilot")
    await expect(readFile(path.join(context, "finalize-copilot-seed.mjs"), "utf8")).resolves.toBe(
      "// finalizer fixture\n",
    )
    await expect(readFile(path.join(context, "initial-prompt.md"), "utf8")).resolves.toBe("Review this repository\n")
    const rendered = await readFile(path.join(context, "mise.toml"), "utf8")
    expect.soft(rendered).toContain('tag = "trellage-profile-copilot:locked"')
    expect
      .soft(rendered)
      .toContain('"/usr/local/share/trellage/initial-prompt.md" = { source = "initial-prompt.md", mode = "copy" }')
    expect.soft(rendered).not.toContain("/usr/local/share/harness")
    await expect(readFile(path.join(context, "mise.lock"), "utf8")).resolves.toContain('[[tools."http:copilot"]]')
    await expect(readFile(path.join(context, "mise.lock"), "utf8")).resolves.toContain(
      '[tools."http:copilot"."platforms.linux-arm64"]',
    )
    await expect(readFile(path.join(context, "mise.lock"), "utf8")).resolves.toContain(
      'url = "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-arm64.tar.gz"',
    )
    await expect(readFile(path.join(context, "copilot-seed", "missing"), "utf8")).rejects.toThrow()
    const contextFiles = await Effect.runPromise(inventoryDirectory(context, { allowSymlinks: true }))
    expect(contextFiles.map((entry) => entry.path)).not.toContain("codex-config.toml")
    const text = await Promise.all(
      contextFiles
        .filter((entry) => entry.kind === "file")
        .map((entry) => readFile(path.join(context, entry.path), "utf8")),
    )
    expect(text.join("\n")).not.toContain("host-or-login")
    expect(text.join("\n")).not.toContain(root)
  })

  it("materializes the locked linux-x64 Copilot asset for an amd64 profile", async () => {
    const root = await temporaryRoot("harness-materialize-copilot-amd64-")
    const document = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "copilot-amd64"
[harness]
kind = "copilot"
version = "latest"
[harness.copilot]
auth = "host-or-login"
[image]
platform = "linux/amd64"
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[plugins]]
adapter = "copilot-marketplace"
repository = "https://github.com/microsoft/hve-core.git"
ref = "main"
marketplace = "hve-core"
select = ["hve-core"]
`,
        path.join(root, "profile.toml"),
      ),
    )
    const hve = path.join(root, "verified-hve")
    await mkdir(path.join(hve, ".github", "plugin"), { recursive: true })
    await writeFile(path.join(hve, ".github", "plugin", "marketplace.json"), "{}\n")
    const files = await Effect.runPromise(inventoryDirectory(hve, { allowSymlinks: true }))
    const lock: ProfileLock = {
      schema: 1,
      source_date_epoch: 1784379906,
      profile_hash: profileHash(document),
      sources: [
        {
          kind: "plugin",
          adapter: "copilot-marketplace",
          marketplace: "hve-core",
          plugin_versions: { "hve-core": "3.3.101" },
          repository: "https://github.com/microsoft/hve-core.git",
          ref: "main",
          select: ["hve-core"],
          commit: "a".repeat(40),
          integrity: `sha256:${"b".repeat(64)}`,
          files,
        },
      ],
      packages: {
        harness: {
          kind: "copilot",
          selector: "latest",
          version: "1.0.75",
          integrity: `sha256:${"c".repeat(64)}`,
          url: "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-x64.tar.gz",
          size: 100,
        },
        runtime: [],
      },
      image: { base: document.profile.image.base, base_digest: `sha256:${"d".repeat(64)}` },
    }
    const copilotEntry = path.join(root, "runtime-copilot-entry.sh")
    const finalizer = path.join(root, "finalize-copilot-seed.mjs")
    await writeFile(copilotEntry, "#!/bin/sh\n")
    await writeFile(finalizer, "// finalizer\n")
    const unused = () => Effect.fail("unexpected generator call")

    const context = await Effect.runPromise(
      createBuildContext(
        document,
        lock,
        [hve],
        {
          codexEntry: path.join(root, "unused-codex-entry.sh"),
          copilotEntry,
          finalizeCopilotSeed: finalizer,
        },
        root,
        unused,
        unused,
      ),
    )
    const rendered = await readFile(path.join(context, "mise.lock"), "utf8")

    expect(rendered).toContain('[tools."http:copilot"."platforms.linux-x64"]')
    expect(rendered).toContain(
      'url = "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-x64.tar.gz"',
    )
    expect(rendered).not.toContain("platforms.linux-arm64")
  })
})
