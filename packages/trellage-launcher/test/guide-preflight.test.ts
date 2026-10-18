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
  type NativeSelectedProfile,
} from "../src/guide-launch.ts"
import type { GuideGoalReadinessServices } from "../src/guide-goal-readiness.ts"
import { goalTransportFixture } from "./fixtures/goal-transport.ts"
import {
  checkSelectedProfileReadiness,
  ProfilePreflightError,
  ProfileReadinessKind,
} from "../src/guide-preflight.ts"

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
const inventory = (harness: string, profile: string): CommandRunResult =>
  ok(JSON.stringify({ schemaVersion: 2, harness, profiles: [profile], readiness: "healthy" }))

describe("customer workflow readiness", () => {
  const selected: NativeSelectedProfile = {
    surface: "native", harness: "copilot", profiles: ["hve"], commandPath: "/opt/bin/trx", headlessPrompt: false,
    agent: "hve-core:dt-coach", interaction: { mode: "interactive", requiredSkills: ["dt-methods"] },
  }
  const evidence = {
    schemaVersion: 2, harness: "copilot", profiles: ["hve"], mode: "interactive", agent: selected.agent,
    requiredSkills: ["dt-methods"], manifestSha256: "a".repeat(64),
  }

  it("requires exact installed workflow evidence after general inventory", async () => {
    const runner = new FakeRunner([inventory("copilot", "hve"), ok(JSON.stringify(evidence))])
    await expect(checkSelectedProfileReadiness(runner, selected, "/repo")).resolves.toMatchObject({
      kind: ProfileReadinessKind.Ready, summary: expect.stringContaining("requires human decisions"),
    })
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["inventory", "copilot", "hve", "--json"], ["workflow-check", "copilot", "hve", "--agent", selected.agent, "--require-skill", "dt-methods"],
    ])
  })

  it.each([
    { ...evidence, agent: "hve-core:rpi-agent" },
    { ...evidence, requiredSkills: [] },
    { ...evidence, mode: "autopilot" },
    { ...evidence, manifestSha256: null },
  ])("rejects mismatched capability evidence", async (response) => {
    const runner = new FakeRunner([inventory("copilot", "hve"), ok(JSON.stringify(response))])
    await expect(checkSelectedProfileReadiness(runner, selected, "/repo")).rejects.toThrow("does not match")
  })

  it("reports an old launcher or missing workflow without repair or success fallback", async () => {
    const runner = new FakeRunner([inventory("copilot", "hve"), new CommandRunnerError({
      kind: "exited", executable: selected.commandPath, args: [], exitCode: 1,
      message: "Unavailable", stderr: "Unknown command: workflow-check",
    })])
    await expect(checkSelectedProfileReadiness(runner, selected, "/repo")).resolves.toMatchObject({
      kind: ProfileReadinessKind.Blocked, diagnostic: expect.stringContaining("Unknown command: workflow-check"),
    })
    expect(runner.calls).toHaveLength(2)
  })
})

const claudeHome = "/managed/.local/share/trellage/profiles/claude/default/home"
const claudeRuntime = (evaluatorModel = "fixture-evaluator"): CommandRunResult => ok(JSON.stringify({
  schemaVersion: 1, launcher: "claude", harness: "claude", installed: "2.1.233",
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
    const runner = new FakeRunner([inventory("codex", "superpowers"), ok("codex-cli 0.153.4\n"), ok("goals\tstable\ttrue\n")])
    const result = await checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution, { env: { HOME: "/managed" } })
    expect(result).toMatchObject({ kind: ProfileReadinessKind.Ready, goalReadiness: "checked" })
    expect(result.summary).toContain("manual native input is required")
    expect(result.summary).toContain("Model execution and goal activation are not confirmed")
    expect(runner.calls.map(({ executable, args }) => [executable, args])).toEqual([
      [profile.commandPath, ["inventory", "codex", "superpowers", "--json"]],
      ["codex", ["--version"]],
      [profile.commandPath, ["inventory", "codex", "superpowers", "--goal-features"]],
    ])
    expect(runner.calls[2]?.options?.env?.CODEX_HOME).toBe("/managed/.local/share/trellage/profiles/codex/superpowers/home")
  })

  it.each([
    { features: "goals\tstable\tfalse\n", status: "blocked", message: "disables goals" },
    { features: "hooks\tstable\ttrue\n", status: "unknown", message: "did not report" },
  ])("does not call a $status Codex goal ready", async ({ features, status, message }) => {
    const { profile, execution } = goalTransportFixture()
    const runner = new FakeRunner([inventory("codex", "superpowers"), ok("codex-cli 0.153.4\n"), ok(features)])
    const result = await checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution)
    expect(result).toMatchObject({ kind: ProfileReadinessKind.Blocked, goalReadiness: status, diagnostic: expect.stringContaining(message) })
    expect(runner.calls).toHaveLength(3)
  })

  it.each(["codex-cli 0.153.3", "codex-cli 0.153.4-beta.1", "unrecognized version"])("does not probe feature subcommands on an unconfirmed runtime: %s", async (version) => {
    const { profile, execution } = goalTransportFixture()
    const runner = new FakeRunner([inventory("codex", "superpowers"), ok(version)])
    await expect(checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution)).resolves.toMatchObject({
      kind: ProfileReadinessKind.Blocked, goalReadiness: "unknown",
    })
    expect(runner.calls).toHaveLength(2)
  })

  it("does not treat an ignored workspace configuration as confirmed effective Codex readiness", async () => {
    const { profile, execution } = goalTransportFixture()
    const runner = new FakeRunner([
      inventory("codex", "superpowers"), ok("codex-cli 0.153.4"),
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
      inventory("codex", "superpowers"), ok("codex-cli 0.153.4"),
      new CommandRunnerError({
        kind: "exited", executable: profile.commandPath,
        args: ["inventory", "codex", "superpowers", "--goal-features"],
        message: "Unsupported inventory option", exitCode: 1,
        stderr: "trx: unknown inventory option",
      }),
      ok("goals\tstable\ttrue\n"),
    ])
    await expect(checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution)).resolves.toMatchObject({
      kind: ProfileReadinessKind.Blocked, goalReadiness: "unknown",
      diagnostic: expect.stringContaining("trx inventory codex PROFILE --goal-features"),
    })
    expect(runner.calls).toHaveLength(3)
    expect(runner.calls[2]?.args).toEqual(["inventory", "codex", "superpowers", "--goal-features"])
  })


  it("requires the configured Claude evaluator, not just the main model", async () => {
    const { profile, execution } = goalTransportFixture("claude-goal")
    const runner = new FakeRunner([
      inventory("claude", "default"), claudeRuntime("small-model-from-managed-runtime"),
      ok('{"data":[{"id":"claude-opus-5"},{"id":"small-model-from-managed-runtime"}]}'),
    ])
    await expect(checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution, claudeSettings())).resolves.toMatchObject({
      kind: ProfileReadinessKind.Ready, goalReadiness: "checked",
      summary: expect.stringContaining("Model execution and goal activation are not confirmed"),
    })
    expect(runner.calls[1]?.args).toEqual(["harness-version", "claude", "default"])
    expect(runner.calls[2]?.args).toEqual(["--fail", "--silent", "--show-error", "--max-time", "5", "http://127.0.0.1:8080/v1/models"])
    const missing = new FakeRunner([inventory("claude", "default"), claudeRuntime(), ok('{"data":[{"id":"claude-opus-5"}]}')])
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
    const runner = new FakeRunner([inventory("claude", "default"), claudeRuntime()])
    await expect(checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution, claudeSettings({ [file]: value }))).resolves.toMatchObject({
      kind: ProfileReadinessKind.Blocked, goalReadiness: "blocked", diagnostic: expect.stringContaining(message),
    })
    expect(runner.calls).toHaveLength(2)
  })

  it("applies Claude's file precedence without overriding a managed hook prohibition", async () => {
    const { profile, execution } = goalTransportFixture("claude-goal")
    const runner = new FakeRunner([inventory("claude", "default"), claudeRuntime()])
    await expect(checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution, claudeSettings({
      [`${claudeHome}/settings.json`]: { disableAllHooks: true },
      "/repo/.claude/settings.local.json": { disableAllHooks: false },
      "/etc/claude-code/managed-settings.json": { disableAllHooks: true },
    }))).resolves.toMatchObject({ kind: ProfileReadinessKind.Blocked, diagnostic: expect.stringContaining("disable all hooks") })
  })

  it("reports legacy Claude runtime evidence as unknown instead of assuming evaluator availability", async () => {
    const { profile, execution } = goalTransportFixture("claude-goal")
    const runner = new FakeRunner([inventory("claude", "default"), ok('{"schemaVersion":1,"launcher":"claude","harness":"claude","installed":"2.1.233"}')])
    await expect(checkSelectedProfileReadiness(runner, profile, "/repo", undefined, execution, claudeSettings())).resolves.toMatchObject({
      kind: ProfileReadinessKind.Blocked, goalReadiness: "unknown", diagnostic: expect.stringContaining("does not expose its goal evaluator runtime"),
    })
  })

  it("reports macOS managed preferences and dynamic policy helpers as unknown without executing them", async () => {
    const { profile, execution } = goalTransportFixture("claude-goal")
    const managed = new FakeRunner([inventory("claude", "default"), claudeRuntime()])
    await expect(checkSelectedProfileReadiness(managed, profile, "/repo", undefined, execution, {
      ...claudeSettings(), platform: "darwin", pathExists: async () => true,
    })).resolves.toMatchObject({ kind: ProfileReadinessKind.Blocked, goalReadiness: "unknown", diagnostic: expect.stringContaining("macOS managed preferences") })
    const dynamic = new FakeRunner([inventory("claude", "default"), claudeRuntime()])
    await expect(checkSelectedProfileReadiness(dynamic, profile, "/repo", undefined, execution, claudeSettings({
      "/etc/claude-code/managed-settings.json": { policyHelper: "/policy/resolve" },
    }))).resolves.toMatchObject({ kind: ProfileReadinessKind.Blocked, goalReadiness: "unknown", diagnostic: expect.stringContaining("no helper was executed") })
    expect(managed.calls).toHaveLength(2)
    expect(dynamic.calls).toHaveLength(2)
  })

  it("merges visible managed fragments in order and ignores hidden files", async () => {
    const { profile, execution } = goalTransportFixture("claude-goal")
    const runner = new FakeRunner([inventory("claude", "default"), claudeRuntime(), ok('{"data":[{"id":"fixture-evaluator"}]}')])
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
        inventory("claude", "default"), claudeRuntime(), ok(`${linked}\n`),
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
        ["inventory", "claude", "default", "--json"], ["harness-version", "claude", "default"],
        ["rev-parse", "--show-toplevel"], ["worktree", "list", "--porcelain"],
      ])
    } finally {
      await rm(fixture, { recursive: true, force: true })
    }
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
    const runner = new FakeRunner([ok('{"schemaVersion":2,"harness":"copilot","profiles":["hve"],"readiness":"healthy"}')])

    await expect(
      checkSelectedProfileReadiness(
        runner,
        {
          surface: "native",
          harness: "copilot",
          commandPath: "/opt/trellage/bin/trx",
          profiles: ["hve"],
          headlessPrompt: false,
        },
        "/repo",
      ),
    ).resolves.toEqual({
      kind: ProfileReadinessKind.Ready,
      summary: "copilot/hve is healthy",
    })
    expect(runner.calls[0]).toMatchObject({
      executable: "/opt/trellage/bin/trx",
      args: ["inventory", "copilot", "hve", "--json"],
      options: { cwd: "/repo", timeoutMs: 30_000 },
    })
  })

  it("blocks native profiles that are not set up", async () => {
    const runner = new FakeRunner([
      ok('{"schemaVersion":2,"harness":"copilot","profiles":["awesome"],"readiness":"not-setup"}'),
    ])

    const result = await checkSelectedProfileReadiness(
      runner,
      {
        surface: "native",
        harness: "copilot",
        commandPath: "/opt/trellage/bin/trx",
        profiles: ["awesome"],
        headlessPrompt: false,
      },
      "/repo",
    )

    expect(result).toMatchObject({
      kind: ProfileReadinessKind.Blocked,
      summary: "copilot/awesome is not-setup",
    })
  })

  it("blocks busy native profiles with a retry diagnostic", async () => {
    const runner = new FakeRunner([ok('{"schemaVersion":2,"harness":"prime","profiles":["default"],"readiness":"busy"}')])

    await expect(
      checkSelectedProfileReadiness(
        runner,
        {
          surface: "native",
          harness: "prime",
          commandPath: "/opt/trellage/bin/trx",
          profiles: ["default"],
          headlessPrompt: false,
        },
        "/repo",
      ),
    ).resolves.toEqual({
      kind: ProfileReadinessKind.Blocked,
      summary: "prime/default is busy",
      diagnostic: "Wait for the current prime operation to finish, then retry.",
    })
  })

  it("rejects mismatched native inventory output", async () => {
    const runner = new FakeRunner([ok('{"schemaVersion":2,"harness":"copilot","profiles":["other"],"readiness":"healthy"}')])

    await expect(
      checkSelectedProfileReadiness(
        runner,
        {
          surface: "native",
          harness: "copilot",
          commandPath: "/opt/trellage/bin/trx",
          profiles: ["hve"],
          headlessPrompt: false,
        },
        "/repo",
      ),
    ).rejects.toThrow(ProfilePreflightError)
  })

})
