import { describe, expect, it } from "vitest"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  CommandRunnerError,
  createNodeCommandRunner,
  parseSelectedProfile,
  type CommandRunOptions,
  type CommandRunResult,
  type CommandRunner,
} from "../src/guide-launch.ts"
import { checkSelectedProfileReadiness, ProfilePreflightError, ProfileReadinessKind } from "../src/guide-preflight.ts"
import type { GuideGoalReadinessServices } from "../src/guide-goal-readiness.ts"
import { goalTransportFixture } from "./fixtures/goal-transport.ts"

class FakeRunner implements CommandRunner {
  readonly calls: Array<{
    readonly executable: string
    readonly args: ReadonlyArray<string>
    readonly options?: CommandRunOptions
  }> = []

  constructor(private readonly outcomes: ReadonlyArray<CommandRunResult | Error>) {}

  async run(executable: string, args: ReadonlyArray<string>, options?: CommandRunOptions): Promise<CommandRunResult> {
    this.calls.push({ executable, args, ...(options === undefined ? {} : { options }) })
    const outcome = this.outcomes[this.calls.length - 1]
    if (outcome === undefined) throw new Error(`Unexpected command call ${this.calls.length}`)
    if (outcome instanceof Error) throw outcome
    return outcome
  }
}

const ok = (stdout = ""): CommandRunResult => ({ stdout, stderr: "", exitCode: 0 })
const doctor = (
  developmentResolution: boolean,
  image: "available" | "absent" | "stale" | "error",
  profile = "prime-agent",
): string =>
  `profile: ${profile} (/repo/profiles/${profile}/profile.toml)\ndevelopment resolution: ${developmentResolution}\nimage: test/image (${image})\n`

const inventory = (launcher: string, profile: string): CommandRunResult =>
  ok(JSON.stringify({ schemaVersion: 1, launcher, profile, readiness: "healthy" }))

const claudeHome = "/managed/.local/share/trellage/profiles/claude/default/home"
const claudeRuntime = (evaluatorModel = "fixture-evaluator"): CommandRunResult => ok(JSON.stringify({
  schemaVersion: 1, launcher: "cldx", harness: "claude", installed: "2.1.233",
  latest: null, latestKnown: false,
  goalRuntime: { profileHome: claudeHome, evaluatorModel, modelsUrl: "http://127.0.0.1:8080/v1/models" },
}))

const claudeSettings = (changes: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {}): GuideGoalReadinessServices => {
  const settings: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
    [`${claudeHome}/.claude.json`]: { projects: { "/repo": { hasTrustDialogAccepted: true } } },
    [`${claudeHome}/settings.json`]: {},
    ...changes,
  }
  return {
    env: { HOME: "/managed" },
    platform: "linux",
    realpath: async (directory) => directory,
    readJson: async (file) => settings[file],
    readDirectory: async () => [],
    localSettingsPaths: async (cwd) => [path.join(cwd, ".claude/settings.local.json")],
  }
}

describe("goal-only read-only readiness", () => {
  it("uses Codex's actual managed home and effective features instead of a help-text search", async () => {
    const { profile, execution } = goalTransportFixture()
    const runner = new FakeRunner([inventory("cdx", "superpowers"), ok("codex-cli 0.153.4\n"), ok("goals\tstable\ttrue\n")])
    const result = await checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution, { env: { HOME: "/managed" } })
    expect(result).toMatchObject({ kind: ProfileReadinessKind.Ready, goalReadiness: "checked" })
    expect(result.summary).toContain("manual native input is required")
    expect(result.summary).toContain("Model execution and goal activation are not confirmed")
    expect(runner.calls.map(({ executable, args }) => [executable, args])).toEqual([
      [profile.commandPath, ["inventory", "superpowers", "--json"]],
      ["codex", ["--version"]],
      [profile.commandPath, ["inventory", "superpowers", "--goal-features"]],
    ])
    expect(runner.calls[2]?.options?.env?.CODEX_HOME).toBe("/managed/.local/share/trellage/profiles/codex/superpowers/home")
  })

  it.each([
    { features: "goals\tstable\tfalse\n", status: "blocked", message: "disables goals" },
    { features: "hooks\tstable\ttrue\n", status: "unknown", message: "did not report" },
  ])("does not call a $status Codex goal ready", async ({ features, status, message }) => {
    const { profile, execution } = goalTransportFixture()
    const runner = new FakeRunner([inventory("cdx", "superpowers"), ok("codex-cli 0.153.4\n"), ok(features)])
    const result = await checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution)
    expect(result).toMatchObject({ kind: ProfileReadinessKind.Blocked, goalReadiness: status, diagnostic: expect.stringContaining(message) })
    expect(runner.calls).toHaveLength(3)
  })

  it.each(["codex-cli 0.153.3", "codex-cli 0.153.4-beta.1", "unrecognized version"])("does not probe feature subcommands on an unconfirmed runtime: %s", async (version) => {
    const { profile, execution } = goalTransportFixture()
    const runner = new FakeRunner([inventory("cdx", "superpowers"), ok(version)])
    await expect(checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution)).resolves.toMatchObject({
      kind: ProfileReadinessKind.Blocked, goalReadiness: "unknown",
    })
    expect(runner.calls).toHaveLength(2)
  })

  it("does not treat an ignored workspace configuration as confirmed effective Codex readiness", async () => {
    const { profile, execution } = goalTransportFixture()
    const runner = new FakeRunner([
      inventory("cdx", "superpowers"), ok("codex-cli 0.153.4"),
      { stdout: "goals stable true\n", stderr: "Workspace config was skipped because it is not trusted.", exitCode: 0 },
    ])
    await expect(checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution)).resolves.toMatchObject({
      kind: ProfileReadinessKind.Blocked, goalReadiness: "unknown",
      diagnostic: expect.stringContaining("Workspace config was skipped"),
    })
  })

  it("blocks an older Codex adapter instead of falling back to a bare feature probe", async () => {
    const { profile, execution } = goalTransportFixture()
    const runner = new FakeRunner([
      inventory("cdx", "superpowers"), ok("codex-cli 0.153.4"),
      new CommandRunnerError({
        kind: "exited", executable: profile.commandPath,
        args: ["inventory", "superpowers", "--goal-features"],
        message: "Unsupported inventory option", exitCode: 1,
        stderr: "usage: cdx inventory PROFILE --json",
      }),
      ok("goals\tstable\ttrue\n"),
    ])
    await expect(checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution)).resolves.toMatchObject({
      kind: ProfileReadinessKind.Blocked, goalReadiness: "unknown",
      diagnostic: expect.stringContaining("inventory PROFILE --goal-features"),
    })
    expect(runner.calls).toHaveLength(3)
    expect(runner.calls[2]?.args).toEqual(["inventory", "superpowers", "--goal-features"])
  })

  it("loads a silently skipped Codex project layer with launch trust without persisting trust", async () => {
    const fixture = await realpath(await mkdtemp(path.join(tmpdir(), "trellage-goal-codex-layer-")))
    try {
      const home = path.join(fixture, "home")
      const profileHome = path.join(home, ".local/share/trellage/profiles/codex/superpowers/home")
      const repository = path.join(fixture, "linked")
      const primary = path.join(fixture, "primary")
      const cwd = path.join(repository, "subdirectory")
      const bin = path.join(fixture, "bin")
      const trace = path.join(fixture, "commands.jsonl")
      const config = path.join(profileHome, "config.toml")
      const projectConfig = path.join(cwd, ".codex/config.toml")
      await mkdir(profileHome, { recursive: true, mode: 0o700 })
      await mkdir(path.join(cwd, ".codex"), { recursive: true })
      await mkdir(path.join(primary, ".git"), { recursive: true })
      await mkdir(bin)
      await writeFile(config, "[features]\ngoals = true\n", { mode: 0o600 })
      await writeFile(projectConfig, "[features]\ngoals = false\n", { mode: 0o600 })
      await writeFile(path.join(bin, "git"), `#!/bin/sh
[ "$1" = -C ] && [ "$2" = "$FIXTURE_CWD" ] && [ "$3" = rev-parse ] || exit 97
case "$4" in
  --show-toplevel) printf '%s\\n' "$FIXTURE_REPOSITORY" ;;
  --path-format=absolute) [ "$5" = --git-common-dir ] || exit 97; printf '%s/.git\\n' "$FIXTURE_PRIMARY" ;;
  *) exit 97 ;;
esac
`, { mode: 0o755 })
      await writeFile(path.join(bin, "codex"), `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_TRACE, JSON.stringify({ args, home: process.env.CODEX_HOME }) + "\\n");
if (args.length === 1 && args[0] === "--version") {
  console.log("codex-cli 0.153.4");
} else if (args.at(-2) === "features" && args.at(-1) === "list") {
  const projects = args.find((value, index) => args[index - 1] === "-c" && value.startsWith("projects="));
  const roots = [process.cwd(), process.env.FIXTURE_REPOSITORY, process.env.FIXTURE_PRIMARY];
  const trusted = roots.every((root) => projects?.includes(JSON.stringify(root) + '={trust_level="trusted"}'));
  const disabled = fs.readFileSync(path.join(process.cwd(), ".codex/config.toml"), "utf8").includes("goals = false");
  console.log("goals\\tstable\\t" + !(trusted && disabled));
} else {
  console.error("Only read-only version and feature queries are allowed.");
  process.exit(97);
}
`, { mode: 0o755 })
      const env = {
        ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}`,
        FIXTURE_CWD: cwd, FIXTURE_REPOSITORY: repository, FIXTURE_PRIMARY: primary, FIXTURE_TRACE: trace,
      }
      const beforeFiles = (await readdir(home, { recursive: true })).sort()
      const beforeConfig = await stat(config)
      const actual = createNodeCommandRunner()
      const bare = await actual.run("codex", ["features", "list"], {
        cwd, env: { ...env, CODEX_HOME: profileHome }, timeoutMs: 30_000,
      })
      expect(bare).toEqual(ok("goals\tstable\ttrue\n"))
      const launcher = fileURLToPath(new URL("../../../prototypes/trellage-codex-profiles/bin/cdx", import.meta.url))
      const { profile, execution } = goalTransportFixture()
      const runner: CommandRunner = {
        async run(executable, args, options) {
          if (executable === launcher && args.join(" ") === "inventory superpowers --json") {
            return inventory("cdx", "superpowers")
          }
          expect([
            ["codex", ["--version"]],
            ["codex", ["features", "list"]],
            [launcher, ["inventory", "superpowers", "--goal-features"]],
          ]).toContainEqual([executable, args])
          return actual.run(executable, args, options)
        },
      }
      await expect(checkSelectedProfileReadiness(runner, { ...profile, commandPath: launcher }, cwd, undefined, execution, { env })).resolves.toMatchObject({
        kind: ProfileReadinessKind.Blocked, goalReadiness: "blocked", diagnostic: expect.stringContaining("disables goals"),
      })
      const commands = (await readFile(trace, "utf8")).trim().split("\n").map((line): unknown => JSON.parse(line))
      expect(commands).toEqual([
        { args: ["features", "list"], home: profileHome },
        { args: ["--version"], home: profileHome },
        {
          args: [
            "-c", "sandbox_workspace_write.network_access=true",
            "--disable", "default_mode_request_user_input",
            "-c", `projects={${[cwd, repository, primary].map((root) => `${JSON.stringify(root)}={trust_level="trusted"}`).join(",")}}`,
            "features", "list",
          ],
          home: profileHome,
        },
      ])
      expect(await readFile(config, "utf8")).toBe("[features]\ngoals = true\n")
      expect(await readFile(projectConfig, "utf8")).toBe("[features]\ngoals = false\n")
      expect((await stat(config)).mtimeMs).toBe(beforeConfig.mtimeMs)
      expect((await stat(config)).mode & 0o777).toBe(0o600)
      expect((await readdir(home, { recursive: true })).sort()).toEqual(beforeFiles)
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it("requires the configured Claude evaluator, not just the main model", async () => {
    const { profile, execution } = goalTransportFixture("claude-goal")
    const runner = new FakeRunner([
      inventory("cldx", "default"), claudeRuntime("small-model-from-managed-runtime"),
      ok('{"data":[{"id":"claude-opus-5"},{"id":"small-model-from-managed-runtime"}]}'),
    ])
    await expect(checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution, claudeSettings())).resolves.toMatchObject({
      kind: ProfileReadinessKind.Ready, goalReadiness: "checked",
      summary: expect.stringContaining("Model execution and goal activation are not confirmed"),
    })
    expect(runner.calls[1]?.args).toEqual(["harness-version"])
    expect(runner.calls[2]?.args).toEqual(["--fail", "--silent", "--show-error", "--max-time", "5", "http://127.0.0.1:8080/v1/models"])
    const missing = new FakeRunner([inventory("cldx", "default"), claudeRuntime(), ok('{"data":[{"id":"claude-opus-5"}]}')])
    await expect(checkSelectedProfileReadiness(missing, profile, "/repo", undefined, execution, claudeSettings())).resolves.toMatchObject({
      kind: ProfileReadinessKind.Blocked, goalReadiness: "blocked",
      diagnostic: expect.stringContaining("fixture-evaluator is unavailable"),
    })
  })

  it.each([
    { name: "untrusted workspace", file: `${claudeHome}/.claude.json`, value: { projects: { "/repo": { hasTrustDialogAccepted: false } } }, message: "has not accepted workspace trust" },
    { name: "disabled hooks", file: `${claudeHome}/settings.json`, value: { disableAllHooks: true }, message: "disable all hooks" },
    { name: "managed-only hooks", file: "/etc/claude-code/managed-settings.json", value: { allowManagedHooksOnly: true }, message: "only managed hooks" },
    { name: "malformed hook settings", file: `${claudeHome}/settings.json`, value: { disableAllHooks: "false" }, message: "not a boolean" },
  ])("blocks $name without changing policy or making a model request", async ({ file, value, message }) => {
    const { profile, execution } = goalTransportFixture("claude-goal")
    const runner = new FakeRunner([inventory("cldx", "default"), claudeRuntime()])
    await expect(checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution, claudeSettings({ [file]: value }))).resolves.toMatchObject({
      kind: ProfileReadinessKind.Blocked, goalReadiness: "blocked", diagnostic: expect.stringContaining(message),
    })
    expect(runner.calls).toHaveLength(2)
  })

  it("applies Claude's file precedence without overriding a managed hook prohibition", async () => {
    const { profile, execution } = goalTransportFixture("claude-goal")
    const runner = new FakeRunner([inventory("cldx", "default"), claudeRuntime()])
    await expect(checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution, claudeSettings({
      [`${claudeHome}/settings.json`]: { disableAllHooks: true },
      "/repo/.claude/settings.local.json": { disableAllHooks: false },
      "/etc/claude-code/managed-settings.json": { disableAllHooks: true },
    }))).resolves.toMatchObject({ kind: ProfileReadinessKind.Blocked, diagnostic: expect.stringContaining("disable all hooks") })
  })

  it("reports legacy Claude runtime evidence as unknown instead of assuming evaluator availability", async () => {
    const { profile, execution } = goalTransportFixture("claude-goal")
    const runner = new FakeRunner([inventory("cldx", "default"), ok('{"schemaVersion":1,"launcher":"cldx","harness":"claude","installed":"2.1.233"}')])
    await expect(checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution, claudeSettings())).resolves.toMatchObject({
      kind: ProfileReadinessKind.Blocked, goalReadiness: "unknown", diagnostic: expect.stringContaining("does not expose its goal evaluator runtime"),
    })
  })

  it("reports macOS managed preferences and dynamic policy helpers as unknown without executing them", async () => {
    const { profile, execution } = goalTransportFixture("claude-goal")
    const managed = new FakeRunner([inventory("cldx", "default"), claudeRuntime()])
    await expect(checkSelectedProfileReadiness(managed, profile, "/repo", undefined, execution, {
      ...claudeSettings(), platform: "darwin", pathExists: async () => true,
    })).resolves.toMatchObject({ kind: ProfileReadinessKind.Blocked, goalReadiness: "unknown", diagnostic: expect.stringContaining("macOS managed preferences") })
    const dynamic = new FakeRunner([inventory("cldx", "default"), claudeRuntime()])
    await expect(checkSelectedProfileReadiness(dynamic, profile, "/repo", undefined, execution, claudeSettings({
      "/etc/claude-code/managed-settings.json": { policyHelper: "/policy/resolve" },
    }))).resolves.toMatchObject({ kind: ProfileReadinessKind.Blocked, goalReadiness: "unknown", diagnostic: expect.stringContaining("no helper was executed") })
    expect(managed.calls).toHaveLength(2)
    expect(dynamic.calls).toHaveLength(2)
  })

  it("merges visible managed fragments in order and ignores hidden files", async () => {
    const { profile, execution } = goalTransportFixture("claude-goal")
    const runner = new FakeRunner([inventory("cldx", "default"), claudeRuntime(), ok('{"data":[{"id":"fixture-evaluator"}]}')])
    await expect(checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution, {
      ...claudeSettings({
        "/etc/claude-code/managed-settings.json": { allowManagedHooksOnly: true },
        "/etc/claude-code/managed-settings.d/20-goals.json": { allowManagedHooksOnly: false },
        "/etc/claude-code/managed-settings.d/.hidden.json": { disableAllHooks: true },
      }),
      readDirectory: async () => ["20-goals.json", ".hidden.json"],
    })).resolves.toMatchObject({ kind: ProfileReadinessKind.Ready, goalReadiness: "checked" })
  })

  it("reads the primary checkout's local settings for a modern Claude worktree session", async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "trellage-goal-settings-"))
    try {
      const primary = path.join(fixture, "primary")
      const linked = path.join(fixture, "linked")
      const cwd = path.join(linked, "subdirectory")
      await mkdir(path.join(primary, ".git"), { recursive: true })
      await mkdir(path.join(linked, ".git"), { recursive: true })
      await mkdir(cwd)
      const { profile, execution } = goalTransportFixture("claude-goal")
      const runner = new FakeRunner([
        inventory("cldx", "default"), claudeRuntime(), ok(`${linked}\n`),
        ok(`worktree ${primary}\nHEAD ${"a".repeat(40)}\nbranch refs/heads/main\n\nworktree ${linked}\nHEAD ${"b".repeat(40)}\nbranch refs/heads/goal\n`),
      ])
      const { localSettingsPaths: _paths, ...settings } = claudeSettings({
        [`${claudeHome}/.claude.json`]: { projects: { [cwd]: { hasTrustDialogAccepted: true } } },
        [path.join(cwd, ".claude/settings.local.json")]: { disableAllHooks: false },
        [path.join(primary, ".claude/settings.local.json")]: { disableAllHooks: true },
      })
      await expect(checkSelectedProfileReadiness(runner, profile, cwd, undefined, execution, settings)).resolves.toMatchObject({
        kind: ProfileReadinessKind.Blocked, goalReadiness: "blocked", diagnostic: expect.stringContaining("disable all hooks"),
      })
      expect(runner.calls.map(({ args }) => args)).toEqual([
        ["inventory", "default", "--json"], ["harness-version"],
        ["rev-parse", "--show-toplevel"], ["worktree", "list", "--porcelain"],
      ])
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })

  it("does not automatically build a Sandbox for a goal and does not invent native runtime evidence", async () => {
    const { profile, execution } = goalTransportFixture("claude-goal")
    const selected = parseSelectedProfile({
      surface: "sandbox", commandPath: "/opt/trellage/bin/trellage", profile: "claude-council",
      headlessPrompt: true, goalExecutionPolicy: profile.goalExecutionPolicy,
    })
    const stale = new FakeRunner([ok(doctor(false, "absent", selected.profile))])
    await expect(checkSelectedProfileReadiness(stale, selected, "/repo", undefined, execution)).resolves.toMatchObject({
      kind: ProfileReadinessKind.Blocked, diagnostic: expect.stringContaining("No automatic repair was run"),
    })
    expect(stale.calls).toHaveLength(1)
    const readyImage = new FakeRunner([ok(doctor(true, "available", selected.profile))])
    await expect(checkSelectedProfileReadiness(readyImage, selected, "/repo", undefined, execution)).resolves.toMatchObject({
      kind: ProfileReadinessKind.Blocked, goalReadiness: "unknown",
    })
    expect(readyImage.calls).toHaveLength(1)
  })

  it("gets read-only evaluator metadata from the managed Claude adapter without preparing or launching a profile", async () => {
    const fixture = await mkdtemp(path.join(tmpdir(), "trellage-goal-runtime-"))
    try {
      const home = path.join(fixture, "home")
      const bin = path.join(fixture, "bin")
      await mkdir(home)
      await mkdir(bin)
      await writeFile(path.join(bin, "claude"), "#!/bin/sh\n[ \"$#\" = 1 ] && [ \"$1\" = --version ] || exit 97\nprintf '2.1.233 (Claude Code)\\n'\n", { mode: 0o755 })
      const runner = createNodeCommandRunner()
      const launcher = fileURLToPath(new URL("../../../prototypes/trellage-claude-profiles/bin/cldx", import.meta.url))
      const result = await runner.run(launcher, ["harness-version"], {
        cwd: fixture, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH ?? ""}` }, timeoutMs: 30_000,
      })
      expect(JSON.parse(result.stdout)).toMatchObject({
        installed: "2.1.233",
        goalRuntime: {
          profileHome: path.join(home, ".local/share/trellage/profiles/claude/default/home"),
          evaluatorModel: "claude-haiku-4.5", modelsUrl: "http://127.0.0.1:8080/v1/models",
        },
      })
      expect(await readdir(home)).toEqual([])
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
  })
})

describe("selected profile readiness", () => {
  it("uses native inventory and accepts only a matching healthy identity", async () => {
    const runner = new FakeRunner([ok('{"schemaVersion":1,"launcher":"cpx","profile":"hve","readiness":"healthy"}')])

    await expect(
      checkSelectedProfileReadiness(
        runner,
        {
          surface: "native",
          launcher: "cpx",
          commandPath: "/opt/trellage/bin/cpx",
          profile: "hve",
          headlessPrompt: false,
        },
        "/repo",
      ),
    ).resolves.toEqual({
      kind: ProfileReadinessKind.Ready,
      summary: "cpx/hve is healthy",
    })
    expect(runner.calls[0]).toMatchObject({
      executable: "/opt/trellage/bin/cpx",
      args: ["inventory", "hve", "--json"],
      options: { cwd: "/repo", timeoutMs: 30_000 },
    })
  })

  it("blocks native profiles that are not set up", async () => {
    const runner = new FakeRunner([
      ok('{"schemaVersion":1,"launcher":"cpx","profile":"awesome","readiness":"not-setup"}'),
    ])

    const result = await checkSelectedProfileReadiness(
      runner,
      {
        surface: "native",
        launcher: "cpx",
        commandPath: "/opt/trellage/bin/cpx",
        profile: "awesome",
        headlessPrompt: false,
      },
      "/repo",
    )

    expect(result).toMatchObject({
      kind: ProfileReadinessKind.Blocked,
      summary: "cpx/awesome is not-setup",
    })
  })

  it("blocks busy native profiles with a retry diagnostic", async () => {
    const runner = new FakeRunner([ok('{"schemaVersion":1,"launcher":"prx","profile":"default","readiness":"busy"}')])

    await expect(
      checkSelectedProfileReadiness(
        runner,
        {
          surface: "native",
          launcher: "prx",
          commandPath: "/opt/trellage/bin/prx",
          profile: "default",
          headlessPrompt: false,
        },
        "/repo",
      ),
    ).resolves.toEqual({
      kind: ProfileReadinessKind.Blocked,
      summary: "prx/default is busy",
      diagnostic: "Wait for the current prx operation to finish, then retry.",
    })
  })

  it("rejects mismatched native inventory output", async () => {
    const runner = new FakeRunner([ok('{"schemaVersion":1,"launcher":"cpx","profile":"other","readiness":"healthy"}')])

    await expect(
      checkSelectedProfileReadiness(
        runner,
        {
          surface: "native",
          launcher: "cpx",
          commandPath: "/opt/trellage/bin/cpx",
          profile: "hve",
          headlessPrompt: false,
        },
        "/repo",
      ),
    ).rejects.toThrow(ProfilePreflightError)
  })

  it("accepts a Sandbox profile with a current resolution and image", async () => {
    const runner = new FakeRunner([ok(doctor(true, "available"))])

    await expect(
      checkSelectedProfileReadiness(
        runner,
        {
          surface: "sandbox",
          commandPath: "/opt/trellage/bin/trellage",
          profile: "prime-agent",
          headlessPrompt: false,
        },
        "/repo",
      ),
    ).resolves.toEqual({
      kind: ProfileReadinessKind.Ready,
      summary: "prime-agent is ready",
    })
    expect(runner.calls).toEqual([
      {
        executable: "/opt/trellage/bin/trellage",
        args: ["doctor", "--profile", "prime-agent"],
        options: { cwd: "/repo", timeoutMs: 300_000 },
      },
    ])
  })

  it("automatically builds and rechecks an unprepared Sandbox profile", async () => {
    const runner = new FakeRunner([
      ok(doctor(false, "absent", "headlong")),
      ok(),
      ok(doctor(true, "available", "headlong")),
    ])

    await expect(
      checkSelectedProfileReadiness(
        runner,
        {
          surface: "sandbox",
          commandPath: "/opt/trellage/bin/trellage",
          profile: "headlong",
          headlessPrompt: false,
        },
        "/repo",
      ),
    ).resolves.toEqual({
      kind: ProfileReadinessKind.Ready,
      summary: "headlong was repaired and is ready",
    })
    expect(runner.calls.map(({ args, options }) => ({ args, timeoutMs: options?.timeoutMs }))).toEqual([
      { args: ["doctor", "--profile", "headlong"], timeoutMs: 300_000 },
      { args: ["build", "headlong"], timeoutMs: 1_800_000 },
      { args: ["doctor", "--profile", "headlong"], timeoutMs: 300_000 },
    ])
    expect(runner.calls[1]?.options?.outputOverflow).toBe("truncate")
  })

  it("converts Sandbox automatic build failures to blocked diagnostics", async () => {
    const runner = new FakeRunner([
      ok(doctor(false, "absent")),
      new CommandRunnerError({
        kind: "exited",
        executable: "/opt/trellage/bin/trellage",
        args: ["build", "prime-agent"],
        exitCode: 1,
        stderr: "build failed",
        message: "automatic build failed",
      }),
    ])

    await expect(
      checkSelectedProfileReadiness(
        runner,
        {
          surface: "sandbox",
          commandPath: "/opt/trellage/bin/trellage",
          profile: "prime-agent",
          headlessPrompt: false,
        },
        "/repo",
      ),
    ).resolves.toEqual({
      kind: ProfileReadinessKind.Blocked,
      summary: "prime-agent automatic repair failed",
      diagnostic: "build failed",
    })
  })

  it("blocks a Sandbox profile that remains stale after automatic repair", async () => {
    const runner = new FakeRunner([
      ok(doctor(true, "stale", "headlong")),
      ok(),
      ok(doctor(true, "stale", "headlong")),
    ])

    await expect(
      checkSelectedProfileReadiness(
        runner,
        {
          surface: "sandbox",
          commandPath: "/opt/trellage/bin/trellage",
          profile: "headlong",
          headlessPrompt: false,
        },
        "/repo",
      ),
    ).resolves.toEqual({
      kind: ProfileReadinessKind.Blocked,
      summary: "headlong remains unavailable after automatic repair",
      diagnostic: "Development resolution: true; image: stale.",
    })
  })
})
