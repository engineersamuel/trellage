import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, readFile, readdir, readlink, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  claudeAdapter,
  codexAdapter,
  copilotAdapter,
  fxAdapter,
  grokAdapter,
  jcodeAdapter,
  type LaunchInput,
} from "../../src/native-run/adapters.ts"
import {
  parseRunArguments,
  piExtensionsNeedUpdate,
  prepareRun,
  resumeCommand,
  runNative,
  spawnInherited,
  type RunDependencies,
  type Spawner,
} from "../../src/native-run/run.ts"
import { createSourceResolver, gitSourceTransport } from "../../src/native-run/source.ts"
import { createSelectionHistory, scopeKeysFor } from "../../src/native-run/history.ts"
import { cleanupFixtures, createSourceRepo, fixturePaths, git, skillMarkdown, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)

const world = async (config?: string) => {
  const root = await tempRoot("run")
  const office = await createSourceRepo(root, "office")
  await office.write({ "skills/powerpoint/SKILL.md": skillMarkdown("powerpoint") })
  const superpowers = await createSourceRepo(root, "superpowers")
  await superpowers.write({
    "skills/brainstorming/SKILL.md": skillMarkdown("brainstorming"),
    "skills/writing-plans/SKILL.md": skillMarkdown("writing-plans"),
  })
  const configPath = path.join(root, "config.toml")
  await writeFile(
    configPath,
    config ??
      `schema_version = 1
[native.sources.office-content]
repository = "example/office"
[native.sources.superpowers]
repository = "example/superpowers"
[native.profiles.office]
skills = [{ source = "office-content", names = ["powerpoint"] }]
[native.profiles.superpowers]
skills = [{ source = "superpowers", names = ["brainstorming", "writing-plans"] }]
`,
    { mode: 0o600 },
  )
  await chmod(configPath, 0o600)
  const repositories: Record<string, string> = {
    "example/office": office.directory,
    "example/superpowers": superpowers.directory,
  }
  const work = path.join(root, "work")
  await mkdir(work)
  await git(work, "init", "-q")
  const paths = await fixturePaths(root)
  const lines: string[] = []
  const dependencies = (spawner?: Spawner): RunDependencies => ({
    environment: { PATH: process.env.PATH ?? "", TRELLAGE_CONFIG: configPath, HOME: root },
    paths,
    cwd: work,
    transport: gitSourceTransport((repository) => repositories[repository]!),
    write: (line) => lines.push(line),
    refreshHarness: async () => undefined,
    ...(spawner ? { spawner } : {}),
  })
  return { root, office, superpowers, paths, lines, dependencies, work }
}

const base = { dryRun: false, allowUnprovenIsolation: false, forwardedArgs: [] as string[] }

test("parses harness, stacked profiles, overrides and forwarded arguments", () => {
  expect(parseRunArguments(["pi", "office", "superpowers", "--model", "m", "--effort=high", "--", "-p", "hi"])).toEqual(
    {
      harness: "pi",
      profiles: ["office", "superpowers"],
      model: "m",
      effort: "high",
      dryRun: false,
      allowUnprovenIsolation: true,
      noAlways: false,
      plan: false,
      forwardedArgs: ["-p", "hi"],
    },
  )
  expect(parseRunArguments(["copilot", "--require-proven-isolation"]).allowUnprovenIsolation).toBe(false)
  expect(() => parseRunArguments(["pi", "--bogus"])).toThrow(/unknown option/)
  expect(() => parseRunArguments([])).toThrow(/requires a harness/)
  expect(parseRunArguments(["fx", "default", "--plan", "--", "ask", "hello"])).toMatchObject({
    harness: "fx",
    profiles: ["default"],
    plan: true,
    forwardedArgs: ["ask", "hello"],
  })
})

test("Fx uses the canonical adapter with shared host context and plan defaults", async () => {
  const { dependencies, root } = await world()
  const normal = await prepareRun({ ...base, harness: "fx", profiles: ["default"] }, dependencies())
  expect(normal.launch.command).toBe("fx")
  expect(normal.launch.args).toEqual(["--effort", "medium"])
  expect(normal.launch.env).toMatchObject({
    FX_AUTO_UPGRADE: "0",
    FX_PROVIDER: "trellage-copilot-proxy",
    FX_MODEL: "gpt-6.1-sol",
  })
  expect(normal.launch.env.HOME).toBeUndefined()
  const planned = await prepareRun({ ...base, harness: "fx", profiles: ["default"], plan: true }, dependencies())
  expect(planned.launch.args).toEqual(["--effort", "max"])
  expect(planned.launch.env.FX_MODEL).toBe("gpt-6-astra")
  const input: LaunchInput = {
    resumeArgs: [],
    layout: planned.layout,
    plan: planned.plan,
    model: "gpt-6-astra",
    effort: "max",
    forwardedArgs: [],
    environment: { HOME: root },
    workspace: root,
  }
  await fxAdapter.beforeLaunch!(input)
  const settings = JSON.parse(await readFile(path.join(root, ".fx", "settings.json"), "utf8"))
  expect(settings.providers["trellage-copilot-proxy"].base_url).toBe("http://127.0.0.1:8080/v1")
})

test("canonical adapters launch agent executables instead of retired profile wrappers", async () => {
  const { dependencies } = await world()
  const expected: Readonly<Record<string, string>> = {
    agency: "agency",
    firstmate: "claude",
    jcode: "jcode",
    omp: "omp",
    prime: "prime-agent",
  }
  for (const [harness, command] of Object.entries(expected)) {
    const profile = harness === "agency" ? "azure" : "default"
    const prepared = await prepareRun(
      { ...base, harness, profiles: [profile], dryRun: true, allowUnprovenIsolation: true },
      dependencies(),
    )
    expect(prepared.launch.command).toBe(command)
    expect(prepared.launch.command).not.toMatch(/\/(?:agx|fmx|jcx|prx)$/u)
  }
})

test("JCode resolves its managed private mise executable", async () => {
  const { dependencies, root, work } = await world()
  const lifecycle = path.join(root, "jcx")
  const managed = path.join(root, "managed-jcode")
  await writeFile(managed, "#!/bin/sh\n", { mode: 0o755 })
  await writeFile(
    lifecycle,
    `#!/bin/sh
test "$TRELLAGE_TRX_JCODE_ADAPTER" = 1
test "$1" = _trx-executable
printf '%s\\n' ${JSON.stringify(managed)}
`,
    { mode: 0o755 },
  )
  const prepared = await prepareRun({ ...base, harness: "fx", profiles: ["default"] }, dependencies())
  const input: LaunchInput = {
    resumeArgs: [],
    layout: prepared.layout,
    plan: prepared.plan,
    planMode: false,
    model: "gpt-5.6-sol",
    effort: "medium",
    forwardedArgs: [],
    environment: { HOME: root, PATH: "/usr/bin:/bin", TRELLAGE_JCODE_LIFECYCLE_BIN: lifecycle },
    workspace: work,
  }
  expect((await jcodeAdapter.resolveLaunch!(input, prepared.launch)).command).toBe(managed)
})

test("Claude admission loads the validated lifecycle plugin directory", async () => {
  const { dependencies, root, work } = await world()
  const lifecycle = path.join(root, "cldx")
  const plugin = path.join(root, "document-plugin")
  await mkdir(plugin)
  await writeFile(
    lifecycle,
    `#!/bin/sh
test "$TRELLAGE_TRX_CLAUDE_ADAPTER" = 1
test "$1" = _trx-admit
printf '{"pluginDir":%s}\\n' ${JSON.stringify(JSON.stringify(plugin))}
`,
    { mode: 0o755 },
  )
  const prepared = await prepareRun({ ...base, harness: "claude", profiles: ["office"] }, dependencies())
  const input: LaunchInput = {
    resumeArgs: [],
    layout: prepared.layout,
    plan: prepared.plan,
    planMode: false,
    model: "opusplan",
    effort: "medium",
    forwardedArgs: [],
    workspace: work,
    environment: { HOME: root, PATH: "/usr/bin:/bin", TRELLAGE_CLAUDE_LIFECYCLE_BIN: lifecycle },
  }
  const launch = await claudeAdapter.resolveLaunch!(input, prepared.launch)
  expect(launch.args.slice(-2)).toEqual(["--plugin-dir", plugin])
})

test("Copilot admission bridges lifecycle plugins, hooks, and agents into the generated home", async () => {
  const { dependencies, root, work } = await world()
  const lifecycle = path.join(root, "cpx")
  const installedPlugins = path.join(root, "installed-plugins")
  await mkdir(installedPlugins)
  await writeFile(
    lifecycle,
    `#!/bin/sh
test "$TRELLAGE_TRX_COPILOT_ADAPTER" = 1
test "$1" = _trx-admit
printf '%s\\n' '${JSON.stringify({ installedPlugins: "INSTALL_ROOT", settings: { enabledPlugins: { "hve-core@hve-core": true }, hooks: { sessionStart: [] }, subagents: { reviewer: { description: "review" } } } }).replace("INSTALL_ROOT", installedPlugins)}'
`,
    { mode: 0o755 },
  )
  const prepared = await prepareRun({ ...base, harness: "fx", profiles: ["default"] }, dependencies())
  const copilotPlan = { ...prepared.plan, harness: "copilot", profiles: ["preset-copilot-hve"] }
  const input: LaunchInput = {
    resumeArgs: [],
    layout: prepared.layout,
    plan: copilotPlan,
    planMode: false,
    model: "gpt-6-astra",
    effort: "low",
    forwardedArgs: [],
    workspace: work,
    environment: { HOME: root, PATH: "/usr/bin:/bin", TRELLAGE_COPILOT_LIFECYCLE_BIN: lifecycle },
  }
  await copilotAdapter.resolveLaunch!(input, prepared.launch)
  expect(await readlink(path.join(prepared.layout.generationPath, "installed-plugins"))).toBe(installedPlugins)
  const settings = JSON.parse(await readFile(path.join(prepared.layout.generationPath, "settings.json"), "utf8"))
  expect(settings.enabledPlugins["hve-core@hve-core"]).toBe(true)
  expect(settings.hooks).toEqual({ sessionStart: [] })
  expect(settings.subagents.reviewer.description).toBe("review")
})

test("Claude applies opusplan defaults and real plan-mode arguments", async () => {
  const { dependencies } = await world()
  const normal = await prepareRun({ ...base, harness: "claude", profiles: ["default"] }, dependencies())
  expect(normal.launch.args).toEqual([
    "--dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    "--disallowedTools",
    "AskUserQuestion",
    "--model",
    "opusplan",
    "--effort",
    "medium",
  ])
  const planned = await prepareRun({ ...base, harness: "claude", profiles: ["default"], plan: true }, dependencies())
  expect(planned.launch.args).toEqual([
    "--allow-dangerously-skip-permissions",
    "--effort",
    "max",
    "--disallowedTools",
    "AskUserQuestion",
    "--model",
    "opusplan",
    "--permission-mode",
    "plan",
  ])
})

test("parses resume requests and prints the matching resume command", () => {
  expect(parseRunArguments(["claude", "--continue"]).resume).toEqual({ kind: "continue" })
  expect(parseRunArguments(["claude", "--resume"]).resume).toEqual({ kind: "pick" })
  expect(parseRunArguments(["claude", "--resume=abc"]).resume).toEqual({ kind: "pick", id: "abc" })
  expect(resumeCommand(parseRunArguments(["claude", "pstack", "superpowers", "--effort", "medium"]))).toBe(
    "trx run claude pstack superpowers --continue",
  )
  expect(claudeAdapter.resumeArgs({ kind: "continue" })).toEqual(["--continue"])
  expect(codexAdapter.resumeArgs({ kind: "continue" })).toEqual(["resume", "--last"])
  expect(copilotAdapter.resumeArgs({ kind: "pick", id: "x" })).toEqual(["--resume=x"])
  expect(grokAdapter.resumeArgs({ kind: "pick", id: "x" })).toEqual(["--resume", "x"])
})

test("canonical launches preserve signal exit status", async () => {
  expect(
    await spawnInherited(
      { command: "/bin/sh", args: ["-c", "kill -TERM $$"], env: {} },
      process.env,
      process.cwd(),
      () => {},
    ),
  ).toBe(143)
})

test("Grok publishes a proxy-only home and keeps conversation state across generations", async () => {
  const { dependencies } = await world()
  const prepared = await prepareRun(
    { ...base, harness: "grok", profiles: ["office"], model: "grok-4.7", effort: "high" },
    dependencies(),
  )
  expect(prepared.launch.command).toBe("grok")
  expect(prepared.launch.args).toEqual([
    "--sandbox",
    "trellage-workspace",
    "--permission-mode",
    "bypassPermissions",
    "--always-approve",
    "--trust",
    "--model",
    "grok-4.7",
    "--reasoning-effort",
    "high",
  ])
  expect(prepared.launch.env).toMatchObject({
    GROK_HOME: prepared.layout.generationPath,
    GROK_MODELS_BASE_URL: "http://127.0.0.1:8080/v1",
    GROK_MODELS_LIST_URL: "http://127.0.0.1:8080/v1/models",
    GROK_DEFAULT_MODEL: "grok-4.7",
    XAI_API_KEY: "local-copilot-proxy",
  })
  await expect(readFile(path.join(prepared.layout.generationPath, "auth.json"), "utf8")).rejects.toThrow()
  expect(await readFile(path.join(prepared.layout.generationPath, "config.toml"), "utf8")).toContain(
    '[auth]\npreferred_method = "api_key"',
  )
  expect(await readFile(path.join(prepared.layout.generationPath, "config.toml"), "utf8")).toContain(
    '[model."grok-4.7"]\nenv_key = "XAI_API_KEY"',
  )
  expect(await readFile(path.join(prepared.layout.generationPath, "sandbox.toml"), "utf8")).toContain(
    `[profiles.trellage-workspace]\nextends = "workspace"\nread_write = [${JSON.stringify(prepared.layout.generationPath)}, ${JSON.stringify(path.join(prepared.layout.ownerHome, "state"))}]`,
  )
  expect(await readFile(path.join(prepared.layout.generationPath, "requirements.toml"), "utf8")).toContain(
    "fail_closed = true",
  )
  expect(await readlink(path.join(prepared.layout.generationPath, "sessions"))).toBe(
    path.join(prepared.layout.ownerHome, "state", "sessions"),
  )
})

test("Grok defaults to grok-4.7 with medium effort", async () => {
  const { dependencies, work } = await world()
  const prepared = await prepareRun({ ...base, harness: "grok", profiles: [] }, dependencies())
  expect(prepared.launch.args).toEqual([
    "--sandbox",
    "trellage-workspace",
    "--permission-mode",
    "bypassPermissions",
    "--always-approve",
    "--trust",
    "--model",
    "grok-4.7",
    "--reasoning-effort",
    "medium",
  ])
  expect(prepared.launch.env.GROK_DEFAULT_MODEL).toBe("grok-4.7")
  expect(await readFile(path.join(prepared.layout.generationPath, "config.toml"), "utf8")).toContain(
    '[models]\ndefault_reasoning_effort = "medium"',
  )
  expect(await readFile(path.join(prepared.layout.generationPath, "config.toml"), "utf8")).toContain(
    'id = "xhigh", value = "xhigh"',
  )
  await grokAdapter.trustWorkspace!(prepared.layout, work)
  const trust = await readFile(path.join(prepared.layout.generationPath, "trusted_folders.toml"), "utf8")
  expect(trust).toContain(`[folders.${JSON.stringify(await realpath(work))}]\ntrusted = true\n`)
  expect(trust).toMatch(/decided_at = \d+\n$/u)
})

test("Grok GitHub bridge preserves explicit credentials and validates opt-out", async () => {
  const { dependencies, work } = await world()
  const prepared = await prepareRun({ ...base, harness: "grok", profiles: [] }, dependencies())
  const input = (environment: NodeJS.ProcessEnv): LaunchInput => ({
    resumeArgs: [],
    layout: prepared.layout,
    plan: prepared.plan,
    forwardedArgs: [],
    environment,
    workspace: work,
  })
  expect(await grokAdapter.beforeLaunch!(input({ GH_TOKEN: "explicit" }))).toEqual({})
  expect(await grokAdapter.beforeLaunch!(input({ TRELLAGE_GROK_GH_AUTH_BRIDGE: "0" }))).toEqual({})
  await expect(grokAdapter.beforeLaunch!(input({ TRELLAGE_GROK_GH_AUTH_BRIDGE: "invalid" }))).rejects.toThrow(
    /must be 0 or 1/,
  )
})

test("conversation directories are links to per-composition state that survives a new generation", async () => {
  const { dependencies } = await world()
  const prepared = await prepareRun({ ...base, harness: "claude", profiles: ["office"] }, dependencies())
  const link = path.join(prepared.layout.generationPath, "projects")
  expect(await readlink(link)).toBe(path.join(prepared.layout.ownerHome, "state", "projects"))
})

test("a stacked Pi composition publishes only the selected skills and launches Pi with explicit skill paths", async () => {
  const { dependencies, lines } = await world()
  let launched: Parameters<Spawner>[0] | undefined
  const spawner: Spawner = async (launch, _environment, _cwd, onSpawn) => {
    launched = launch
    onSpawn()
    return 0
  }
  const status = await runNative({ ...base, harness: "pi", profiles: ["superpowers", "office"] }, dependencies(spawner))
  expect(status).toBe(0)
  expect(launched!.args.slice(0, 6)).toEqual([
    "--no-skills",
    "--no-extensions",
    "--extension",
    "builtin:codemode",
    "--no-prompt-templates",
    "--no-approve",
  ])
  const skillArguments = launched!.args.flatMap((argument, index, all) =>
    all[index - 1] === "--skill" ? [argument] : [],
  )
  expect(skillArguments.map((entry) => path.basename(entry))).toEqual(["brainstorming", "powerpoint", "writing-plans"])
  expect(launched!.env.PI_CODING_AGENT_DIR).toBe(path.dirname(path.dirname(skillArguments[0]!)))
  expect((await readdir(path.join(launched!.env.PI_CODING_AGENT_DIR!, "skills"))).sort()).toEqual([
    "brainstorming",
    "powerpoint",
    "writing-plans",
  ])
  expect(lines.some((line) => line.startsWith("Harness     Pi + office + superpowers"))).toBe(true)
})

test("zero profiles launches a clean base harness", async () => {
  const { dependencies } = await world()
  const prepared = await prepareRun({ ...base, harness: "pi", profiles: [] }, dependencies())
  expect(prepared.plan.skills).toEqual([])
  expect(prepared.launch.args.filter((argument) => argument === "--skill")).toEqual([])
})

test("profile order and duplicates do not change the composition", async () => {
  const { dependencies } = await world()
  const a = await prepareRun({ ...base, harness: "pi", profiles: ["office", "superpowers", "office"] }, dependencies())
  const b = await prepareRun({ ...base, harness: "pi", profiles: ["superpowers", "office"] }, dependencies())
  expect(a.plan.generationId).toBe(b.plan.generationId)
  expect(a.plan.compositionId).toBe(b.plan.compositionId)
})

test("a floating source update creates a new generation while the old one stays", async () => {
  const { dependencies, office, paths } = await world()
  const first = await prepareRun({ ...base, harness: "pi", profiles: ["office"] }, dependencies())
  await office.write({ "skills/powerpoint/SKILL.md": skillMarkdown("powerpoint", "changed") })
  const second = await prepareRun({ ...base, harness: "pi", profiles: ["office"] }, dependencies())
  expect(second.plan.generationId).not.toBe(first.plan.generationId)
  expect(second.layout.ownerHome).toBe(first.layout.ownerHome)
  expect((await readdir(path.join(first.layout.ownerHome, "generations"))).length).toBe(2)
  expect(await readFile(path.join(second.layout.generationPath, "skills/powerpoint/SKILL.md"), "utf8")).toContain(
    "changed",
  )
  expect(paths.data).toBeTruthy()
})

test("floating refresh checks ignore the former TTL on every profile load", async () => {
  const { office, paths } = await world()
  const real = gitSourceTransport(() => office.directory)
  let checks = 0
  const transport = {
    ...real,
    resolveRef: async (repository: string, ref: string) => (checks++, real.resolveRef(repository, ref)),
  }
  let clock = new Date("2026-01-01T00:00:00Z")
  const resolver = createSourceResolver({ paths, transport, ttlSeconds: 300, now: () => clock })
  const resolveOnce = async () => {
    const resolved = await resolver.resolve("office", { repository: "example/office" } as never)
    await resolver.markGood(resolved)
  }
  await resolveOnce()
  clock = new Date(clock.getTime() + 60_000)
  await resolveOnce()
  expect(checks).toBe(2)
  clock = new Date(clock.getTime() + 301_000)
  await resolveOnce()
  expect(checks).toBe(3)
})

test("conflicting skill names from different sources fail before publication", async () => {
  const { dependencies, root, office, paths } = await world(`schema_version = 1
[native.sources.a]
repository = "example/office"
[native.sources.b]
repository = "example/other"
[native.profiles.one]
skills = [{ source = "a", names = ["powerpoint"] }]
[native.profiles.two]
skills = [{ source = "b", names = ["powerpoint"] }]
`)
  const other = await createSourceRepo(root, "other")
  await other.write({ "skills/powerpoint/SKILL.md": skillMarkdown("powerpoint", "different") })
  const repositories: Record<string, string> = { "example/office": office.directory, "example/other": other.directory }
  const deps = { ...dependencies(), transport: gitSourceTransport((repository) => repositories[repository]!) }
  await expect(prepareRun({ ...base, harness: "pi", profiles: ["one", "two"] }, deps)).rejects.toThrow(
    /differs between sources/,
  )
  await expect(readdir(path.join(paths.data, "compositions"))).rejects.toThrow()
  await expect(prepareRun({ ...base, harness: "pi", profiles: ["nope"] }, deps)).rejects.toThrow(/unknown profile nope/)
})

test("unproven harnesses refuse to launch without explicit opt-in but allow a dry run", async () => {
  const { dependencies } = await world()
  await expect(runNative({ ...base, harness: "codex", profiles: ["office"] }, dependencies())).rejects.toThrow(
    /isolation is not proven/,
  )
  expect(await runNative({ ...base, dryRun: true, harness: "codex", profiles: ["office"] }, dependencies())).toBe(0)
  let started = false
  const spawner: Spawner = async (_launch, _environment, _cwd, onSpawn) => {
    started = true
    onSpawn()
    return 0
  }
  await runNative(
    { ...base, allowUnprovenIsolation: true, harness: "codex", profiles: ["office"] },
    dependencies(spawner),
  )
  expect(started).toBe(true)
})

test("rejects unsupported effort values and managed isolation flags", async () => {
  const { dependencies } = await world()
  await expect(prepareRun({ ...base, harness: "pi", profiles: [], effort: "turbo" }, dependencies())).rejects.toThrow(
    /does not support effort/,
  )
  await expect(
    prepareRun({ ...base, harness: "pi", profiles: [], forwardedArgs: ["--skill", "/x"] }, dependencies()),
  ).rejects.toThrow(/managed by/)
})

test("offline with no cache stops before any launch", async () => {
  const { dependencies } = await world()
  let started = false
  const deps = {
    ...dependencies(async () => {
      started = true
      return 0
    }),
    transport: {
      resolveRef: async () => {
        throw new Error("offline")
      },
      fetchCommit: async () => {
        throw new Error("offline")
      },
    },
  }
  await expect(runNative({ ...base, harness: "pi", profiles: ["office"] }, deps)).rejects.toThrow(/no cached content/)
  expect(started).toBe(false)
})

test("a successful launch records worktree, repository and global selections", async () => {
  const { dependencies, paths, work } = await world()
  const spawner: Spawner = async (_launch, _environment, _cwd, onSpawn) => {
    onSpawn()
    return 0
  }
  await runNative({ ...base, harness: "pi", profiles: ["office"], model: "gpt-x" }, dependencies(spawner))
  const history = createSelectionHistory(paths)
  const keys = await scopeKeysFor(work)
  const restored = await history.restore(keys)
  expect(restored?.scope).toBe("worktree")
  expect(restored?.selection).toEqual({ harness: "pi", profiles: ["office"], model: "gpt-x" })
  const elsewhere = await history.restore({ worktree: "/other/worktree", repository: keys.repository })
  expect(elsewhere?.scope).toBe("repository")
  const fresh = await history.restore({ worktree: "/other", repository: "/other/.git" })
  expect(fresh?.scope).toBe("global")
})

const alwaysConfig = `schema_version = 1
[native.sources.office-content]
repository = "example/office"
[native.sources.superpowers]
repository = "example/superpowers"
[native.instructions.rundown]
file = "styles/rundown.md"
[native.profiles.core]
always = true
skills = [{ source = "office-content", names = ["powerpoint"] }]
instructions = ["rundown"]
[native.profiles.pi-only]
always = true
harnesses = ["pi"]
skills = [{ source = "superpowers", names = ["writing-plans"] }]
[native.profiles.superpowers]
skills = [{ source = "superpowers", names = ["brainstorming"] }]
`

const alwaysWorld = async () => {
  const w = await world(alwaysConfig)
  await mkdir(path.join(w.root, "styles"))
  await writeFile(path.join(w.root, "styles", "rundown.md"), "---\nname: Rundown\n---\nOpen with a TL;DR.\n")
  return w
}

test("always-on profiles apply to every run, honor harness limits and ship the instruction file", async () => {
  const { dependencies } = await alwaysWorld()
  const pi = await prepareRun({ ...base, harness: "pi", profiles: ["superpowers"] }, dependencies())
  expect(pi.plan.alwaysProfiles).toEqual(["core", "pi-only"])
  expect(pi.plan.skills.map((skill) => skill.name)).toEqual(["brainstorming", "powerpoint", "writing-plans"])
  expect(await readFile(path.join(pi.layout.generationPath, "APPEND_SYSTEM.md"), "utf8")).toBe("Open with a TL;DR.\n")
  const codex = await prepareRun({ ...base, harness: "codex", profiles: [] }, dependencies())
  expect(codex.plan.alwaysProfiles).toEqual(["core"])
  expect(codex.plan.skills.map((skill) => skill.name)).toEqual(["powerpoint"])
  expect(await readFile(path.join(codex.layout.generationPath, "AGENTS.md"), "utf8")).toBe("Open with a TL;DR.\n")
})

test("--no-always starts a clean harness and a changed instruction yields a new generation", async () => {
  const { dependencies, root } = await alwaysWorld()
  const clean = await prepareRun({ ...base, harness: "pi", profiles: [], noAlways: true }, dependencies())
  expect(clean.plan.skills).toEqual([])
  expect(clean.plan.instructions).toEqual([])
  const first = await prepareRun({ ...base, harness: "pi", profiles: [] }, dependencies())
  await writeFile(path.join(root, "styles", "rundown.md"), "Changed.\n")
  const second = await prepareRun({ ...base, harness: "pi", profiles: [] }, dependencies())
  expect(second.plan.generationId).not.toBe(first.plan.generationId)
})

test("a missing instruction file stops the launch with a clear error", async () => {
  const { dependencies } = await world(alwaysConfig)
  await expect(prepareRun({ ...base, harness: "pi", profiles: [] }, dependencies())).rejects.toThrow(
    /instruction rundown: cannot read/,
  )
})

test("a failed Pi release refresh warns and still launches", async () => {
  const { dependencies, lines } = await world()
  const spawner: Spawner = async (_launch, _environment, _cwd, onSpawn) => {
    onSpawn()
    return 0
  }
  const refreshed: string[] = []
  const status = await runNative(
    { ...base, harness: "pi", profiles: [] },
    {
      ...dependencies(spawner),
      refreshHarness: async (harness) => (refreshed.push(harness), "Pi release update failed"),
    },
  )
  expect(status).toBe(0)
  expect(refreshed).toEqual(["pi"])
  expect(lines.some((line) => line.includes("Pi release update failed"))).toBe(true)
})

test("Pi extension freshness skips installation when every installed version is latest", async () => {
  const root = await tempRoot("pi-extensions-current")
  const extension = path.join(root, "node_modules", "@narumitw", "pi-plan-mode")
  await mkdir(extension, { recursive: true })
  await writeFile(path.join(extension, "package.json"), JSON.stringify({ version: "0.58.4" }))

  const queried: string[] = []
  const needsUpdate = await piExtensionsNeedUpdate(
    { HOME: root, TRELLAGE_PI_EXTENSIONS_HOME: root },
    async (name) => (queried.push(name), "0.58.4"),
  )

  expect(needsUpdate).toBe(false)
  expect(queried).toEqual(["@narumitw/pi-plan-mode"])
})

test("Pi extension freshness installs missing or outdated packages", async () => {
  const root = await tempRoot("pi-extensions-outdated")
  const environment = { HOME: root, TRELLAGE_PI_EXTENSIONS_HOME: root }
  expect(await piExtensionsNeedUpdate(environment, async () => "0.58.4")).toBe(true)

  const extension = path.join(root, "node_modules", "@narumitw", "pi-plan-mode")
  await mkdir(extension, { recursive: true })
  await writeFile(path.join(extension, "package.json"), JSON.stringify({ version: "0.58.3" }))
  expect(await piExtensionsNeedUpdate(environment, async () => "0.58.4")).toBe(true)
})

test("shared wildcard policy excludes unwanted skills and checks required selections", async () => {
  const fixture = await world(`
[skills.sources.superpowers]
repository = "https://github.com/example/superpowers.git"
select = ["*"]
allowWildcard = true
exclude = ["writing-plans"]
required = ["brainstorming"]
[skills.bundles]
native-common = ["superpowers"]
[native.profiles.common]
always = true
skills = [{source = "superpowers", names = ["*"]}]
`)
  const prepared = await prepareRun({ ...base, harness: "pi", profiles: [] }, fixture.dependencies())
  expect(prepared.plan.skills.map((skill) => skill.name)).toEqual(["brainstorming"])
})

test("source always-on policy injects instructions but never enables a manual-only skill", async () => {
  const fixture = await world(`
[skills.sources.superpowers]
repository = "https://github.com/example/superpowers.git"
select = ["brainstorming", "writing-plans"]
alwaysOn = true
[skills.bundles]
native-common = ["superpowers"]
[native.profiles.common]
always = true
skills = [{source = "superpowers", names = ["brainstorming", "writing-plans"]}]
`)
  await fixture.superpowers.write({
    "skills/brainstorming/SKILL.md":
      "---\nname: brainstorming\ndisable-model-invocation: true\n---\n\nManual brainstorming.\n",
  })
  const prepared = await prepareRun({ ...base, harness: "pi", profiles: [] }, fixture.dependencies())
  const instructions = await readFile(path.join(prepared.layout.generationPath, "APPEND_SYSTEM.md"), "utf8")
  expect(instructions).toContain("writing-plans")
  expect(instructions).not.toContain("Manual brainstorming")
  expect(prepared.plan.skills.find((skill) => skill.name === "brainstorming")?.manualOnly).toBe(true)
})
