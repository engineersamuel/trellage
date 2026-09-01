import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { Effect } from "effect"
import { afterEach, describe, expect, it } from "vitest"

import {
  hyperresearchSeedInstallArguments,
  managedClaudeFiles,
  materializeClaudeAssets,
  materializeChromiumArchives,
  materializeHyperresearchPackage,
  normalizeEccAccumulatorHookSessionScoping,
  normalizeHyperresearchHookInstaller,
  normalizeHyperresearchPackagePromptContracts,
  normalizeHyperresearchPromptContracts,
  normalizeHyperresearchSeed,
  normalizeHyperresearchSitePermissions,
  stampClaudeMarketplaceVersions,
  trustedHostUvArguments,
  trustedHostUvVersionMatches,
} from "../src/claude-materialize.js"
import { inventoryDirectory, verifyInventory } from "../src/inventory.js"
import { parseLock, renderLock } from "../src/lock-file.js"
import {
  createBuildContext as createBuildContextRaw,
  type ClaudeMaterializeRequest,
  type ClaudeMaterializer,
  type PluginGenerator,
  type RuntimeSupport,
} from "../src/materialize.js"
import { profileHash, type ProfileLock, type SourceLock } from "../src/lock.js"
import {
  createRuntimeSupportSnapshot as createRuntimeSupportSnapshotRaw,
  isRuntimeSupportSnapshot,
  type RuntimeSupportPaths,
} from "../src/runtime-support.js"
import { parseProfile } from "../src/profile.js"
import { createPythonConstraintsSidecar } from "../src/resolution-sidecar.js"
import { playwrightArtifacts } from "./fixtures/tool-artifacts.js"
import { cachedArtifactPath } from "../src/artifact-cache.js"

const temporaryRoots: Array<string> = []
const execFilePromise = promisify(execFile)
const managedArtifacts = [
  {
    name: "node",
    version: "24.8.0",
    integrity: `sha256:${"a".repeat(64)}`,
    url: "https://nodejs.org/dist/v24.8.0/node-v24.8.0-linux-arm64.tar.gz",
  },
  {
    name: "uv",
    version: "0.11.22",
    integrity: `sha256:${"c".repeat(64)}`,
    url: "https://github.com/astral-sh/uv/releases/download/0.11.22/uv-aarch64-unknown-linux-musl.tar.gz",
    size: 1,
  },
] as const
const pythonArtifact = {
  name: "python",
  version: "3.13.14",
  integrity: `sha256:${"e".repeat(64)}`,
  url: "https://github.com/astral-sh/python-build-standalone/releases/download/20260728/cpython-3.13.14%2B20260728-aarch64-unknown-linux-gnu-install_only_stripped.tar.gz",
  size: 1,
} as const
const rustArtifacts = [
  {
    name: "rust",
    version: "1.96.0",
    integrity: `sha256:${"4".repeat(64)}`,
    url: "https://static.rust-lang.org/dist/2026-05-28/rust-1.96.0-aarch64-unknown-linux-gnu.tar.gz",
    size: 1,
  },
  {
    name: "rust-std-musl",
    version: "1.96.0",
    integrity: `sha256:${"5".repeat(64)}`,
    url: "https://static.rust-lang.org/dist/2026-05-28/rust-std-1.96.0-aarch64-unknown-linux-musl.tar.gz",
    size: 1,
  },
] as const
const withSessionBridge = (support: RuntimeSupportPaths): RuntimeSupportPaths => ({
  ...support,
  sessionBridge: support.sessionBridge ?? path.join(path.dirname(support.codexEntry), "trellage-session-bridge.py"),
})
const createRuntimeSupportSnapshot = (
  ...[kind, support, selection, claudeMode]: Parameters<typeof createRuntimeSupportSnapshotRaw>
) => createRuntimeSupportSnapshotRaw(kind, withSessionBridge(support), selection, claudeMode)
const createBuildContext = (...arguments_: Parameters<typeof createBuildContextRaw>) => {
  const runtimeSupport = arguments_[3]
  if (typeof runtimeSupport !== "string" && !isRuntimeSupportSnapshot(runtimeSupport)) {
    arguments_[3] = withSessionBridge(runtimeSupport)
  }
  return createBuildContextRaw(...arguments_)
}
const temporaryRoot = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryRoots.push(root)
  await writeFile(path.join(root, "trellage-session-bridge.py"), "#!/usr/bin/env python3\n")
  return root
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const profileSource = (prompt = "") => `
schema = 1
name = "materialize"
description = "Materialize test profile"
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
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash", "fish"]
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

const fixture = async (root: string, kind: "native" | "compat") => {
  const directory = path.join(root, kind)
  if (kind === "native") {
    await mkdir(path.join(directory, "plugins", "native", ".codex", "agents"), { recursive: true })
    await writeFile(path.join(directory, "plugins", "native", ".codex", "agents", "native.toml"), 'name = "native"\n')
  } else {
    await mkdir(path.join(directory, "plugins", "full-stack-orchestration"), { recursive: true })
    await writeFile(path.join(directory, "plugins", "full-stack-orchestration", "plugin.txt"), "source\n")
  }
  return directory
}

describe("Hyperresearch seed normalization", () => {
  it("uses an exact isolated uv version at the trusted host-tool boundary", () => {
    expect(trustedHostUvArguments("0.12.7")).toEqual(["--no-config", "x", "uv@0.12.7", "--", "uv"])
    expect(() => trustedHostUvArguments("latest")).toThrow(/version is not exact/)
    expect(trustedHostUvVersionMatches("0.12.7", "uv 0.12.7 (abcdef 2026-08-28)")).toBe(true)
    expect(trustedHostUvVersionMatches("0.12.7", "uv 0.12.8")).toBe(false)
  })

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
      skipDangerousModePermissionPrompt: true,
      disableRemoteControl: true,
      disableClaudeAiConnectors: true,
      disableArtifact: true,
    })
  })
  it("installs every chained skill before Claude scans the global registry", () => {
    expect(hyperresearchSeedInstallArguments("/tmp/seed-home", "full")).toEqual([
      ["-m", "hyperresearch", "install", "--global", "--profile", "full"],
      ["-m", "hyperresearch", "install", "--steps-only", "/tmp/seed-home", "--profile", "full"],
    ])
  })

  it("lists the managed manifest in global C-locale order", async () => {
    const root = await temporaryRoot("trellage-hyperresearch-manifest-")
    await mkdir(path.join(root, "skills", "hyperresearch"), { recursive: true })
    await mkdir(path.join(root, "agents"), { recursive: true })
    await writeFile(path.join(root, "skills", "hyperresearch", "SKILL.md"), "skill\n")
    await writeFile(path.join(root, "agents", "hyperresearch-z.md"), "agent\n")
    await writeFile(path.join(root, "default-user-settings.json"), '{"outputStyle":"Rundown"}\n')

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

  it("makes light the default tier and enables Crawl4AI only during first-run bootstrap", async () => {
    const root = await temporaryRoot("trellage-hyperresearch-prompts-")
    const entry = path.join(root, "skills", "hyperresearch", "SKILL.md")
    const stepOne = path.join(root, "skills", "hyperresearch-1-decompose", "SKILL.md")
    await mkdir(path.dirname(entry), { recursive: true })
    await mkdir(path.dirname(stepOne), { recursive: true })
    await writeFile(
      entry,
      `\
If you're uncertain, tier up — but never silently upgrade every query to \`full\`.
- **Vault check.** If \`.hyperresearch/\` doesn't exist in the working directory, run \`hyperresearch init . --json\`. Creates the SQLite vault and \`research/\` directory.
- **Step-skills check.** If \`.claude/skills/hyperresearch-1-decompose/SKILL.md\` doesn't exist relative to the working directory, run \`hyperresearch install --steps-only . --json\`. Installs the 16 step skill files needed by \`Skill(skill: "hyperresearch-N-...")\` calls in later steps.
For a standard run, pass the installed gear (\`full\`) unless the user asked for something else.
`,
    )
    await writeFile(
      stepOne,
      `\
| \`"full"\` | Deep analysis, synthesis of conflicting evidence, defended thesis, literature review, forecast with evidence chains. | "Analyze the impact of...", "Evaluate whether...", multi-paragraph prompts, explicit request for depth/rigor, research-grade questions, contested topics |
**Default is \`"full"\`.** When uncertain, tier up. Running the full pipeline on a simple query wastes money; running the light pipeline on a complex query produces a bad report.
`,
    )

    await Effect.runPromise(normalizeHyperresearchPromptContracts(root, "light", "full"))
    const once = await Promise.all([readFile(entry, "utf8"), readFile(stepOne, "utf8")])
    await Effect.runPromise(normalizeHyperresearchPromptContracts(root, "light", "full"))
    const twice = await Promise.all([readFile(entry, "utf8"), readFile(stepOne, "utf8")])

    expect(twice).toEqual(once)
    expect(once[0]).toContain("If you're uncertain, stay `light`.")
    expect(once[0]).toContain("hyperresearch config set web.provider crawl4ai --json")
    expect(once[0]).toContain("Do not change the provider when the vault already exists.")
    expect(once[0]).toContain("Never ask the user to choose a tier")
    expect(once[0]).toContain("resolve ambiguity to `light`")
    expect(once[0]).toContain("hyperresearch install --steps-only . --profile full --json")
    expect(once[0]).toContain("before every run")
    expect(once[1]).toContain('**Default is `"light"` in Trellage.**')
    expect(once[1]).toContain("only when the user explicitly requests deep or full research")
    expect(once[1]).toContain("Do not ask the user to choose a tier")
    expect(once[1]).toContain("Do not select full only because a prompt is multi-paragraph")
    expect(once[1]).not.toContain('"Analyze the impact of..."')
  })

  it("fails closed when upstream Hyperresearch prompt contracts drift", async () => {
    const root = await temporaryRoot("trellage-hyperresearch-prompt-drift-")
    const entry = path.join(root, "skills", "hyperresearch", "SKILL.md")
    const stepOne = path.join(root, "skills", "hyperresearch-1-decompose", "SKILL.md")
    await mkdir(path.dirname(entry), { recursive: true })
    await mkdir(path.dirname(stepOne), { recursive: true })
    await writeFile(entry, "upstream changed\n")
    await writeFile(stepOne, "upstream changed\n")

    await expect(Effect.runPromise(normalizeHyperresearchPromptContracts(root, "light", "full"))).rejects.toThrow(
      /unsupported Hyperresearch prompt contract/,
    )
  })

  it("adapts packaged prompt templates used by later project-local step installs", async () => {
    const root = await temporaryRoot("trellage-hyperresearch-package-prompts-")
    const entry = path.join(root, "hyperresearch", "skills", "hyperresearch.md")
    const stepOne = path.join(root, "hyperresearch", "skills", "hyperresearch-1-decompose.md")
    await mkdir(path.dirname(entry), { recursive: true })
    await writeFile(
      entry,
      `\
If you're uncertain, tier up — but never silently upgrade every query to \`full\`.
- **Vault check.** If \`.hyperresearch/\` doesn't exist in the working directory, run \`hyperresearch init . --json\`. Creates the SQLite vault and \`research/\` directory.
- **Step-skills check.** If \`.claude/skills/hyperresearch-1-decompose/SKILL.md\` doesn't exist relative to the working directory, run \`hyperresearch install --steps-only . --json\`. Installs the 16 step skill files needed by \`Skill(skill: "hyperresearch-N-...")\` calls in later steps.
For a standard run, pass the installed gear (\`<< p.name >>\`) unless the user asked for something else.
`,
    )
    await writeFile(
      stepOne,
      `\
| \`"full"\` | Deep analysis, synthesis of conflicting evidence, defended thesis, literature review, forecast with evidence chains. | "Analyze the impact of...", "Evaluate whether...", multi-paragraph prompts, explicit request for depth/rigor, research-grade questions, contested topics |
**Default is \`"full"\`.** When uncertain, tier up. Running the full pipeline on a simple query wastes money; running the light pipeline on a complex query produces a bad report.
`,
    )

    await Effect.runPromise(normalizeHyperresearchPackagePromptContracts(root, "light"))

    await expect(readFile(entry, "utf8")).resolves.toContain("If you're uncertain, stay `light`.")
    await expect(readFile(entry, "utf8")).resolves.toContain("config set web.provider crawl4ai")
    await expect(readFile(entry, "utf8")).resolves.toContain("Never ask the user to choose a tier")
    await expect(readFile(entry, "utf8")).resolves.toContain(
      "hyperresearch install --steps-only . --profile << p.name >> --json",
    )
    await expect(readFile(stepOne, "utf8")).resolves.toContain('**Default is `"light"` in Trellage.**')
    await expect(readFile(stepOne, "utf8")).resolves.toContain(
      "Do not select full only because a prompt is multi-paragraph",
    )
  })

  it("makes project hooks portable and migrates existing absolute commands", async () => {
    const root = await temporaryRoot("trellage-hyperresearch-hooks-")
    const hooksPath = path.join(root, "hyperresearch", "core", "hooks.py")
    await mkdir(path.dirname(hooksPath), { recursive: true })
    await writeFile(
      hooksPath,
      `\
unrelated_before = "keep"
    hook_path = hook_dir / "hook.js"
    for entry in pre_tool:
        if isinstance(entry, dict):
            for h in entry.get("hooks", []):
                if "hyperresearch" in h.get("command", ""):
                    return None

    pre_tool.append({
            "command": f"node {hook_path.as_posix()}",
unrelated_after = "keep"
`,
    )

    await Effect.runPromise(normalizeHyperresearchHookInstaller(root))

    const normalized = await readFile(hooksPath, "utf8")
    expect(normalized).toContain('hook_path = hook_dir / "hook.cjs"')
    expect(normalized).toContain(`hook_command = 'node "$CLAUDE_PROJECT_DIR/.hyperresearch/hook.cjs"'`)
    expect(normalized).toContain('if "hyperresearch" not in command:')
    expect(normalized).toContain("if command == hook_command:")
    expect(normalized).toContain('h["command"] = hook_command')
    expect(normalized).toContain('"command": hook_command,')
    expect(normalized).toContain('settings_path.write_text(json.dumps(settings, indent=2) + "\\n", encoding="utf-8")')
    expect(normalized).toContain('unrelated_before = "keep"')
    expect(normalized).toContain('unrelated_after = "keep"')
    expect(normalized).not.toContain("hook_path.as_posix()")
  })

  it("leaves an already-portable project hook installer byte-identical", async () => {
    const root = await temporaryRoot("trellage-hyperresearch-portable-hooks-")
    const hooksPath = path.join(root, "hyperresearch", "core", "hooks.py")
    const portable = `\
    hook_path = hook_dir / "hook.cjs"
    hook_command = 'node "$CLAUDE_PROJECT_DIR/.hyperresearch/hook.cjs"'
                command = h.get("command", "")
                if "hyperresearch" not in command:
                    continue
                if command == hook_command:
                    return None
                h["command"] = hook_command
            "command": hook_command,
`
    await mkdir(path.dirname(hooksPath), { recursive: true })
    await writeFile(hooksPath, portable)

    await Effect.runPromise(normalizeHyperresearchHookInstaller(root))
    await Effect.runPromise(normalizeHyperresearchHookInstaller(root))

    await expect(readFile(hooksPath, "utf8")).resolves.toBe(portable)
  })

  it("fails closed when the upstream project hook installer drifts", async () => {
    const root = await temporaryRoot("trellage-hyperresearch-drifted-hooks-")
    const hooksPath = path.join(root, "hyperresearch", "core", "hooks.py")
    await mkdir(path.dirname(hooksPath), { recursive: true })
    await writeFile(hooksPath, 'def _install_claude_hook():\n    command = "python hook.py"\n')

    await expect(Effect.runPromise(normalizeHyperresearchHookInstaller(root))).rejects.toMatchObject({
      message:
        "cannot normalize Hyperresearch project hook installer: unsupported Hyperresearch project hook installer source",
    })
  })

  it("materializes the locked pure-Python package without fetching build dependencies", async () => {
    const root = await temporaryRoot("trellage-hyperresearch-package-")
    const source = path.join(root, "source")
    const sitePackages = path.join(root, "site-packages")
    const executable = path.join(root, "venv", "bin", "hyperresearch")
    await mkdir(path.join(source, "src", "hyperresearch", "core"), { recursive: true })
    await mkdir(sitePackages, { recursive: true })
    await mkdir(path.dirname(executable), { recursive: true })
    await writeFile(path.join(source, "src", "hyperresearch", "__main__.py"), "print('ready')\n")
    await writeFile(
      path.join(source, "src", "hyperresearch", "core", "hooks.py"),
      `\
    hook_path = hook_dir / "hook.js"
    for entry in pre_tool:
        if isinstance(entry, dict):
            for h in entry.get("hooks", []):
                if "hyperresearch" in h.get("command", ""):
                    return None

    pre_tool.append({
            "command": f"node {hook_path.as_posix()}",
`,
    )

    await Effect.runPromise(materializeHyperresearchPackage(source, sitePackages, executable))

    await expect(readFile(path.join(sitePackages, "hyperresearch", "__main__.py"), "utf8")).resolves.toBe(
      "print('ready')\n",
    )
    await expect(readFile(executable, "utf8")).resolves.toBe(
      '#!/bin/sh\nexec "$(dirname "$0")/python" -m hyperresearch "$@"\n',
    )
  })

  it("makes generated site packages readable while preserving executable files", async () => {
    const root = await temporaryRoot("trellage-hyperresearch-permissions-")
    const packageDirectory = path.join(root, "site-packages", "litellm")
    const module = path.join(packageDirectory, "__init__.py")
    const executable = path.join(packageDirectory, "launcher")
    await mkdir(packageDirectory, { recursive: true, mode: 0o700 })
    await writeFile(module, "", { mode: 0o600 })
    await writeFile(executable, "", { mode: 0o700 })

    await Effect.runPromise(normalizeHyperresearchSitePermissions(path.join(root, "site-packages")))

    expect((await stat(path.join(root, "site-packages"))).mode & 0o777).toBe(0o755)
    expect((await stat(packageDirectory)).mode & 0o777).toBe(0o755)
    expect((await stat(module)).mode & 0o777).toBe(0o644)
    expect((await stat(executable)).mode & 0o777).toBe(0o755)
  })
})

describe("native Claude marketplace materialization", () => {
  it("copies and scopes the verified ECC source, prefers its npm lock, and creates common seed settings", async () => {
    const root = await temporaryRoot("trellage-claude-marketplace-materialize-")
    const source = path.join(root, "source")
    const context = path.join(root, "context")
    await mkdir(path.join(source, ".claude-plugin"), { recursive: true })
    await mkdir(path.join(source, "skills", "writer"), { recursive: true })
    await mkdir(context)
    await writeFile(
      path.join(source, ".claude-plugin", "marketplace.json"),
      `${JSON.stringify({
        name: "ecc",
        owner: { name: "ECC" },
        plugins: [
          {
            name: "ecc",
            source: "./",
            description: "Everything Claude Code",
            version: "1.0.0",
          },
        ],
      })}\n`,
    )
    await writeFile(path.join(source, "skills", "writer", "SKILL.md"), "# Writer\n")
    await writeFile(path.join(source, "package.json"), '{"name":"ecc"}\n')
    await writeFile(path.join(source, "package-lock.json"), '{"lockfileVersion":3}\n')
    await writeFile(path.join(source, "yarn.lock"), "source yarn lock\n")
    await writeFile(path.join(source, ".yarnrc.yml"), "nodeLinker: node-modules\n")
    await writeEccHookFixture(source, { accumulator: upstreamEccAccumulatorHook, stop: upstreamEccStopHook })
    const files = await Effect.runPromise(inventoryDirectory(source))

    await Effect.runPromise(
      materializeClaudeAssets({
        adapter: "claude-marketplace",
        sourceDirectories: [source],
        context,
        lock: {
          sources: [
            {
              adapter: "claude-marketplace",
              marketplace: "ecc",
              plugin_versions: { ecc: "1.0.0" },
              select: ["ecc"],
              commit: "a".repeat(40),
              files,
            },
          ],
          packages: {
            harness: {
              kind: "claude",
              selector: "latest",
              version: "2.1.222",
              integrity: `sha256:${"a".repeat(64)}`,
              url: "https://github.com/anthropics/claude-code/releases/download/v2.1.222/claude-linux-arm64.tar.gz",
              size: 88123930,
            },
            runtime: [],
          },
        } as unknown as ProfileLock,
      }),
    )

    await expect(
      readFile(path.join(context, "claude-marketplace-0", "skills", "writer", "SKILL.md"), "utf8"),
    ).resolves.toBe("# Writer\n")
    await expect(readFile(path.join(context, "claude-marketplace-0", "package-lock.json"), "utf8")).resolves.toBe(
      '{"lockfileVersion":3}\n',
    )
    await expect(readFile(path.join(context, "claude-marketplace-0", "yarn.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(readFile(path.join(context, "claude-marketplace-0", ".yarnrc.yml"))).rejects.toMatchObject({
      code: "ENOENT",
    })
    await expect(readFile(path.join(source, "yarn.lock"), "utf8")).resolves.toBe("source yarn lock\n")
    for (const hook of ["post-edit-accumulator.js", "stop-format-typecheck.js"]) {
      const scoped = await readEccHook(path.join(context, "claude-marketplace-0"), hook)
      expect(scoped).toContain("function getAccumFile(hookSessionId) {")
      expect(scoped).toContain("function trellageHookSessionId(rawInput) {")
      expect(scoped).not.toContain("function getAccumFile() {")
    }
    await expect(readFile(path.join(context, "claude-marketplaces.json"), "utf8")).resolves.toContain(
      '"marketplace": "ecc"',
    )
    await expect(readFile(path.join(context, "claude-seed", "default-settings.json"), "utf8")).resolves.toContain(
      '"defaultMode": "bypassPermissions"',
    )
    await expect(readFile(path.join(context, "claude-seed", "default-settings.json"), "utf8")).resolves.not.toContain(
      '"outputStyle"',
    )
    await expect(readFile(path.join(context, "claude-seed", "default-user-settings.json"), "utf8")).resolves.toContain(
      '"outputStyle": "Rundown"',
    )
    await expect(readFile(path.join(context, "claude-seed", "default-onboarding.json"), "utf8")).resolves.toContain(
      '"hasCompletedOnboarding": true',
    )
    await expect(readFile(path.join(context, "hyperresearch-wrapper.sh"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("copies and verifies a Claude marketplace source that contains an in-tree skill symlink", async () => {
    const root = await temporaryRoot("trellage-claude-marketplace-symlink-")
    const source = path.join(root, "source")
    const context = path.join(root, "context")
    await mkdir(path.join(source, ".claude-plugin"), { recursive: true })
    await mkdir(path.join(source, "skills", "council"), { recursive: true })
    await mkdir(context)
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
    const files = await Effect.runPromise(inventoryDirectory(source, { allowSymlinks: true }))
    expect(files.some((entry) => entry.kind === "symlink" && entry.path === "skills/council/SKILL.md")).toBe(true)

    await Effect.runPromise(
      materializeClaudeAssets({
        adapter: "claude-marketplace",
        sourceDirectories: [source],
        context,
        lock: {
          sources: [
            {
              adapter: "claude-marketplace",
              marketplace: "council",
              plugin_versions: { council: "1.2.0" },
              select: ["council"],
              commit: "c".repeat(40),
              files,
            },
          ],
          packages: {
            harness: {
              kind: "claude",
              selector: "latest",
              version: "2.1.222",
              integrity: `sha256:${"a".repeat(64)}`,
              url: "https://github.com/anthropics/claude-code/releases/download/v2.1.222/claude-linux-arm64.tar.gz",
              size: 88123930,
            },
            runtime: [],
          },
        } as unknown as ProfileLock,
      }),
    )

    const copied = path.join(context, "claude-marketplace-0")
    // Stamp mutates marketplace.json after the locked inventory check; re-verify only the skill tree.
    const skillPath = path.join(copied, "skills", "council", "SKILL.md")
    expect((await lstat(skillPath)).isSymbolicLink()).toBe(true)
    await expect(readlink(skillPath)).resolves.toBe("../../SKILL.md")
    await expect(readFile(skillPath, "utf8")).resolves.toBe("# Council root skill\n")
    await expect(readFile(path.join(context, "claude-marketplaces.json"), "utf8")).resolves.toContain(
      '"marketplace": "council"',
    )
    const stamped = JSON.parse(await readFile(path.join(copied, ".claude-plugin", "marketplace.json"), "utf8")) as {
      plugins: Array<{ version?: string }>
    }
    expect(stamped.plugins[0]?.version).toBe("1.2.0")
  })

  it("excludes selected plugin MCP configuration only from the verified build-context copy", async () => {
    const root = await temporaryRoot("trellage-claude-marketplace-mcp-policy-")
    const source = path.join(root, "source")
    const context = path.join(root, "context")
    await mkdir(path.join(source, ".claude-plugin"), { recursive: true })
    await mkdir(context)
    const mcpServers = {
      "chrome-devtools": {
        command: "npx",
        args: ["-y", "chrome-devtools-mcp@latest"],
      },
    }
    await writeFile(
      path.join(source, ".claude-plugin", "marketplace.json"),
      `${JSON.stringify({
        name: "ecc",
        owner: { name: "ECC" },
        plugins: [
          {
            name: "ecc",
            source: "./",
            description: "Everything Claude Code",
            version: "2.2.0",
            mcpServers,
          },
        ],
      })}\n`,
    )
    await writeFile(
      path.join(source, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({
        name: "ecc",
        description: "Everything Claude Code",
        version: "2.2.0",
        mcpServers,
      })}\n`,
    )
    await writeFile(path.join(source, ".mcp.json"), `${JSON.stringify({ mcpServers })}\n`)
    const files = await Effect.runPromise(inventoryDirectory(source))

    await Effect.runPromise(
      materializeClaudeAssets({
        adapter: "claude-marketplace",
        sourceDirectories: [source],
        context,
        marketplaceIncludeMcp: [false],
        lock: {
          sources: [
            {
              adapter: "claude-marketplace",
              marketplace: "ecc",
              plugin_versions: { ecc: "2.2.0" },
              select: ["ecc"],
              commit: "e".repeat(40),
              files,
            },
          ],
          packages: {
            harness: {
              kind: "claude",
              selector: "latest",
              version: "2.1.222",
              integrity: `sha256:${"a".repeat(64)}`,
              url: "https://github.com/anthropics/claude-code/releases/download/v2.1.222/claude-linux-arm64.tar.gz",
              size: 88123930,
            },
            runtime: [],
          },
        } as unknown as ProfileLock,
      }),
    )

    const copied = path.join(context, "claude-marketplace-0")
    await expect(readFile(path.join(copied, ".mcp.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" })
    const copiedMarketplace = JSON.parse(
      await readFile(path.join(copied, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as { plugins: Array<Record<string, unknown>> }
    expect(copiedMarketplace.plugins[0]).not.toHaveProperty("mcpServers")
    const copiedPlugin = JSON.parse(
      await readFile(path.join(copied, ".claude-plugin", "plugin.json"), "utf8"),
    ) as Record<string, unknown>
    expect(copiedPlugin).not.toHaveProperty("mcpServers")
    await expect(readFile(path.join(source, ".mcp.json"), "utf8")).resolves.toContain("chrome-devtools-mcp@latest")
  })

  it("stamps locked plugin versions into the marketplace copy after inventory verification", async () => {
    const root = await temporaryRoot("trellage-claude-marketplace-stamp-")
    const source = path.join(root, "source")
    const context = path.join(root, "context")
    await mkdir(path.join(source, ".claude-plugin"), { recursive: true })
    await mkdir(context)
    await writeFile(
      path.join(source, ".claude-plugin", "marketplace.json"),
      `${JSON.stringify({
        name: "caveman",
        owner: { name: "Julius Brussee" },
        plugins: [
          {
            name: "caveman",
            source: "./",
            description: "Talk like caveman",
          },
        ],
      })}\n`,
    )
    await writeFile(
      path.join(source, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({
        name: "caveman",
        description: "Talk like caveman",
      })}\n`,
    )
    await writeFile(path.join(source, "SKILL.md"), "# Caveman\n")
    const files = await Effect.runPromise(inventoryDirectory(source))

    await Effect.runPromise(
      materializeClaudeAssets({
        adapter: "claude-marketplace",
        sourceDirectories: [source],
        context,
        lock: {
          sources: [
            {
              adapter: "claude-marketplace",
              marketplace: "caveman",
              plugin_versions: { caveman: "1.10.0" },
              select: ["caveman"],
              commit: "d".repeat(40),
              files,
            },
          ],
          packages: {
            harness: {
              kind: "claude",
              selector: "latest",
              version: "2.1.222",
              integrity: `sha256:${"a".repeat(64)}`,
              url: "https://github.com/anthropics/claude-code/releases/download/v2.1.222/claude-linux-arm64.tar.gz",
              size: 88123930,
            },
            runtime: [],
          },
        } as unknown as ProfileLock,
      }),
    )

    const stampedMarketplace = JSON.parse(
      await readFile(path.join(context, "claude-marketplace-0", ".claude-plugin", "marketplace.json"), "utf8"),
    ) as { plugins: Array<{ name: string; version?: string }> }
    expect(stampedMarketplace.plugins).toEqual([expect.objectContaining({ name: "caveman", version: "1.10.0" })])
    const stampedPlugin = JSON.parse(
      await readFile(path.join(context, "claude-marketplace-0", ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name: string; version?: string }
    expect(stampedPlugin).toMatchObject({ name: "caveman", version: "1.10.0" })
    // Pristine source is unchanged; only the build-context copy is stamped.
    await expect(readFile(path.join(source, ".claude-plugin", "marketplace.json"), "utf8")).resolves.not.toContain(
      "1.10.0",
    )
  })

  it("rejects locked versions that conflict with marketplace metadata", async () => {
    const root = await temporaryRoot("trellage-claude-marketplace-conflict-")
    await mkdir(path.join(root, ".claude-plugin"), { recursive: true })
    await writeFile(
      path.join(root, ".claude-plugin", "marketplace.json"),
      `${JSON.stringify({
        name: "demo",
        owner: { name: "Demo" },
        plugins: [{ name: "demo", source: "./", description: "Demo", version: "1.0.0" }],
      })}\n`,
    )

    await expect(stampClaudeMarketplaceVersions(root, { demo: "9.9.9" })).rejects.toThrow(/version conflict/)
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
      url: `https://example.test/${name}.zip`,
      size: (await readFile(file)).byteLength,
    })
    const cacheHome = path.join(root, "cache")
    const artifacts = [
      await lockedArtifact("chromium", chromiumArchive),
      await lockedArtifact("chromium-headless-shell", headlessArchive),
    ]
    for (const [artifact, archive] of [
      [artifacts[0]!, chromiumArchive],
      [artifacts[1]!, headlessArchive],
    ] as const) {
      const cached = cachedArtifactPath(cacheHome, artifact.integrity)
      await mkdir(path.dirname(cached), { recursive: true })
      await writeFile(cached, await readFile(archive))
    }
    const request = {
      sourceDirectory: source,
      context,
      artifactCacheHome: cacheHome,
      requirementsPath: path.join(root, "unused-requirements.lock"),
      browserAgentPath: path.join(root, "unused-browser-agent.md"),
      lock: {
        packages: {
          artifacts,
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
  it("materializes and verifies the complete locked Debian closure for offline installation", async () => {
    const root = await temporaryRoot("trellage-materialize-debian-")
    const cacheHome = path.join(root, "cache")
    const document = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "pi-debian"
description = "Debian closure profile"
[harness]
kind = "pi"
version = "1.0.0"
[harness.pi]
implementation = "oh-my-pi"
provider = "github-copilot"
model = "gpt-5.6-terra"
auth = "host-or-login"
[image]
base = "node:bookworm-slim"
shell = "bash"
packages = ["curl"]
`,
        path.join(root, "profile.toml"),
      ),
    )
    const packageBytes = ["direct deb", "dependency deb"]
    const runtime = packageBytes.map((content, index) => ({
      name: index === 0 ? "curl" : "libdependency",
      version: index === 0 ? "1.0" : "2.0",
      integrity: `sha256:${createHash("sha256").update(content).digest("hex")}`,
      size: Buffer.byteLength(content),
      url: `https://deb.debian.org/debian/pool/${index === 0 ? "curl" : "libdependency"}.deb`,
      direct: index === 0,
    }))
    for (const [index, entry] of runtime.entries()) {
      const cached = cachedArtifactPath(cacheHome, entry.integrity)
      await mkdir(path.dirname(cached), { recursive: true })
      await writeFile(cached, packageBytes[index]!)
    }
    const lock: ProfileLock = {
      schema: 1,
      platform: "linux/arm64",
      source_date_epoch: 1784379906,
      profile_hash: profileHash(document),
      sources: [],
      packages: {
        harness: {
          kind: "pi",
          selector: "1.0.0",
          version: "1.0.0",
          integrity: `sha256:${"a".repeat(64)}`,
          url: "https://github.com/can1357/oh-my-pi/releases/download/v1.0.0/omp-linux-arm64",
          size: 1,
        },
        runtime,
        runtime_direct: ["curl"],
        runtime_closure_integrity: `sha256:${"b".repeat(64)}`,
      },
      image: { base: "node:bookworm-slim", base_digest: `sha256:${"c".repeat(64)}` },
    }
    const piEntry = path.join(root, "runtime-pi-entry.sh")
    await writeFile(piEntry, "#!/bin/sh\n")
    const unused = () => Effect.fail("unexpected generator call")

    const context = await Effect.runPromise(
      createBuildContext(
        document,
        lock,
        [],
        {
          codexEntry: path.join(root, "unused-codex.sh"),
          copilotEntry: path.join(root, "unused-copilot.sh"),
          finalizeCopilotSeed: path.join(root, "unused-finalizer.mjs"),
          piEntry,
        },
        root,
        unused,
        undefined,
        undefined,
        cacheHome,
      ),
    )

    const manifest = await readFile(path.join(context, "debian-packages", "manifest.tsv"), "utf8")
    expect(manifest).toContain("package\tcurl\t1.0")
    expect(manifest).toContain("package\tlibdependency\t2.0")
    expect(manifest).toContain(`\t${runtime[0]!.integrity.slice("sha256:".length)}\t`)
    await expect(readFile(path.join(context, "debian-packages", "0000-curl.deb"), "utf8")).resolves.toBe(
      packageBytes[0],
    )
    const aptWrapper = await readFile(path.join(context, "build-support", "apt-get"), "utf8")
    expect(aptWrapper).toContain("sha256sum --check --strict")
    expect(aptWrapper).toContain("for attempt in 1 2 3 4 5 6 7 8")
    expect(aptWrapper).toContain('chroot "$rootfs" /usr/bin/dpkg --unpack "$@"')
    expect(aptWrapper).toContain('chroot "$rootfs" /usr/bin/dpkg --configure -a >/dev/null 2>&1 || true')
    expect(aptWrapper).toContain('chroot "$rootfs" /usr/bin/dpkg --configure -a')
  })

  it("materializes the locked Headlong source and service image command", async () => {
    const root = await temporaryRoot("trellage-materialize-headlong-")
    const headlongSource = path.join(root, "headlong")
    await mkdir(path.join(headlongSource, "tools"), { recursive: true })
    await writeFile(path.join(headlongSource, "install.sh"), "#!/bin/bash\nset -euo pipefail\n")
    await writeFile(path.join(headlongSource, "tools", "headlong-init"), "#!/bin/bash\nexit 0\n")
    await chmod(path.join(headlongSource, "install.sh"), 0o755)
    await chmod(path.join(headlongSource, "tools", "headlong-init"), 0o755)
    const files = await Effect.runPromise(inventoryDirectory(headlongSource))
    const document = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "headlong"
description = "Persistent Headlong agent"
[harness]
kind = "headlong"
version = "latest"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "bash"
packages = ["bash"]
`,
        path.join(root, "profile.toml"),
      ),
    )
    const sourceIntegrity = `sha256:${createHash("sha256").update(JSON.stringify(files)).digest("hex")}`
    const lock: ProfileLock = {
      schema: 1,
      platform: "linux/arm64",
      source_date_epoch: 1784379906,
      profile_hash: profileHash(document),
      sources: [
        {
          kind: "harness",
          adapter: "headlong",
          repository: "https://github.com/laude-institute/headlong.git",
          ref: "main",
          select: [],
          commit: "a".repeat(40),
          integrity: sourceIntegrity,
          files,
        },
      ],
      packages: {
        harness: {
          kind: "headlong",
          selector: "latest",
          commit: "a".repeat(40),
          integrity: sourceIntegrity,
        },
        runtime: [{ name: "bash", version: "5.2.15", integrity: `sha256:${"d".repeat(64)}` }],
        artifacts: [...managedArtifacts, ...rustArtifacts],
      },
      image: { base: document.profile.image.base, base_digest: `sha256:${"c".repeat(64)}` },
    }
    const headlongEntry = path.join(root, "runtime-headlong-entry.sh")
    await writeFile(headlongEntry, "#!/bin/bash\nexit 0\n")
    const support: RuntimeSupport = {
      codexEntry: path.join(root, "unused-codex-entry.sh"),
      copilotEntry: path.join(root, "unused-copilot-entry.sh"),
      headlongEntry,
      finalizeCopilotSeed: path.join(root, "unused-finalizer.mjs"),
    }
    const snapshot = await Effect.runPromise(createRuntimeSupportSnapshot("headlong", support))
    const unused = () => Effect.fail("unexpected generator call")

    const context = await Effect.runPromise(
      createBuildContext(document, lock, [headlongSource], snapshot, root, unused),
    )

    await expect(readFile(path.join(context, "headlong-seed", "install.sh"), "utf8")).resolves.toContain(
      "set -euo pipefail",
    )
    await expect(readFile(path.join(context, "headlong-seed.commit"), "utf8")).resolves.toBe(`${"a".repeat(40)}\n`)
    await expect(readFile(path.join(context, "headlong-skills", "managed-skills.tsv"), "utf8")).resolves.toBe("")
    const miseConfig = await readFile(path.join(context, "mise.toml"), "utf8")
    expect(miseConfig).toContain('cmd = ["runtime-headlong-entry", "service"]')
    expect(miseConfig).toContain(
      '"/usr/local/share/trellage/headlong-seed" = { source = "headlong-seed", mode = "copy" }',
    )
    expect(miseConfig).toContain('"dev.trellage.headlong.commit" = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"')
    const miseLock = await readFile(path.join(context, "mise.lock"), "utf8")
    expect(miseLock).not.toContain("http:headlong")
    expect(miseLock).toContain("[[tools.uv]]")
  })

  it("materializes the Pi runtime seed before floating skill injection", async () => {
    const root = await temporaryRoot("trellage-materialize-pi-")
    const document = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "pi-oh-my-pi"
description = "Oh My Pi profile"
skill_bundles = ["pi-oh-my-pi"]
[harness]
kind = "pi"
version = "latest"
args = ["--yolo"]
[harness.pi]
implementation = "oh-my-pi"
provider = "github-copilot"
model = "gpt-5.6-terra"
auth = "host-or-login"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
`,
        path.join(root, "profile.toml"),
      ),
    )
    const lock: ProfileLock = {
      schema: 1,
      platform: "linux/arm64",
      source_date_epoch: 1784379906,
      profile_hash: profileHash(document),
      sources: [],
      packages: {
        harness: {
          kind: "pi",
          selector: "latest",
          version: "17.2.6",
          integrity: "sha256:65cd7f5e7d537b0b41f277191c1b95b53d509f8147c3d1bd508503dc048f1453",
          url: "https://github.com/can1357/oh-my-pi/releases/download/v17.2.6/omp-linux-arm64",
          size: 157526160,
        },
        runtime: [{ name: "bash", version: "5.2.15", integrity: `sha256:${"d".repeat(64)}` }],
      },
      image: {
        base: document.profile.image.base,
        base_digest: `sha256:${"b".repeat(64)}`,
      },
    }
    const piEntry = path.join(root, "runtime-pi-entry.sh")
    await writeFile(piEntry, '#!/bin/bash\nexec omp "$@"\n')
    const support: RuntimeSupport = {
      codexEntry: path.join(root, "unused-codex-entry.sh"),
      copilotEntry: path.join(root, "unused-copilot-entry.sh"),
      piEntry,
      finalizeCopilotSeed: path.join(root, "unused-finalizer.mjs"),
    }
    const snapshot = await Effect.runPromise(createRuntimeSupportSnapshot("pi", support))
    await writeFile(piEntry, "mutated after snapshot\n")
    const unused = () => Effect.fail("unexpected generator call")

    const context = await Effect.runPromise(createBuildContext(document, lock, [], snapshot, root, unused))

    await expect(readFile(path.join(context, "runtime-pi-entry.sh"), "utf8")).resolves.toContain('exec omp "$@"')
    await expect(readFile(path.join(context, "pi-config.yml"), "utf8")).resolves.toBe(
      "startup:\n  checkUpdate: false\nmarketplace:\n  autoUpdate: off\n",
    )
    await expect(readFile(path.join(context, "pi-seed", "managed-skills.txt"), "utf8")).resolves.toBe("")
    await expect(
      readFile(path.join(context, "pi-seed", "skills", "semantic-compression", "SKILL.md"), "utf8"),
    ).rejects.toThrow()
    const miseConfig = await readFile(path.join(context, "mise.toml"), "utf8")
    expect(miseConfig).toContain('rename_exe = "omp"')
    expect(miseConfig).toContain('PI_CODING_AGENT_DIR = "/home/agent/.omp/agent"')
    expect(miseConfig).toContain('OMP_SKIP_SETUP = "1"')
    expect(miseConfig).toContain('"/usr/local/share/trellage/pi-seed" = { source = "pi-seed", mode = "copy" }')
    expect(miseConfig).toContain('"dev.trellage.pi.implementation" = "oh-my-pi"')
    expect(miseConfig).toContain('"dev.trellage.pi.version" = "17.2.6"')
    const miseLock = await readFile(path.join(context, "mise.lock"), "utf8")
    expect(miseLock).toContain('[[tools."http:pi"]]')
    expect(miseLock).toContain('rename_exe = "omp"')
    expect(miseLock).toContain('url = "https://github.com/can1357/oh-my-pi/releases/download/v17.2.6/omp-linux-arm64"')
  })

  it("materializes the Prime wrapper and provider seed before floating skill injection", async () => {
    const root = await temporaryRoot("trellage-materialize-prime-")
    const document = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "prime-agent"
description = "Prime Agent profile"
skill_bundles = ["sandbox-common"]
[harness]
kind = "prime"
version = "latest"
[harness.prime]
provider = "copilot-proxy-rs"
model = "claude-opus-5"
base_url = "http://copilot-proxy-rs:8080"
api = "anthropic-messages"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash", "gh", "git"]
`,
        path.join(root, "profile.toml"),
      ),
    )
    const lock: ProfileLock = {
      schema: 1,
      platform: "linux/arm64",
      source_date_epoch: 1784379906,
      profile_hash: profileHash(document),
      sources: [],
      packages: {
        harness: {
          kind: "prime",
          selector: "latest",
          version: "0.7.0",
          integrity: "sha256:88b6578518c72cd51a825bc80f28e0fef9a64c67de4a7d6fd7afd7ca1b34da0b",
          url: "https://pub-728493de92a943e2a9b2d17b4719f318.r2.dev/releases/v0.7.0/prime-agent-0.7.0.tgz",
          size: 9323789,
        },
        runtime: [],
        artifacts: managedArtifacts,
      },
      image: { base: document.profile.image.base, base_digest: `sha256:${"b".repeat(64)}` },
    }
    const primeEntry = path.join(root, "runtime-prime-entry.sh")
    await writeFile(primeEntry, '#!/bin/bash\nexec prime-agent "$@"\n')
    const support: RuntimeSupport = {
      codexEntry: path.join(root, "unused-codex-entry.sh"),
      copilotEntry: path.join(root, "unused-copilot-entry.sh"),
      primeEntry,
      finalizeCopilotSeed: path.join(root, "unused-finalizer.mjs"),
    }
    const snapshot = await Effect.runPromise(createRuntimeSupportSnapshot("prime", support))
    const unused = () => Effect.fail("unexpected generator call")

    const context = await Effect.runPromise(createBuildContext(document, lock, [], snapshot, root, unused))

    await expect(readFile(path.join(context, "runtime-prime-entry.sh"), "utf8")).resolves.toContain(
      'exec prime-agent "$@"',
    )
    const wrapper = path.join(context, "prime-agent-wrapper.sh")
    await expect(readFile(wrapper, "utf8")).resolves.toBe(
      '#!/bin/sh\nexec /mise/installs/node/24.8.0/bin/node /usr/local/lib/node_modules/prime-agent/dist/bundle/cli.js "$@"\n',
    )
    expect((await stat(wrapper)).mode & 0o777).toBe(0o755)
    await expect(readFile(path.join(context, "prime-seed", "models.json"), "utf8")).resolves.toBe(
      `${JSON.stringify(
        {
          providers: {
            "copilot-proxy-rs": {
              baseUrl: "http://copilot-proxy-rs:8080",
              api: "anthropic-messages",
              apiKey: "trellage-local-proxy",
              compat: { supportsEagerToolInputStreaming: false },
              models: [{ id: "claude-opus-5" }],
            },
          },
        },
        null,
        2,
      )}\n`,
    )
    await expect(readFile(path.join(context, "prime-seed", "skills", "one", "SKILL.md"), "utf8")).rejects.toThrow()
    await expect(readFile(path.join(context, "prime-seed", "APPEND_SYSTEM.md"), "utf8")).rejects.toThrow()
    await expect(readFile(path.join(context, "prime-seed", "managed-skills.txt"), "utf8")).resolves.toBe("")
    const miseConfig = await readFile(path.join(context, "mise.toml"), "utf8")
    expect(miseConfig).toContain(
      '"/usr/local/lib/node_modules" = { source = "prime-agent-prefix/lib/node_modules", mode = "copy" }',
    )
    expect(miseConfig).toContain('PRIME_AGENT_CODING_AGENT_DIR = "/home/agent/.prime/agent"')
    const miseLock = await readFile(path.join(context, "mise.lock"), "utf8")
    expect(miseLock).toContain("[[tools.node]]")
    expect(miseLock).toContain(`checksum = "sha256:${"a".repeat(64)}"`)
    expect(miseLock).not.toMatch(/http:prime|prime-agent-0\.7\.0\.tgz/)
  })

  it("materializes a source-free Claude core lane without Python or browser tooling", async () => {
    const root = await temporaryRoot("trellage-materialize-claude-core-")
    const document = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "claude-qwen-local"
description = "Claude Qwen local profile"
[harness]
kind = "claude"
version = "2.1.218"
[harness.claude]
mode = "core"
default_auth = "proxy"
model = "qwen3.6-35b-a3b-local"
gateway = "http://copilot-proxy-rs:8080"
opus_model = "qwen3.6-35b-a3b-local"
sonnet_model = "qwen3.6-35b-a3b-local"
haiku_model = "qwen3.6-35b-a3b-local"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "bash"
packages = ["bash", "ca-certificates", "git", "jq"]
`,
        path.join(root, "profile.toml"),
      ),
    )
    const lock: ProfileLock = {
      schema: 1,
      platform: "linux/arm64",
      source_date_epoch: 1784379906,
      profile_hash: profileHash(document),
      sources: [],
      packages: {
        harness: {
          kind: "claude",
          selector: "2.1.218",
          version: "2.1.218",
          integrity: `sha256:${"a".repeat(64)}`,
          url: "https://github.com/anthropics/claude-code/releases/download/v2.1.218/claude-linux-arm64.tar.gz",
          size: 88123930,
        },
        runtime: [],
        artifacts: ["node", "builder-oci", "skopeo-oci"].map((name) => ({
          name,
          version: "1.0.0",
          integrity: `sha256:${"b".repeat(64)}`,
          url: "https://example.test/artifact",
          size: 1,
        })),
      },
      image: { base: document.profile.image.base, base_digest: `sha256:${"c".repeat(64)}` },
    }
    const claudeEntry = path.join(root, "runtime-claude-entry.sh")
    await writeFile(claudeEntry, "#!/bin/sh\n")
    const claudeOutputStyleRundown = path.join(root, "output-style-rundown.md")
    await writeFile(claudeOutputStyleRundown, "---\nname: Rundown\n---\n")
    const unused = () => Effect.fail("unexpected generator call")
    let materializerCalled = false

    const context = await Effect.runPromise(
      createBuildContext(
        document,
        lock,
        [],
        {
          codexEntry: path.join(root, "unused-codex-entry.sh"),
          copilotEntry: path.join(root, "unused-copilot-entry.sh"),
          piEntry: path.join(root, "unused-pi-entry.sh"),
          finalizeCopilotSeed: path.join(root, "unused-finalizer.mjs"),
          claudeEntry,
          claudeOutputStyleRundown,
        },
        root,
        unused,
        () => {
          materializerCalled = true
          return Effect.void
        },
      ),
    )

    expect(materializerCalled).toBe(false)
    await expect(readFile(path.join(context, "claude-seed", "output-styles", "rundown.md"), "utf8")).resolves.toContain(
      "name: Rundown",
    )
    await expect(readFile(path.join(context, "claude-seed", "managed-paths.txt"), "utf8")).resolves.toContain(
      "output-styles/rundown.md",
    )
    await expect(readFile(path.join(context, "claude-seed", "default-settings.json"), "utf8")).resolves.toContain(
      '"bypassPermissions"',
    )
    await expect(readFile(path.join(context, "claude-seed", "default-settings.json"), "utf8")).resolves.not.toContain(
      '"outputStyle"',
    )
    await expect(readFile(path.join(context, "claude-seed", "default-user-settings.json"), "utf8")).resolves.toContain(
      '"outputStyle": "Rundown"',
    )
    await expect(readFile(path.join(context, "claude-seed", "default-onboarding.json"), "utf8")).resolves.toContain(
      '"lastOnboardingVersion": "2.1.218"',
    )
    const mise = await readFile(path.join(context, "mise.toml"), "utf8")
    const miseLock = await readFile(path.join(context, "mise.lock"), "utf8")
    expect(`${mise}\n${miseLock}`).toContain('python = "3.13.14"')
    expect(miseLock).toContain("[[tools.python]]")
    expect(`${mise}\n${miseLock}`).not.toMatch(/playwright|chromium|obscura|hyperresearch/i)
  })

  it("delegates Claude Hyperresearch assets to the focused materializer", async () => {
    const root = await temporaryRoot("trellage-materialize-claude-")
    const document = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "claude-research"
description = "Claude materialize profile"
[harness]
kind = "claude"
version = "2.1.218"
[harness.claude]
default_auth = "proxy"
model = "claude-opus-5"
gateway = "http://copilot-proxy-rs:8080"
[image]
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[plugins]]
adapter = "hyperresearch"
repository = "https://github.com/jordan-gibbs/hyperresearch.git"
ref = "main"
select = ["light"]
gear = "full"
`,
        path.join(root, "profile.toml"),
      ),
    )
    const checkout = path.join(root, "hyperresearch")
    await mkdir(checkout)
    await writeFile(path.join(checkout, "pyproject.toml"), '[project]\nname = "hyperresearch"\nversion = "0.9.1"\n')
    const files = await Effect.runPromise(inventoryDirectory(checkout))
    const cacheHome = path.join(root, "cache")
    const exactPlaywrightArtifacts = await Promise.all(
      playwrightArtifacts.map(async (artifact) => {
        if (!artifact.url.startsWith("npm:")) return artifact
        const content = `${artifact.name} package`
        const integrity = `sha256:${createHash("sha256").update(content).digest("hex")}`
        const cached = cachedArtifactPath(cacheHome, integrity)
        await mkdir(path.dirname(cached), { recursive: true })
        await writeFile(cached, content)
        return { ...artifact, integrity, size: Buffer.byteLength(content) }
      }),
    )
    const lock: ProfileLock = {
      schema: 1,
      platform: "linux/arm64",
      source_date_epoch: 1784379906,
      profile_hash: profileHash(document),
      sources: [
        {
          kind: "plugin",
          adapter: "hyperresearch",
          package_version: "0.9.1",
          repository: "https://github.com/jordan-gibbs/hyperresearch.git",
          ref: "main",
          select: ["light"],
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
        artifacts: [pythonArtifact, ...managedArtifacts, ...exactPlaywrightArtifacts],
      },
      image: { base: document.profile.image.base, base_digest: `sha256:${"b".repeat(64)}` },
    }
    const entry = path.join(root, "runtime-claude-entry.sh")
    const requirements = path.join(root, "requirements.lock")
    const browserAgent = path.join(root, "browser-agent.md")
    const claudeFinalizer = path.join(root, "finalize-claude-seed.mjs")
    await writeFile(entry, "#!/bin/sh\n")
    await writeFile(requirements, "pydantic==2.13.4 --hash=sha256:test\n")
    await writeFile(browserAgent, "browser adapter\n")
    await writeFile(claudeFinalizer, "// finalizer\n")
    const outputStyle = path.join(root, "output-style-rundown.md")
    await writeFile(outputStyle, "---\nname: Rundown\n---\n")
    const calls: Array<{
      readonly sourceDirectories: ReadonlyArray<string>
      readonly hyperresearchGear: ClaudeMaterializeRequest["hyperresearchGear"]
      readonly hyperresearchDefaultTier: ClaudeMaterializeRequest["hyperresearchDefaultTier"]
    }> = []
    const materializeClaude: ClaudeMaterializer = (request) =>
      Effect.tryPromise({
        try: async () => {
          calls.push({
            sourceDirectories: request.sourceDirectories,
            hyperresearchGear: request.hyperresearchGear,
            hyperresearchDefaultTier: request.hyperresearchDefaultTier,
          })
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
          finalizeClaudeSeed: claudeFinalizer,
          claudeEntry: entry,
          claudeBrowserAgent: browserAgent,
          claudeOutputStyleRundown: outputStyle,
        },
        root,
        unused,
        materializeClaude,
        createPythonConstraintsSidecar(profileHash(document), "linux/arm64", await readFile(requirements, "utf8")),
        cacheHome,
        "https://packagefeedproxy.microsoft.io/npm/",
      ),
    )

    expect(calls).toEqual([
      {
        sourceDirectories: [checkout],
        hyperresearchGear: "full",
        hyperresearchDefaultTier: "light",
      },
    ])
    await expect(readFile(path.join(context, "runtime-claude-entry.sh"), "utf8")).resolves.toBe("#!/bin/sh\n")
    await expect(readFile(path.join(context, "hyperresearch-wrapper.sh"), "utf8")).resolves.toBe("#!/bin/sh\n")
    const miseLock = await readFile(path.join(context, "mise.lock"), "utf8")
    expect(miseLock).toContain("[[tools.python]]")
    expect(miseLock).toContain("[[tools.uv]]")
    expect(miseLock).toContain('[[tools."http:claude"]]')
    expect(miseLock).toContain('rename_exe = "claude"')
    await expect(readFile(path.join(context, "npm-artifacts", "playwright-mcp.tgz"), "utf8")).resolves.toBe(
      "playwright-mcp package",
    )
    await expect(readFile(path.join(context, "npm-artifacts", "playwright.tgz"), "utf8")).resolves.toBe(
      "playwright package",
    )
    await expect(readFile(path.join(context, "npm-artifacts", "playwright-core.tgz"), "utf8")).resolves.toBe(
      "playwright-core package",
    )
    await expect(readFile(path.join(context, "playwright-mcp-wrapper.sh"), "utf8")).resolves.toContain(
      "@playwright/mcp/cli.js",
    )
  })
  it("materializes a legacy Codex plugin lock from a self-verified executable source", async () => {
    const root = await temporaryRoot("harness-materialize-legacy-codex-")
    const document = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "legacy-codex"
description = "Legacy Codex materialize profile"
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
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
[[plugins]]
adapter = "codex-native"
repository = "https://github.com/example/plugins.git"
ref = "v1"
select = ["one"]
`,
        path.join(root, "profile.toml"),
      ),
    )
    const checkout = path.join(root, "checkout")
    const executable = path.join(checkout, "plugins", "one", ".codex", "agents", "one.toml")
    await mkdir(path.dirname(executable), { recursive: true })
    await writeFile(executable, 'name = "one"\n')
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
      platform: "linux/arm64",
      source_date_epoch: 1784379906,
      profile_hash: profileHash(document),
      sources: [
        {
          kind: "plugin",
          adapter: "codex-native",
          repository: "https://github.com/example/plugins.git",
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
    const unusedPlugin: PluginGenerator = () => Effect.fail("unexpected plugin generator call")

    const parsedLock = await Effect.runPromise(
      parseLock(`
schema = 1
platform = "linux/arm64"
source_date_epoch = 1784379906
profile_hash = ${JSON.stringify(lock.profile_hash)}

[[sources]]
kind = "plugin"
adapter = "codex-native"
repository = "https://github.com/example/plugins.git"
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
        unusedPlugin,
      ),
    )

    await expect(readFile(path.join(context, "assets", "agents", "one.toml"), "utf8")).resolves.toBe('name = "one"\n')
  })

  it("does not let legacy alternate integrity disable modern Codex mode checks", async () => {
    const root = await temporaryRoot("harness-materialize-modern-codex-mode-")
    const document = await Effect.runPromise(parseProfile(profileSource(), path.join(root, "profile.toml")))
    const directories = [await fixture(root, "native"), await fixture(root, "compat")]
    const sourceLocks: Array<SourceLock> = []
    for (const [index, request] of document.profile.plugins
      .map((item) => ({ kind: "plugin" as const, ...item }))
      .entries()) {
      const files = await Effect.runPromise(inventoryDirectory(directories[index]!))
      sourceLocks.push({
        kind: request.kind,
        adapter: request.adapter,
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
    await chmod(path.join(directories[0]!, "plugins", "native", ".codex", "agents", "native.toml"), 0o755)
    const lock: ProfileLock = {
      schema: 1,
      platform: "linux/arm64",
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
        artifacts: [managedArtifacts[1]!],
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
        ),
      ),
    )

    expect(error.message).toBe("source inventory mismatch: https://github.com/example/native.git")
  })

  it("rejects an unexpected executable bit for Copilot even with legacy-shaped source integrity", async () => {
    const root = await temporaryRoot("harness-materialize-copilot-legacy-mode-")
    const document = await Effect.runPromise(
      parseProfile(
        `
schema = 1
name = "copilot-legacy-mode"
description = "Legacy Copilot materialize profile"
[harness]
kind = "copilot"
version = "latest"
[harness.copilot]
auth = "host-or-login"
[image]
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
      platform: "linux/arm64",
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
        ),
      ),
    )

    expect(error.message).toBe("source inventory mismatch: https://github.com/microsoft/hve-core.git")
  })

  it("materializes native plugins, compatibility output, config, and prompt", async () => {
    const root = await temporaryRoot("harness-materialize-")
    await writeFile(path.join(root, "prompt.md"), "Start here\n")
    const document = await Effect.runPromise(
      parseProfile(profileSource('initial_prompt = "./prompt.md"'), path.join(root, "profile.toml")),
    )
    const directories = [await fixture(root, "native"), await fixture(root, "compat")]
    const sourceLocks: Array<SourceLock> = []
    for (const [index, request] of document.profile.plugins
      .map((item) => ({ kind: "plugin" as const, ...item }))
      .entries()) {
      sourceLocks.push({
        kind: request.kind,
        adapter: request.adapter,
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
      platform: "linux/arm64",
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
        artifacts: [managedArtifacts[1]!],
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
        generator,
      ),
    )

    expect.soft(path.basename(context)).toMatch(/^trellage-build-/)
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
    expect.soft(miseLock).toContain("[[tools.uv]]")
    expect.soft(miseLock).not.toContain("# @generated by harness profile compiler")
    expect.soft(miseLock).toContain("[[tools.python]]")
    await expect(
      readFile(path.join(context, ".runtime-support", "trellage-session-bridge"), "utf8"),
    ).resolves.toContain("#!/usr/bin/env python3")
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
description = "Prompt change profile"
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
base = "node:22.17.0-bookworm-slim"
shell = "fish"
packages = ["bash"]
`,
        path.join(root, "profile.toml"),
      ),
    )
    const lock: ProfileLock = {
      schema: 1,
      platform: "linux/arm64",
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
description = "Copilot materialize profile"
[harness]
kind = "copilot"
version = "latest"
initial_prompt = "./prompt.md"
[harness.copilot]
auth = "host-or-login"
[image]
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
      platform: "linux/arm64",
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
        artifacts: [
          {
            name: "node",
            version: "24.8.0",
            integrity: `sha256:${"c".repeat(64)}`,
            url: "https://nodejs.org/dist/v24.8.0/node-v24.8.0-linux-arm64.tar.gz",
          },
        ],
      },
      image: { base: document.profile.image.base, base_digest: "sha256:base" },
    }
    const unused = () => Effect.fail("unexpected generator call")
    const copilotEntry = path.join(root, "runtime-copilot-entry.sh")
    const finalizer = path.join(root, "finalize-copilot-seed.mjs")
    await writeFile(copilotEntry, '#!/bin/sh\nexec copilot "$@"\n')
    await writeFile(finalizer, "// finalizer fixture\n")
    const instruction = path.join(root, "instruction-rundown.md")
    await writeFile(instruction, '---\napplyTo: "**"\n---\n')
    const support: RuntimeSupport = {
      codexEntry: path.join(root, "unused-codex-entry.sh"),
      copilotEntry,
      finalizeCopilotSeed: finalizer,
      copilotInstructionRundown: instruction,
    }
    await writeFile(support.codexEntry, "codex fixture\n")
    const wrongHarnessSnapshot = await Effect.runPromise(createRuntimeSupportSnapshot("codex", support))
    await expect(
      Effect.runPromise(
        createBuildContext(document, lock, [hve], wrongHarnessSnapshot, root, unused).pipe(Effect.flip),
      ),
    ).resolves.toMatchObject({
      _tag: "MaterializeError",
      message: "runtime support snapshot harness kind does not match profile",
    })
    const snapshot = await Effect.runPromise(createRuntimeSupportSnapshot("copilot", support))
    await writeFile(copilotEntry, "mutated after snapshot\n")
    await writeFile(finalizer, "mutated finalizer after snapshot\n")

    const context = await Effect.runPromise(createBuildContext(document, lock, [hve], snapshot, root, unused))

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
    await expect(readFile(path.join(context, "mise.lock"), "utf8")).resolves.toContain("[[tools.python]]")
    await expect(
      readFile(path.join(context, ".runtime-support", "trellage-session-bridge"), "utf8"),
    ).resolves.toContain("#!/usr/bin/env python3")
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
description = "Copilot AMD64 materialize profile"
[harness]
kind = "copilot"
version = "latest"
[harness.copilot]
auth = "host-or-login"
[image]
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
      platform: "linux/amd64",
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
        artifacts: [
          {
            name: "node",
            version: "24.8.0",
            integrity: `sha256:${"e".repeat(64)}`,
            url: "https://nodejs.org/dist/v24.8.0/node-v24.8.0-linux-x64.tar.gz",
          },
        ],
      },
      image: { base: document.profile.image.base, base_digest: `sha256:${"d".repeat(64)}` },
    }
    const copilotEntry = path.join(root, "runtime-copilot-entry.sh")
    const finalizer = path.join(root, "finalize-copilot-seed.mjs")
    await writeFile(copilotEntry, "#!/bin/sh\n")
    await writeFile(finalizer, "// finalizer\n")
    const instruction = path.join(root, "instruction-rundown.md")
    await writeFile(instruction, '---\napplyTo: "**"\n---\n')
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
          copilotInstructionRundown: instruction,
        },
        root,
        unused,
      ),
    )
    await expect(
      readFile(path.join(context, "copilot-seed", "instructions", "rundown.instructions.md"), "utf8"),
    ).resolves.toContain('applyTo: "**"')
    const rendered = await readFile(path.join(context, "mise.lock"), "utf8")

    expect(rendered).toContain('[tools."http:copilot"."platforms.linux-x64"]')
    expect(rendered).toContain('[tools.python."platforms.linux-x64"]')
    expect(rendered).toContain('checksum = "sha256:6734c3e643c75e860c36ee3a7904e8e6bafbf3232d89b17ffd5fbfa72ab2816c"')
    expect(rendered).toContain(
      'url = "https://github.com/github/copilot-cli/releases/download/v1.0.75/copilot-linux-x64.tar.gz"',
    )
    expect(rendered).not.toContain("platforms.linux-arm64")
  })
})

/**
 * Faithful replica of ECC's upstream PostToolUse accumulator hook: every region
 * the Trellage normalizer anchors on is byte-identical to the shipped script, so
 * the fixture doubles as a runnable script for the isolation assertions below.
 */
const upstreamEccAccumulatorHook = `\
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_STDIN = 1024 * 1024;

function getAccumFile() {
  const raw =
    process.env.CLAUDE_SESSION_ID ||
    crypto.createHash('sha1').update(process.cwd()).digest('hex').slice(0, 12);
  // Strip path separators and traversal sequences so the value is safe to embed
  // directly in a filename regardless of what CLAUDE_SESSION_ID contains.
  const sessionId = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return path.join(os.tmpdir(), \`ecc-edited-\${sessionId}.txt\`);
}

const JS_TS_EXT = /\\.(ts|tsx|js|jsx)$/;

function appendPath(filePath) {
  if (filePath && JS_TS_EXT.test(filePath)) {
    fs.appendFileSync(getAccumFile(), filePath + '\\n', 'utf8');
  }
}

function run(rawInput) {
  try {
    const input = JSON.parse(rawInput);
    // Edit / Write: single file_path
    appendPath(input.tool_input?.file_path);
    // MultiEdit: array of edits, each with its own file_path
    const edits = input.tool_input?.edits;
    if (Array.isArray(edits)) {
      for (const edit of edits) appendPath(edit?.file_path);
    }
  } catch {
    // Invalid input — pass through
  }
  return rawInput;
}

module.exports = { run, MAX_STDIN };
`

/** Faithful replica of ECC's upstream Stop hook across every anchored region. */
const upstreamEccStopHook = `\
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function getAccumFile() {
  const raw =
    process.env.CLAUDE_SESSION_ID ||
    crypto.createHash('sha1').update(process.cwd()).digest('hex').slice(0, 12);
  const sessionId = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return path.join(os.tmpdir(), \`ecc-edited-\${sessionId}.txt\`);
}

function main() {
  const accumFile = getAccumFile();

  let raw;
  try {
    raw = fs.readFileSync(accumFile, 'utf8');
  } catch {
    return; // No accumulator — nothing edited this response
  }

  try { fs.unlinkSync(accumFile); } catch { /* best-effort */ }
  process.stdout.write(raw);
}

function run(rawInput) {
  try {
    main();
  } catch (err) {
    process.stderr.write(\`[Hook] stop-format-typecheck error: \${err.message}\\n\`);
  }
  return rawInput;
}

module.exports = { run };
`

const writeEccHookFixture = async (
  pluginRoot: string,
  files: { readonly accumulator?: string; readonly stop?: string },
): Promise<void> => {
  await mkdir(path.join(pluginRoot, "scripts", "hooks"), { recursive: true })
  if (files.accumulator !== undefined) {
    await writeFile(path.join(pluginRoot, "scripts", "hooks", "post-edit-accumulator.js"), files.accumulator)
  }
  if (files.stop !== undefined) {
    await writeFile(path.join(pluginRoot, "scripts", "hooks", "stop-format-typecheck.js"), files.stop)
  }
}

const readEccHook = (pluginRoot: string, name: string): Promise<string> =>
  readFile(path.join(pluginRoot, "scripts", "hooks", name), "utf8")

describe("ECC accumulator hook session scoping", () => {
  it("requires the hook payload session instead of sharing a fallback accumulator", async () => {
    const root = await temporaryRoot("trellage-ecc-accumulator-")
    await writeEccHookFixture(root, { accumulator: upstreamEccAccumulatorHook, stop: upstreamEccStopHook })

    await Effect.runPromise(normalizeEccAccumulatorHookSessionScoping(root))

    const accumulator = await readEccHook(root, "post-edit-accumulator.js")
    const stop = await readEccHook(root, "stop-format-typecheck.js")
    for (const normalized of [accumulator, stop]) {
      expect(normalized).toContain("function trellageHookSessionId(rawInput) {")
      expect(normalized).toContain("payload?.session_id ?? payload?.sessionId")
      expect(normalized).toContain("function getAccumFile(hookSessionId) {")
      expect(normalized).toContain("const raw = hookSessionId;")
      expect(normalized).not.toContain("process.env.CLAUDE_SESSION_ID")
      expect(normalized).not.toContain("process.env.TRELLAGE_HERDR_INVOCATION_ID")
      expect(normalized).not.toContain("crypto.createHash('sha1').update(process.cwd()).digest('hex').slice(0, 12);")
      expect(normalized).toContain("const sessionId = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);")
      expect(normalized).not.toContain("function getAccumFile() {")
    }
    expect(accumulator).toContain("const MAX_STDIN = 1024 * 1024;\n")
    expect(accumulator).toContain("function appendPath(filePath, hookSessionId) {")
    expect(accumulator).toContain("fs.appendFileSync(getAccumFile(hookSessionId), filePath + '\\n', 'utf8');")
    expect(accumulator).toContain("const hookSessionId = trellageHookSessionId(rawInput);")
    expect(accumulator).toContain("if (!hookSessionId) return rawInput;")
    expect(accumulator).toContain("appendPath(input.tool_input?.file_path, hookSessionId);")
    expect(accumulator).toContain("for (const edit of edits) appendPath(edit?.file_path, hookSessionId);")
    expect(accumulator).not.toContain("appendPath(input.tool_input?.file_path);")
    // ECC's read-then-unlink cleanup is untouched.
    expect(stop).toContain("  try { fs.unlinkSync(accumFile); } catch { /* best-effort */ }")
    expect(stop).toContain("function main(hookSessionId) {")
    expect(stop).toContain("if (!hookSessionId) return;")
    expect(stop).toContain("const accumFile = getAccumFile(hookSessionId);")
    expect(stop).toContain("main(trellageHookSessionId(rawInput));")
    expect(stop).not.toContain("    main();")
  })

  it("isolates two sessions in one working directory and normalizes hostile session identifiers", async () => {
    const root = await temporaryRoot("trellage-ecc-accumulator-behavior-")
    const plugin = path.join(root, "plugin")
    await writeEccHookFixture(plugin, { accumulator: upstreamEccAccumulatorHook, stop: upstreamEccStopHook })

    await Effect.runPromise(normalizeEccAccumulatorHookSessionScoping(plugin))

    const script = path.join(plugin, "scripts", "hooks", "post-edit-accumulator.js")
    const workspace = path.join(root, "workspace")
    const temporary = path.join(root, "tmp")
    await mkdir(workspace, { recursive: true })
    await mkdir(temporary, { recursive: true })
    const environment: NodeJS.ProcessEnv = { ...process.env, TMPDIR: temporary }
    delete environment.CLAUDE_SESSION_ID
    delete environment.TRELLAGE_HERDR_INVOCATION_ID
    const append = (sessionId: string, filePath: string): Promise<unknown> =>
      execFilePromise(
        "node",
        [
          "-e",
          `require(${JSON.stringify(script)}).run(process.argv[1])`,
          JSON.stringify({ session_id: sessionId, tool_input: { file_path: filePath } }),
        ],
        { cwd: workspace, env: environment },
      )

    await append("aaaaaaaa-1111-2222-3333-444444444444", "first.ts")
    await append("bbbbbbbb-5555-6666-7777-888888888888", "second.ts")
    await append("../../escape/../etc", "third.ts")

    const accumulators = (await readdir(temporary)).sort()
    expect(accumulators).toEqual([
      "ecc-edited-______escape____etc.txt",
      "ecc-edited-aaaaaaaa-1111-2222-3333-444444444444.txt",
      "ecc-edited-bbbbbbbb-5555-6666-7777-888888888888.txt",
    ])
    await expect(
      readFile(path.join(temporary, "ecc-edited-aaaaaaaa-1111-2222-3333-444444444444.txt"), "utf8"),
    ).resolves.toBe("first.ts\n")
    await expect(
      readFile(path.join(temporary, "ecc-edited-bbbbbbbb-5555-6666-7777-888888888888.txt"), "utf8"),
    ).resolves.toBe("second.ts\n")
  })

  it("skips accumulation when the payload carries no session", async () => {
    const root = await temporaryRoot("trellage-ecc-accumulator-fallback-")
    const plugin = path.join(root, "plugin")
    await writeEccHookFixture(plugin, { accumulator: upstreamEccAccumulatorHook, stop: upstreamEccStopHook })

    await Effect.runPromise(normalizeEccAccumulatorHookSessionScoping(plugin))

    const script = path.join(plugin, "scripts", "hooks", "post-edit-accumulator.js")
    const workspace = path.join(root, "workspace")
    const temporary = path.join(root, "tmp")
    await mkdir(workspace, { recursive: true })
    await mkdir(temporary, { recursive: true })
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: temporary,
      CLAUDE_SESSION_ID: "shared-claude-session",
      TRELLAGE_HERDR_INVOCATION_ID: "shared-herdr-invocation",
    }
    const { stderr } = await execFilePromise(
      "node",
      [
        "-e",
        `require(${JSON.stringify(script)}).run(process.argv[1])`,
        JSON.stringify({ tool_input: { file_path: "only.ts" } }),
      ],
      { cwd: workspace, env: environment },
    )

    await expect(readdir(temporary)).resolves.toEqual([])
    expect(stderr).toContain("[Hook] hook payload carries no session id; skipping shared accumulator")
  })

  it("leaves shared fallback state untouched when the payload is unparsable", async () => {
    const root = await temporaryRoot("trellage-ecc-accumulator-unparsable-")
    const plugin = path.join(root, "plugin")
    await writeEccHookFixture(plugin, { accumulator: upstreamEccAccumulatorHook, stop: upstreamEccStopHook })

    await Effect.runPromise(normalizeEccAccumulatorHookSessionScoping(plugin))

    const script = path.join(plugin, "scripts", "hooks", "stop-format-typecheck.js")
    const workspace = path.join(root, "workspace")
    const temporary = path.join(root, "tmp")
    await mkdir(workspace, { recursive: true })
    await mkdir(temporary, { recursive: true })
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      TMPDIR: temporary,
      CLAUDE_SESSION_ID: "shared-claude-session",
      TRELLAGE_HERDR_INVOCATION_ID: "shared-herdr-invocation",
    }
    const sharedAccumulator = path.join(temporary, "ecc-edited-shared-claude-session.txt")
    await writeFile(sharedAccumulator, "stale.ts\n")
    const { stderr } = await execFilePromise(
      "node",
      ["-e", `require(${JSON.stringify(script)}).run(process.argv[1])`, "{ truncated payload"],
      { cwd: workspace, env: environment },
    )

    expect(stderr).toContain("[Hook] hook payload is unparsable; skipping shared accumulator")
    await expect(readFile(sharedAccumulator, "utf8")).resolves.toBe("stale.ts\n")
  })

  it("fails closed when the plugin root does not exist", async () => {
    const root = await temporaryRoot("trellage-ecc-accumulator-missing-root-")

    await expect(
      Effect.runPromise(normalizeEccAccumulatorHookSessionScoping(path.join(root, "absent"))),
    ).rejects.toMatchObject({
      message: "cannot scope ECC accumulator hooks: ECC plugin root is not a directory",
    })
  })

  it("leaves an already-scoped ECC plugin byte-identical", async () => {
    const root = await temporaryRoot("trellage-ecc-accumulator-idempotent-")
    await writeEccHookFixture(root, { accumulator: upstreamEccAccumulatorHook, stop: upstreamEccStopHook })

    await Effect.runPromise(normalizeEccAccumulatorHookSessionScoping(root))
    const scopedAccumulator = await readEccHook(root, "post-edit-accumulator.js")
    const scopedStop = await readEccHook(root, "stop-format-typecheck.js")
    await Effect.runPromise(normalizeEccAccumulatorHookSessionScoping(root))

    await expect(readEccHook(root, "post-edit-accumulator.js")).resolves.toBe(scopedAccumulator)
    await expect(readEccHook(root, "stop-format-typecheck.js")).resolves.toBe(scopedStop)
  })

  it("fails closed when an already-scoped hook is incomplete", async () => {
    const root = await temporaryRoot("trellage-ecc-accumulator-incomplete-")
    await writeEccHookFixture(root, { accumulator: upstreamEccAccumulatorHook, stop: upstreamEccStopHook })

    await Effect.runPromise(normalizeEccAccumulatorHookSessionScoping(root))
    const accumulatorPath = path.join(root, "scripts", "hooks", "post-edit-accumulator.js")
    const accumulator = await readFile(accumulatorPath, "utf8")
    await writeFile(
      accumulatorPath,
      accumulator.replace(
        "appendPath(input.tool_input?.file_path, hookSessionId);",
        "appendPath(input.tool_input?.file_path, undefined);",
      ),
    )

    await expect(Effect.runPromise(normalizeEccAccumulatorHookSessionScoping(root))).rejects.toMatchObject({
      message: "cannot scope ECC accumulator hooks: unsupported ECC accumulator hook source",
    })
  })

  it("ignores plugins that ship neither accumulator hook", async () => {
    const root = await temporaryRoot("trellage-ecc-accumulator-absent-")
    await mkdir(path.join(root, "skills"), { recursive: true })
    await writeFile(path.join(root, "skills", "SKILL.md"), "# Skill\n")

    await Effect.runPromise(normalizeEccAccumulatorHookSessionScoping(root))

    await expect(readFile(path.join(root, "skills", "SKILL.md"), "utf8")).resolves.toBe("# Skill\n")
  })

  it("fails closed when only one accumulator hook is present", async () => {
    const root = await temporaryRoot("trellage-ecc-accumulator-partial-")
    await writeEccHookFixture(root, { accumulator: upstreamEccAccumulatorHook })

    await expect(Effect.runPromise(normalizeEccAccumulatorHookSessionScoping(root))).rejects.toMatchObject({
      message: "cannot scope ECC accumulator hooks: unsupported ECC accumulator hook source",
    })
  })

  it("fails closed when the accumulator hooks are symlinks rather than regular files", async () => {
    // Both hooks symlinked is the case that would otherwise read as "this plugin
    // ships no accumulator hooks" and skip the rewrite without a word.
    const root = await temporaryRoot("trellage-ecc-accumulator-symlink-")
    await mkdir(path.join(root, "scripts", "hooks"), { recursive: true })
    await writeFile(path.join(root, "shared-accumulator-hook.js"), upstreamEccAccumulatorHook)
    await writeFile(path.join(root, "shared-stop-hook.js"), upstreamEccStopHook)
    await symlink(
      path.join(root, "shared-accumulator-hook.js"),
      path.join(root, "scripts", "hooks", "post-edit-accumulator.js"),
    )
    await symlink(
      path.join(root, "shared-stop-hook.js"),
      path.join(root, "scripts", "hooks", "stop-format-typecheck.js"),
    )

    await expect(Effect.runPromise(normalizeEccAccumulatorHookSessionScoping(root))).rejects.toMatchObject({
      message: "cannot scope ECC accumulator hooks: unsupported ECC accumulator hook source",
    })
    // The symlink targets are never written through.
    await expect(readFile(path.join(root, "shared-accumulator-hook.js"), "utf8")).resolves.toBe(
      upstreamEccAccumulatorHook,
    )
    await expect(readFile(path.join(root, "shared-stop-hook.js"), "utf8")).resolves.toBe(upstreamEccStopHook)
  })

  it("fails closed when the upstream accumulator hook drifts", async () => {
    const root = await temporaryRoot("trellage-ecc-accumulator-drift-")
    await writeEccHookFixture(root, {
      accumulator: "function getAccumFile(session) {\n  return session;\n}\n",
      stop: upstreamEccStopHook,
    })

    await expect(Effect.runPromise(normalizeEccAccumulatorHookSessionScoping(root))).rejects.toMatchObject({
      message: "cannot scope ECC accumulator hooks: unsupported ECC accumulator hook source",
    })
  })

  it("fails closed when an upstream anchor appears more than once", async () => {
    const root = await temporaryRoot("trellage-ecc-accumulator-ambiguous-")
    await writeEccHookFixture(root, {
      accumulator: `${upstreamEccAccumulatorHook}${upstreamEccAccumulatorHook}`,
      stop: upstreamEccStopHook,
    })

    await expect(Effect.runPromise(normalizeEccAccumulatorHookSessionScoping(root))).rejects.toMatchObject({
      message: "cannot scope ECC accumulator hooks: unsupported ECC accumulator hook source",
    })
  })
})
