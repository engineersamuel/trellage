import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, mkdir, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import {
  claudeAdapter,
  codexAdapter,
  copilotAdapter,
  fxAdapter,
  grokAdapter,
  headlongAdapter,
  jcodeAdapter,
  ompAdapter,
  PI_EXTENSION_PACKAGES,
  piExtensionEntries,
  primeAdapter,
  ujiAdapter,
  type LaunchCommand,
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
import { acquireProfileGuard } from "../../src/native-run/lifecycle-guard.ts"
import { cleanupFixtures, createSourceRepo, fixturePaths, git, skillMarkdown, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)

const world = async (config?: string) => {
  const root = await tempRoot("run")
  const office = await createSourceRepo(root, "office")
  await office.write({
    "skills/powerpoint/SKILL.md": skillMarkdown("powerpoint"),
    "skills/i-have-adhd/SKILL.md": "---\nname: i-have-adhd\ndisable-model-invocation: true\n---\nManual output fixture.\n",
    "plugins/sample/.claude-plugin/plugin.json": JSON.stringify({ name: "sample", description: "fixture" }),
    "plugins/sample/commands/check.md": "# Check\n",
    "plugins/sample/.mcp.json": JSON.stringify({ mcpServers: { fixture: { command: "fixture" } } }),
  })
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
[native.profiles.headlong-test]
skills = [{ source = "office-content", names = ["powerpoint", "i-have-adhd"] }]
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

const primeLaunchInput = (root: string, environment: NodeJS.ProcessEnv): LaunchInput => ({
  resumeArgs: [],
  layout: {
    ownerHome: path.join(root, "owner"),
    generationPath: path.join(root, "generation"),
    sessionsPath: path.join(root, "sessions"),
  },
  plan: {
    compositionId: "prime-fixture",
    harness: "prime",
    profiles: ["default"],
    alwaysProfiles: [],
    instructions: [],
    skills: [],
    plugins: [],
    sources: [],
    warnings: [],
    generationId: "prime-fixture",
  },
  forwardedArgs: [],
  environment,
  workspace: root,
})

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

test("Prime launch uses its managed lifecycle binary and preserves spawn diagnostics", async () => {
  const root = await tempRoot("prime-lifecycle")
  const lifecycle = path.join(root, ".local", "share", "trellage", "prx", "bin", "prx")
  const marker = path.join(root, "lifecycle-args")
  await mkdir(path.dirname(lifecycle), { recursive: true })
  await writeFile(lifecycle, '#!/bin/sh\nprintf "%s\\n" "$@" > "$TRELLAGE_TEST_MARKER"\n', { mode: 0o755 })

  const environment = {
    HOME: root,
    PATH: "/usr/bin:/bin",
    TRELLAGE_TEST_MARKER: marker,
  }
  const input = primeLaunchInput(root, environment)
  await expect(primeAdapter.resolveLaunch!(input, primeAdapter.launch(input))).rejects.toThrow(/unsafe Prime profile root/)
  expect(await readFile(marker, "utf8")).toBe("setup\ndefault\n")

  const missingLifecycleInput = primeLaunchInput(root, {
    ...environment,
    TRELLAGE_PRIME_LIFECYCLE_BIN: path.join(root, "missing-prx"),
  })
  await expect(
    primeAdapter.resolveLaunch!(missingLifecycleInput, primeAdapter.launch(missingLifecycleInput)),
  ).rejects.toThrow(/ENOENT/)
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

test("Headlong uses host proxy settings and keeps manual skills outside identity registries", async () => {
  const { dependencies, root } = await world()
  const headlongHome = path.join(root, ".headlong")
  const appHome = path.join(headlongHome, "app")
  const initBinary = path.join(root, "bin", "headlong-init")
  await mkdir(path.dirname(initBinary), { recursive: true })
  await writeFile(
    initBinary,
    "#!/bin/sh\nset -eu\nmkdir -p \"$HEADLONG_APP_DIR/.identities/ada\"\n",
    { mode: 0o755 },
  )
  const configured = dependencies()
  const environment = {
    ...configured.environment,
    TRELLAGE_HEADLONG_HOME: headlongHome,
    TRELLAGE_HEADLONG_APP_DIR: appHome,
    TRELLAGE_HEADLONG_INIT_BIN: initBinary,
    ANTHROPIC_API_KEY: "ambient-secret",
  }
  const result = await prepareRun(
    { ...base, harness: "headlong", profiles: ["headlong-test"] },
    { ...configured, environment },
  )
  const input: LaunchInput = {
    resumeArgs: [],
    layout: result.layout,
    plan: result.plan,
    forwardedArgs: [],
    environment,
    workspace: root,
  }
  const launch = await headlongAdapter.resolveLaunch!(input, result.launch)

  expect(launch.command).toBe("ada")
  expect(launch.env).toMatchObject({
    HEADLONG_HOME: headlongHome,
    HEADLONG_APP_DIR: appHome,
    HEADLONG_UNSANDBOXED: "1",
    ANTHROPIC_API_KEY: "trellage-local-proxy",
    LLM_API_URL: "http://127.0.0.1:8080/v1/messages",
    SHELLM_MODEL: "claude-sonnet-5",
  })
  expect(launch.env.OPENAI_API_KEY).toBeNull()
  expect(await readlink(path.join(appHome, ".identities", "ada", "skills", "powerpoint"))).toBe(
    path.join(headlongHome, ".trellage", "skills", "powerpoint"),
  )
  expect(await readFile(path.join(headlongHome, ".trellage", "skills", "i-have-adhd", "SKILL.md"), "utf8")).toContain(
    "Manual output fixture",
  )
  await expect(readlink(path.join(appHome, ".identities", "ada", "skills", "i-have-adhd"))).rejects.toThrow()
  await expect(readlink(path.join(appHome, ".identities", "ada", "kernel", "i-have-adhd"))).rejects.toThrow()
})

test("Uji scopes its config, selected skills, and session database to the profile composition", async () => {
  const { dependencies, root } = await world(`schema_version = 1
  [native.sources.office-content]
  repository = "example/office"
  [native.instructions.policy]
  file = "policy.md"
  [native.profiles.office]
  instructions = ["policy"]
  skills = [{ source = "office-content", names = ["powerpoint"] }]
  `)
  await mkdir(path.join(root, ".codex"), { recursive: true })
  await writeFile(path.join(root, ".codex", "config.toml"), 'model = "gpt-5.6-sol"\n')
  const instruction = 'Keep "quoted" text.\nSecond line.\n'
  await writeFile(path.join(root, "policy.md"), instruction)
  const defaultPrepared = await prepareRun({ ...base, harness: "uji", profiles: ["default"] }, dependencies())
  expect(defaultPrepared.launch.env.TRX_UJI_MODEL).toBe("copilot-proxy-rs/gpt-6-astra")
  expect(defaultPrepared.launch.env.TRX_UJI_EFFORT).toBeNull()
  const prepared = await prepareRun(
    {
      ...base,
      harness: "uji",
      profiles: ["default", "office"],
      model: "copilot-proxy-rs/gpt-4.1",
      effort: "high",
      forwardedArgs: ["--help"],
    },
    dependencies(),
  )
  expect(prepared.launch.command).toBe("uji")
  expect(prepared.launch.args).toEqual(["new", "--help"])
  expect(prepared.launch.env).toMatchObject({
    UJI_CONFIG_DIR: prepared.layout.generationPath,
    UJI_DB: path.join(prepared.layout.sessionsPath, "uji.db"),
    OPENAI_API_KEY: "trellage-local-proxy",
    OPENAI_BASE_URL: null,
    TRX_UJI_MODEL: "copilot-proxy-rs/gpt-4.1",
    TRX_UJI_EFFORT: "high",
  })
  expect(prepared.launch.env.UJI_DATA_DIR).toBeUndefined()
  expect(prepared.launch.env.TRX_UJI_PLAN).toBeNull()
  expect(
    await readFile(path.join(prepared.layout.generationPath, "skills", "powerpoint", "SKILL.md"), "utf8"),
  ).toContain("powerpoint")
  const config = await readFile(path.join(prepared.layout.generationPath, "init.lua"), "utf8")
  const ujiTools = await readFile(path.join(prepared.layout.generationPath, "plugin", "trellage-tools.lua"), "utf8")
  const ujiToolsSource = await readFile(new URL("../../src/native-run/uji-tools.lua", import.meta.url))
  expect(ujiTools).toBe(ujiToolsSource.toString("utf8"))
  expect(ujiAdapter.policyVersion).toBe(`uji-allow-all-${createHash("sha256").update(ujiToolsSource).digest("hex")}`)
  expect(config).toContain('require("uji.builtin.defaults")')
  expect(config).toContain('uji.tool.policy({ default = "allow" })')
  expect(config).toContain('uji.pack.add({ "uji-labs/uji-plugins" })')
  expect(config).toContain("api = uji.api.responses()")
  expect(config).toContain('base_url = "http://127.0.0.1:8080/v1"')
  expect(config).toContain('auth_env = { "OPENAI_API_KEY" }')
  expect(config).toContain('models = { { id = "gpt-4.1" } }')
  expect(config).toContain("uji.model.use({ provider = provider, model = id, effort = effort })")
  expect(config).toContain(path.join(prepared.layout.generationPath, "skills"))
  expect(config).toContain('Keep \\"quoted\\" text.\\nSecond line.')
  expect(ujiTools).toContain('uji.tool.add("proxy_preflight"')
  expect(ujiTools).toContain('uji.tool.add("repo_brief"')
  expect(ujiTools).toContain('uji.tool.add("knowledge_search"')
  expect(ujiTools).toContain('"http://127.0.0.1:8080/v1/models"')
  expect(ujiTools).toContain('"secondbrain"')
  expect(ujiTools).toContain('"outputs"')

  const resumed = await prepareRun(
    { ...base, harness: "uji", profiles: ["default"], resume: { kind: "pick", id: "session-123" } },
    dependencies(),
  )
  expect(resumed.launch.args).toEqual(["resume", "--id", "session-123"])
  expect(resumed.launch.env.UJI_DB).not.toBe(prepared.launch.env.UJI_DB)
  expect(ujiAdapter.resumeArgs({ kind: "continue" })).toEqual(["resume"])
})

test("Uji requires provider/model syntax and reserves adapter-controlled flags", async () => {
  const { dependencies } = await world()
  await expect(
    prepareRun({ ...base, harness: "uji", profiles: ["default"], model: "gpt-4.1" }, dependencies()),
  ).rejects.toThrow(/copilot-proxy-rs\/ID/)
  await expect(
    prepareRun({ ...base, harness: "uji", profiles: ["default"], model: "openai/gpt-4.1" }, dependencies()),
  ).rejects.toThrow(/copilot-proxy-rs\/ID/)
  await expect(
    prepareRun(
      { ...base, harness: "uji", profiles: ["default"], forwardedArgs: ["--config-dir", "/tmp"] },
      dependencies(),
    ),
  ).rejects.toThrow(/managed by the Uji adapter/)
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

test.each([
  ["--model=claude-opus-5.5", "github-copilot/claude-opus-5.5"],
  ["--model=github-copilot/claude-opus-5.5", "github-copilot/claude-opus-5.5"],
])("OMP admission preserves the model override %s", async (modelOption, selector) => {
  const { dependencies, root, work } = await world()
  const lifecycle = path.join(root, "omp-lifecycle")
  const executable = path.join(root, "host-omp")
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const managedOverlay = path.join(root, "omp-managed.yml")
  await writeFile(managedOverlay, "setupVersion: 1\n", { mode: 0o600 })
  await writeFile(
    lifecycle,
    `#!/bin/sh
test "$TRELLAGE_TRX_OMP_ADAPTER" = 1
test "$1" = _trx-admit
test "$2" = default
printf '%s\\n' ${JSON.stringify(
      JSON.stringify({
        schemaVersion: 1,
        executable,
        ompProfile: "trellage-copilot-native",
        piConfigFiles: managedOverlay,
        version: "18.8.5",
        copilotCredentialFile: null,
      }),
    )}
`,
    { mode: 0o755 },
  )
  const prepared = await prepareRun(parseRunArguments(["omp", modelOption, "--effort=high"]), dependencies())
  expect(prepared.launch.args).toEqual(["--model", selector, "--thinking", "high"])
  const forwardedArgs = ["-p", "hello"]
  const input: LaunchInput = {
    resumeArgs: [],
    layout: prepared.layout,
    plan: prepared.plan,
    planMode: false,
    model: prepared.selection.model,
    effort: prepared.selection.effort,
    forwardedArgs,
    workspace: work,
    environment: {
      HOME: root,
      PATH: process.env.PATH ?? "",
      TRELLAGE_OMP_LIFECYCLE_BIN: lifecycle,
    },
  }
  const planned = ompAdapter.launch(input)
  const launch = await ompAdapter.resolveLaunch!(input, planned)
  expect(launch.command).toBe(executable)
  expect(launch.args).toEqual(["--model", selector, "--thinking", "high", "-p", "hello"])
  expect(launch.env).toMatchObject({
    OMP_PROFILE: "trellage-copilot-native",
    PI_CONFIG_FILES: managedOverlay,
  })
})

test("OMP keeps profile defaults and passes explicit local model overrides", async () => {
  const { dependencies } = await world()
  const defaultRun = await prepareRun({ ...base, harness: "omp", profiles: [] }, dependencies())
  expect(defaultRun.launch.args).toEqual(["--model", "github-copilot/gpt-5.6-sol", "--thinking", "medium"])
  const local = await prepareRun({ ...base, harness: "omp", profiles: ["local"] }, dependencies())
  expect(local.launch.args).toEqual([])
  const overridden = await prepareRun({
    ...base, harness: "omp", profiles: ["local"], model: "copilot-proxy-rs/custom-model", effort: "off",
  }, dependencies())
  expect(overridden.launch.args).toEqual(["--model", "copilot-proxy-rs/custom-model", "--thinking", "off"])
})

test("OMP admission rejects malformed relative executable paths", async () => {
  const { dependencies, root, work } = await world()
  const lifecycle = path.join(root, "omp-lifecycle-relative")
  const credential = path.join(root, "omp-invalid-admission-credential")
  await writeFile(credential, "secret-token\n", { mode: 0o600 })
  await writeFile(
    lifecycle,
    `#!/bin/sh
printf '%s\\n' ${JSON.stringify(
      JSON.stringify({
        schemaVersion: 1,
        executable: "omp",
        ompProfile: "trellage-qwen-local",
        piConfigFiles: "/tmp/managed.yml",
        version: "18.8.5",
        copilotCredentialFile: credential,
      }),
    )}
`,
    { mode: 0o755 },
  )
  const prepared = await prepareRun({ ...base, harness: "omp", profiles: ["local"] }, dependencies())
  const input: LaunchInput = {
    resumeArgs: [],
    layout: prepared.layout,
    plan: prepared.plan,
    planMode: false,
    model: "gpt-5.6-sol",
    effort: "medium",
    forwardedArgs: [],
    workspace: work,
    environment: { HOME: root, PATH: process.env.PATH ?? "", TRELLAGE_OMP_LIFECYCLE_BIN: lifecycle },
  }
  await expect(ompAdapter.resolveLaunch!(input, prepared.launch)).rejects.toThrow(/invalid executable/)
  await expect(readFile(credential, "utf8")).rejects.toThrow()
})

test("OMP invalid headless policy does not leave an admission credential handoff", async () => {
  const { dependencies, root, work } = await world()
  const lifecycle = path.join(root, "omp-lifecycle-invalid-headless")
  const executable = path.join(root, "host-omp-invalid-headless")
  const managedOverlay = path.join(root, "omp-managed-invalid-headless.yml")
  const credential = path.join(root, "omp-invalid-headless-credential")
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  await writeFile(managedOverlay, "setupVersion: 1\n", { mode: 0o600 })
  await writeFile(
    lifecycle,
    `#!/bin/sh
printf '%s\\n' secret-token > "$OMP_TEST_CREDENTIAL"
printf '%s\\n' ${JSON.stringify(
      JSON.stringify({
        schemaVersion: 1,
        executable,
        ompProfile: "trellage-copilot-native",
        piConfigFiles: managedOverlay,
        version: "18.8.5",
        copilotCredentialFile: credential,
      }),
    )}
`,
    { mode: 0o755 },
  )
  const prepared = await prepareRun({ ...base, harness: "omp", profiles: ["default"] }, dependencies())
  const input: LaunchInput = {
    resumeArgs: [],
    layout: prepared.layout,
    plan: prepared.plan,
    planMode: false,
    model: "gpt-5.6-sol",
    effort: "medium",
    forwardedArgs: ["--headless-policy=unsupported"],
    workspace: work,
    environment: {
      HOME: root,
      PATH: process.env.PATH ?? "",
      OMP_TEST_CREDENTIAL: credential,
      TRELLAGE_OMP_LIFECYCLE_BIN: lifecycle,
    },
  }
  await expect(ompAdapter.resolveLaunch!(input, prepared.launch)).rejects.toThrow(/unknown --headless-policy/)
  await expect(readFile(credential, "utf8")).rejects.toThrow()
})

test("OMP invalid credential content removes the admission handoff", async () => {
  const { dependencies, root, work } = await world()
  const lifecycle = path.join(root, "omp-lifecycle-invalid-credential")
  const executable = path.join(root, "host-omp-invalid-credential")
  const managedOverlay = path.join(root, "omp-managed-invalid-credential.yml")
  const credential = path.join(root, "omp-invalid-credential")
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  await writeFile(managedOverlay, "setupVersion: 1\n", { mode: 0o600 })
  await writeFile(credential, "token-one\ntoken-two\n", { mode: 0o600 })
  await writeFile(
    lifecycle,
    `#!/bin/sh
printf '%s\\n' ${JSON.stringify(
      JSON.stringify({
        schemaVersion: 1,
        executable,
        ompProfile: "trellage-copilot-native",
        piConfigFiles: managedOverlay,
        version: "18.8.5",
        copilotCredentialFile: credential,
      }),
    )}
`,
    { mode: 0o755 },
  )
  const prepared = await prepareRun({ ...base, harness: "omp", profiles: ["default"] }, dependencies())
  const input: LaunchInput = {
    resumeArgs: [],
    layout: prepared.layout,
    plan: prepared.plan,
    planMode: false,
    model: "gpt-5.6-sol",
    effort: "medium",
    forwardedArgs: [],
    workspace: work,
    environment: { HOME: root, PATH: process.env.PATH ?? "", TRELLAGE_OMP_LIFECYCLE_BIN: lifecycle },
  }
  await expect(ompAdapter.resolveLaunch!(input, prepared.launch)).rejects.toThrow(/invalid Copilot credential/)
  await expect(readFile(credential, "utf8")).rejects.toThrow()
})

test("OMP admission attaches its child and forwards diagnostics while it is supervised", async () => {
  const { dependencies, root, work } = await world()
  const lifecycle = path.join(root, "omp-lifecycle-supervised")
  const childPidFile = path.join(root, "omp-admission.pid")
  const terminatedFile = path.join(root, "omp-admission.terminated")
  await writeFile(
    lifecycle,
    `#!/bin/sh
printf '%s\\n' "$$" > "$OMP_TEST_ADMISSION_PID"
printf '%s\\n' 'cached floating skill snapshot used' >&2
trap 'printf "%s\\n" terminated > "$OMP_TEST_ADMISSION_TERMINATED"; exit 143' TERM INT HUP
while :; do :; done
`,
    { mode: 0o755 },
  )
  const prepared = await prepareRun({ ...base, harness: "omp", profiles: ["default"] }, dependencies())
  const diagnostics: string[] = []
  const previousWrite = process.stderr.write
  process.stderr.write = ((chunk: string | Uint8Array) => {
    diagnostics.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  const attached: number[] = []
  const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = []
  const profileGuard = acquireProfileGuard("omp", ["default"], "run", root)
  const guard = {
    attachChild: (pid: number, grouped?: boolean) => {
      profileGuard.attachChild(pid, grouped)
      attached.push(pid)
    },
    signalTree: (pid: number, signal: NodeJS.Signals) => {
      signalled.push({ pid, signal })
      profileGuard.signalTree(pid, signal)
    },
    waitForTree: profileGuard.waitForTree,
  }
  const input: LaunchInput = {
    resumeArgs: [],
    layout: prepared.layout,
    plan: prepared.plan,
    planMode: false,
    model: "gpt-5.6-sol",
    effort: "medium",
    forwardedArgs: [],
    workspace: work,
    guard,
    environment: {
      HOME: root,
      PATH: process.env.PATH ?? "",
      OMP_TEST_ADMISSION_PID: childPidFile,
      OMP_TEST_ADMISSION_TERMINATED: terminatedFile,
      TRELLAGE_OMP_LIFECYCLE_BIN: lifecycle,
    },
  } as LaunchInput & { readonly guard: typeof guard }
  try {
    const admission = ompAdapter.resolveLaunch!(input, prepared.launch)
    for (let attempts = 0; attempts < 100 && !(await Bun.file(childPidFile).exists()); attempts += 1)
      await Bun.sleep(10)
    expect(await Bun.file(childPidFile).exists()).toBe(true)
    expect(attached).toHaveLength(1)
    process.emit("SIGTERM")
    await expect(admission).rejects.toThrow(/OMP admission failed/)
    expect(signalled).toEqual([{ pid: attached[0]!, signal: "SIGTERM" }])
    expect(await Bun.file(terminatedFile).exists()).toBe(true)
    expect(diagnostics.join("")).toContain("cached floating skill snapshot used")
  } finally {
    if (attached[0] !== undefined) {
      profileGuard.signalTree(attached[0], "SIGKILL")
      await profileGuard.waitForTree(attached[0], 1_000)
    }
    profileGuard.release()
    process.stderr.write = previousWrite
  }
})

test("OMP guard attachment failure settles its supervisor before admission can start", async () => {
  const { dependencies, root, work } = await world()
  const lifecycle = path.join(root, "omp-lifecycle-attach-failure")
  const childPidFile = path.join(root, "omp-attach-failure.pid")
  const terminatedFile = path.join(root, "omp-attach-failure.terminated")
  const credential = path.join(root, "omp-attach-failure-credential")
  const executable = path.join(root, "host-omp-attach-failure")
  const managedOverlay = path.join(root, "omp-managed-attach-failure.yml")
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  await writeFile(managedOverlay, "setupVersion: 1\n", { mode: 0o600 })
  await writeFile(
    lifecycle,
    `#!/bin/sh
trap 'printf "%s\\n" terminated > "$OMP_TEST_ADMISSION_TERMINATED"; exit 143' TERM INT HUP
printf '%s\\n' "$$" > "$OMP_TEST_ADMISSION_PID"
printf '%s\\n' secret-token > "$OMP_TEST_CREDENTIAL"
printf '%s\\n' ${JSON.stringify(
      JSON.stringify({
        schemaVersion: 1,
        executable,
        ompProfile: "trellage-copilot-native",
        piConfigFiles: managedOverlay,
        version: "18.8.5",
        copilotCredentialFile: credential,
      }),
    )}
while :; do :; done
`,
    { mode: 0o755 },
  )
  const prepared = await prepareRun({ ...base, harness: "omp", profiles: ["default"] }, dependencies())
  const profileGuard = acquireProfileGuard("omp", ["default"], "run", root)
  let attachedPid: number | undefined
  const input: LaunchInput = {
    resumeArgs: [],
    layout: prepared.layout,
    plan: prepared.plan,
    planMode: false,
    model: "gpt-5.6-sol",
    effort: "medium",
    forwardedArgs: [],
    workspace: work,
    guard: {
      attachChild: (pid, grouped) => {
        attachedPid = pid
        profileGuard.attachChild(pid, grouped)
        throw new Error("guard attachment failed")
      },
      signalTree: profileGuard.signalTree,
      waitForTree: profileGuard.waitForTree,
    },
    environment: {
      HOME: root,
      PATH: process.env.PATH ?? "",
      OMP_TEST_ADMISSION_PID: childPidFile,
      OMP_TEST_ADMISSION_TERMINATED: terminatedFile,
      OMP_TEST_CREDENTIAL: credential,
      TRELLAGE_OMP_LIFECYCLE_BIN: lifecycle,
    },
  }
  const admission = ompAdapter.resolveLaunch!(input, prepared.launch)
  try {
    await expect(admission).rejects.toThrow(/guard attachment failed/)
    expect(await Bun.file(childPidFile).exists()).toBe(false)
    expect(await Bun.file(terminatedFile).exists()).toBe(false)
    expect(await Bun.file(credential).exists()).toBe(false)
    expect(await profileGuard.waitForTree(attachedPid!, 0)).toBe(true)
  } finally {
    if (attachedPid !== undefined) {
      profileGuard.signalTree(attachedPid, "SIGKILL")
      await profileGuard.waitForTree(attachedPid, 1_000)
    }
    await admission.catch(() => undefined)
    profileGuard.release()
  }
})

test("SQLite attachment failure prevents admission descendants and late credential writes", async () => {
  const { dependencies, root, work } = await world()
  const lifecycle = path.join(root, "omp-lifecycle-descendant-attachment-failure")
  const descendantScript = path.join(root, "omp-admission-descendant.ts")
  const childPidFile = path.join(root, "omp-descendant-root.pid")
  const descendantPidFile = path.join(root, "omp-descendant.pid")
  const terminatedFile = path.join(root, "omp-descendant-root.terminated")
  const credential = path.join(root, "omp-descendant-credential")
  const emittedFile = path.join(root, "omp-descendant-emitted")
  const executable = path.join(root, "host-omp-descendant-attachment-failure")
  const managedOverlay = path.join(root, "omp-managed-descendant-attachment-failure.yml")
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  await writeFile(managedOverlay, "setupVersion: 1\n", { mode: 0o600 })
  await writeFile(
    descendantScript,
    `import { writeFileSync } from "node:fs"

writeFileSync(process.env.OMP_TEST_ADMISSION_DESCENDANT_PID!, String(process.pid) + "\\n")
process.on("SIGTERM", () => {})
process.on("SIGINT", () => {})
setTimeout(() => {
  writeFileSync(process.env.OMP_TEST_CREDENTIAL!, "secret-token\\n", { mode: 0o600 })
  writeFileSync(process.env.OMP_TEST_EMITTED!, "emitted\\n")
  process.stdout.write(${JSON.stringify(
    `${JSON.stringify({
      schemaVersion: 1,
      executable,
      ompProfile: "trellage-copilot-native",
      piConfigFiles: managedOverlay,
      version: "18.8.5",
      copilotCredentialFile: credential,
    })}\n`,
  )})
}, 2_500)
`,
    { mode: 0o600 },
  )
  await writeFile(
    lifecycle,
    `#!/bin/sh
trap 'printf "%s\\n" terminated > "$OMP_TEST_ADMISSION_TERMINATED"; exit 143' TERM INT HUP
"$OMP_TEST_ADMISSION_RUNTIME" "$OMP_TEST_ADMISSION_DESCENDANT" &
printf '%s\\n' "$$" > "$OMP_TEST_ADMISSION_PID"
while :; do :; done
`,
    { mode: 0o755 },
  )
  const prepared = await prepareRun({ ...base, harness: "omp", profiles: ["default"] }, dependencies())
  const profileGuard = acquireProfileGuard("omp", ["default"], "run", root)
  const db = new Database(path.join(root, ".local/share/trellage/profile-guards/profiles.sqlite"))
  db.exec("CREATE TRIGGER reject_owner_updates BEFORE UPDATE ON owners BEGIN SELECT RAISE(FAIL, 'guard attachment failed'); END")
  let treeSettledAt = 0
  let attachedPid: number | undefined
  let released = false
  const input: LaunchInput = {
    resumeArgs: [],
    layout: prepared.layout,
    plan: prepared.plan,
    planMode: false,
    model: "gpt-5.6-sol",
    effort: "medium",
    forwardedArgs: [],
    workspace: work,
    guard: {
      attachChild: (pid, grouped) => {
        attachedPid = pid
        profileGuard.attachChild(pid, grouped)
      },
      signalTree: profileGuard.signalTree,
      waitForTree: async (pid, timeout) => {
        const settled = await profileGuard.waitForTree(pid, timeout)
        if (settled) treeSettledAt = Date.now()
        return settled
      },
    },
    environment: {
      HOME: root,
      PATH: process.env.PATH ?? "",
      OMP_TEST_ADMISSION_PID: childPidFile,
      OMP_TEST_ADMISSION_TERMINATED: terminatedFile,
      OMP_TEST_ADMISSION_RUNTIME: process.execPath,
      OMP_TEST_ADMISSION_DESCENDANT: descendantScript,
      OMP_TEST_ADMISSION_DESCENDANT_PID: descendantPidFile,
      OMP_TEST_CREDENTIAL: credential,
      OMP_TEST_EMITTED: emittedFile,
      TRELLAGE_OMP_LIFECYCLE_BIN: lifecycle,
    },
  }
  const admission = ompAdapter.resolveLaunch!(input, prepared.launch)
  try {
    await expect(admission).rejects.toThrow(/guard attachment failed/)
    const rejectionAt = Date.now()
    expect(treeSettledAt).toBeGreaterThan(0)
    expect(treeSettledAt).toBeLessThanOrEqual(rejectionAt)
    expect(await Bun.file(childPidFile).exists()).toBe(false)
    expect(await Bun.file(descendantPidFile).exists()).toBe(false)
    expect(await Bun.file(terminatedFile).exists()).toBe(false)
    expect(await Bun.file(credential).exists()).toBe(false)
    expect(await Bun.file(emittedFile).exists()).toBe(false)
    expect(await profileGuard.waitForTree(attachedPid!, 0)).toBe(true)
    profileGuard.release()
    released = true
    const mutation = acquireProfileGuard("omp", ["default"], "repair", root)
    mutation.release()
    await Bun.sleep(2_700)
    expect(await Bun.file(credential).exists()).toBe(false)
    expect(await Bun.file(emittedFile).exists()).toBe(false)
  } finally {
    if (!released && attachedPid !== undefined) {
      profileGuard.signalTree(attachedPid, "SIGKILL")
      await profileGuard.waitForTree(attachedPid, 1_000)
    }
    await admission.catch(() => undefined)
    profileGuard.release()
    db.close()
  }
})

test("OMP admission bounds failed tree cleanup while owned work remains alive", async () => {
  const { dependencies, root, work } = await world()
  const lifecycle = path.join(root, "omp-lifecycle-cleanup-timeout")
  const ready = path.join(root, "omp-cleanup-ready")
  await writeFile(lifecycle, `#!/bin/sh
trap '' TERM
printf ready > "$OMP_TEST_READY"
while :; do :; done
`, { mode: 0o755 })
  const prepared = await prepareRun({ ...base, harness: "omp", profiles: ["default"] }, dependencies())
  const profileGuard = acquireProfileGuard("omp", ["default"], "run", root)
  let childPid: number | undefined
  const admission = ompAdapter.resolveLaunch!({
    resumeArgs: [],
    layout: prepared.layout,
    plan: prepared.plan,
    planMode: false,
    model: "gpt-5.6-sol",
    effort: "medium",
    forwardedArgs: [],
    workspace: work,
    environment: {
      HOME: root,
      PATH: process.env.PATH ?? "",
      OMP_TEST_READY: ready,
      TRELLAGE_OMP_LIFECYCLE_BIN: lifecycle,
    },
    guard: {
      attachChild: (pid, grouped) => {
        childPid = pid
        profileGuard.attachChild(pid, grouped)
      },
      signalTree: (pid, signal) => {
        if (signal === "SIGKILL") throw new Error("cannot signal admission tree")
        profileGuard.signalTree(pid, signal)
      },
      waitForTree: profileGuard.waitForTree,
    },
  }, prepared.launch)
  const outcome = admission.then(() => "unexpected launch", (error) => String(error))
  try {
    for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt += 1) await Bun.sleep(10)
    expect(existsSync(ready)).toBe(true)
    process.emit("SIGTERM")
    expect(await Promise.race([outcome, Bun.sleep(3_500).then(() => "cleanup timed out")]))
      .toMatch(/admission cleanup did not settle/)
    expect(await profileGuard.waitForTree(childPid!, 0)).toBe(false)
  } finally {
    if (childPid !== undefined) {
      profileGuard.signalTree(childPid, "SIGKILL")
      await profileGuard.waitForTree(childPid, 1_000)
    }
    await outcome
    profileGuard.release()
  }
})

test("OMP headless policy creates a per-launch overlay and cleans it after settlement", async () => {
  const { dependencies, root, work } = await world()
  const lifecycle = path.join(root, "omp-lifecycle-headless")
  const executable = path.join(root, "host-omp-headless")
  const managedOverlay = path.join(root, "omp-managed-headless.yml")
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  await writeFile(managedOverlay, "setupVersion: 1\n", { mode: 0o600 })
  await writeFile(
    lifecycle,
    `#!/bin/sh
printf '%s\\n' ${JSON.stringify(
      JSON.stringify({
        schemaVersion: 1,
        executable,
        ompProfile: "trellage-qwen-local",
        piConfigFiles: managedOverlay,
        version: "18.8.5",
        copilotCredentialFile: null,
      }),
    )}
`,
    { mode: 0o755 },
  )
  const prepared = await prepareRun({ ...base, harness: "omp", profiles: ["local"] }, dependencies())
  const input: LaunchInput = {
    resumeArgs: [],
    layout: prepared.layout,
    plan: prepared.plan,
    planMode: false,
    model: "gpt-5.6-sol",
    effort: "medium",
    forwardedArgs: ["--headless-policy=no-user-input", "-p", "hello"],
    workspace: work,
    environment: {
      HOME: root,
      PATH: process.env.PATH ?? "",
      TRELLAGE_OMP_LIFECYCLE_BIN: lifecycle,
    },
  }
  const launch = await ompAdapter.resolveLaunch!(input, prepared.launch)
  const overlayIndex = launch.args.indexOf("--config")
  expect(overlayIndex).toBeGreaterThan(-1)
  const overlay = launch.args[overlayIndex + 1]!
  expect(path.isAbsolute(overlay)).toBe(true)
  expect(await readFile(overlay, "utf8")).toBe("ask:\n  enabled: false\n")
  expect(launch.args.slice(overlayIndex + 2)).toEqual(["-p", "hello"])
  await launch.cleanup?.()
  await expect(readFile(overlay, "utf8")).rejects.toThrow()
})

test("a canonical OMP run attaches its child and holds the mutation guard until exit", async () => {
  const { dependencies, root } = await world()
  const lifecycle = path.join(root, "omp-lifecycle-guard")
  const executable = path.join(root, "host-omp-guard")
  const managedOverlay = path.join(root, "omp-managed-guard.yml")
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  await writeFile(managedOverlay, "setupVersion: 1\n", { mode: 0o600 })
  await writeFile(
    lifecycle,
    `#!/bin/sh
printf '%s\\n' ${JSON.stringify(
      JSON.stringify({
        schemaVersion: 1,
        executable,
        ompProfile: "trellage-copilot-native",
        piConfigFiles: managedOverlay,
        version: "18.8.5",
        copilotCredentialFile: null,
      }),
    )}
`,
    { mode: 0o755 },
  )
  let runPromise: Promise<number> | undefined
  const childStarted = new Promise<number>((resolve) => {
    const spawner: Spawner = async (_launch, _environment, _cwd, onSpawn) => {
      const child = spawn("sleep", ["0.25"], { stdio: "ignore" })
      child.once("spawn", () => {
        onSpawn(child.pid)
        resolve(child.pid ?? -1)
      })
      await new Promise<void>((done, reject) => {
        child.once("error", reject)
        child.once("exit", () => done())
      })
      return 0
    }
    runPromise = runNative(
      { ...base, allowUnprovenIsolation: true, harness: "omp", profiles: ["default"] },
      {
        ...dependencies(spawner),
        environment: {
          ...dependencies(spawner).environment,
          TRELLAGE_OMP_LIFECYCLE_BIN: lifecycle,
        },
      },
    )
  })
  let db: Database | undefined
  try {
    const pid = await childStarted
    expect(pid).toBeGreaterThan(0)
    db = new Database(path.join(root, ".local/share/trellage/profile-guards/profiles.sqlite"))
    const owners = db
      .query<{ scope: string; operation: string; child_pid: number | null }, []>(
        "SELECT scope, operation, child_pid FROM owners",
      )
      .all()
    expect(owners).toHaveLength(1)
    expect(owners[0]).toMatchObject({ scope: "omp/copilot", operation: "run", child_pid: pid })
    expect(() => acquireProfileGuard("omp", ["default"], "repair", root)).toThrow(/profile busy/)
    expect(runPromise).toBeDefined()
    await expect(runPromise!).resolves.toBe(0)
    expect(db.query("SELECT scope FROM owners").all()).toHaveLength(0)
  } finally {
    await runPromise?.catch(() => undefined)
    db?.close()
  }
})

test("a failed OMP guard admission releases its generation lease", async () => {
  const { dependencies, paths, root } = await world()
  const options = { ...base, allowUnprovenIsolation: true, harness: "omp", profiles: ["default"] }
  const prepared = await prepareRun(options, dependencies())
  const mutation = acquireProfileGuard("omp", ["default"], "repair", root)
  try {
    await expect(runNative(options, dependencies())).rejects.toThrow(/profile busy/)
    await expect(readdir(path.join(paths.state, "leases", prepared.plan.generationId))).resolves.toEqual([])
  } finally {
    mutation.release()
  }
})

test.each(["override", "managed"] as const)("JCode resolves its private mise executable through %s lifecycle", async (mode) => {
  const { dependencies, root, work } = await world()
  const lifecycle = mode === "override" ? path.join(root, "jcx") : path.join(root, ".local/share/trellage/jcx/bin/jcx")
  await mkdir(path.dirname(lifecycle), { recursive: true })
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
    environment: {
      HOME: root,
      PATH: "/usr/bin:/bin",
      TRELLAGE_TRX_NATIVE_SOURCE: "1",
      ...(mode === "override" ? { TRELLAGE_JCODE_LIFECYCLE_BIN: lifecycle } : {}),
    },
    workspace: work,
  }
  expect((await jcodeAdapter.resolveLaunch!(input, prepared.launch)).command).toBe(managed)
  await writeFile(lifecycle, "#!/bin/sh\nprintf 'missing fixture receipt\\n' >&2\nexit 1\n", { mode: 0o755 })
  await expect(jcodeAdapter.resolveLaunch!(input, prepared.launch)).rejects.toThrow(
    "JCode admission failed: missing fixture receipt",
  )
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

test("Native Claude stages a complete selected plugin with explicit MCP and option policy", async () => {
  const { dependencies, root } = await world(`schema_version = 1
[native.sources.office-content]
repository = "example/office"
[native.profiles.blog]
plugins = [{
  source = "office-content",
  harness = "claude",
  path = "plugins/sample",
  name = "sample",
  plugin = "sample",
  marketplace = "fixture-market",
  includeMcp = false,
  settings = { mode = "minimal" }
}]
`)
  const prepared = await prepareRun({ ...base, harness: "claude", profiles: ["blog"] }, dependencies())
  const pluginDirectory = path.join(prepared.layout.generationPath, "plugins", "sample")
  const settings = JSON.parse(await readFile(path.join(prepared.layout.generationPath, "settings.json"), "utf8"))
  expect(await readFile(path.join(pluginDirectory, "commands/check.md"), "utf8")).toContain("# Check")
  expect(existsSync(path.join(pluginDirectory, ".mcp.json"))).toBe(false)
  expect(settings.enabledPlugins["sample@fixture-market"]).toBe(true)
  expect(settings.pluginConfigs["sample@fixture-market"]).toEqual({ options: { mode: "minimal" } })
  expect(prepared.launch.args).toContain(path.join(prepared.layout.generationPath, "plugins", "sample"))
  expect(prepared.plan.plugins[0]?.digest).toMatch(/^[a-f0-9]{64}$/)
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
printf '%s\\n' '${JSON.stringify({ installedPlugins: "INSTALL_ROOT", pluginRegistrations: [{ name: "hve-core", marketplace: "hve-core", enabled: true, cache_path: "INSTALL_ROOT/hve-core/hve-core" }], settings: { enabledPlugins: { "hve-core@hve-core": true }, hooks: { sessionStart: [] }, subagents: { reviewer: { description: "review" } } } }).replaceAll("INSTALL_ROOT", installedPlugins)}'
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
  const config = JSON.parse(await readFile(path.join(prepared.layout.generationPath, "config.json"), "utf8"))
  expect(config.installedPlugins).toEqual([
    {
      name: "hve-core",
      marketplace: "hve-core",
      enabled: true,
      cache_path: path.join(installedPlugins, "hve-core", "hve-core"),
    },
  ])
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
  const { dependencies, lines, root } = await world()
  const extensionHome = path.join(root, ".local", "share", "trellage", "pi-extensions", "node_modules")
  for (const name of PI_EXTENSION_PACKAGES) {
    const extensionRoot = path.join(extensionHome, name)
    await mkdir(extensionRoot, { recursive: true })
    await writeFile(
      path.join(extensionRoot, "package.json"),
      JSON.stringify({ pi: { extensions: ["dist/index.ts"] } }),
    )
  }
  let launched: Parameters<Spawner>[0] | undefined
  const spawner: Spawner = async (launch, _environment, _cwd, onSpawn) => {
    launched = launch
    onSpawn()
    return 0
  }
  const status = await runNative({ ...base, harness: "pi", profiles: ["superpowers", "office"] }, dependencies(spawner))
  expect(status).toBe(0)
  expect(launched!.args.slice(0, 4)).toEqual([
    "--no-skills",
    "--no-extensions",
    "--extension",
    "builtin:codemode",
  ])
  expect(launched!.args).toContain("--no-prompt-templates")
  expect(launched!.args).toContain("--no-approve")
  for (const name of PI_EXTENSION_PACKAGES) {
    expect(launched!.args).toContain(path.join(extensionHome, name, "dist/index.ts"))
  }
  expect(piExtensionEntries({ HOME: root })).toEqual(
    PI_EXTENSION_PACKAGES.map((name) => path.join(extensionHome, name, "dist/index.ts")),
  )
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

test("--skill composes only the named skills, reusing a configured source", async () => {
  const { dependencies } = await world()
  const options = parseRunArguments(["pi", "--no-always", "--skill", "example/superpowers:writing-plans", "--skill=example/office:powerpoint"])
  expect(options.skills).toEqual(["example/superpowers:writing-plans", "example/office:powerpoint"])
  const prepared = await prepareRun({ ...base, ...options }, dependencies())
  expect(prepared.plan.skills.map((skill) => skill.name)).toEqual(["powerpoint", "writing-plans"])
  expect(prepared.plan.sources.map((source) => source.sourceId).sort()).toEqual(["office-content", "superpowers"])
  expect(() => parseRunArguments(["pi", "--skill", "writing-plans"])).toThrow(/OWNER\/REPO:NAME/)
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
  for (const name of PI_EXTENSION_PACKAGES) {
    const extension = path.join(root, "node_modules", name)
    await mkdir(extension, { recursive: true })
    await writeFile(path.join(extension, "package.json"), JSON.stringify({ version: "0.58.4" }))
  }

  const queried: string[] = []
  const needsUpdate = await piExtensionsNeedUpdate(
    { HOME: root, TRELLAGE_PI_EXTENSIONS_HOME: root },
    async (name) => (queried.push(name), "0.58.4"),
  )

  expect(needsUpdate).toBe(false)
  expect(queried).toEqual([...PI_EXTENSION_PACKAGES])
})

test("Pi extension freshness installs missing or outdated packages", async () => {
  const root = await tempRoot("pi-extensions-outdated")
  const environment = { HOME: root, TRELLAGE_PI_EXTENSIONS_HOME: root }
  expect(await piExtensionsNeedUpdate(environment, async () => "0.58.4")).toBe(true)

  for (const name of PI_EXTENSION_PACKAGES) {
    const extension = path.join(root, "node_modules", name)
    await mkdir(extension, { recursive: true })
    await writeFile(
      path.join(extension, "package.json"),
      JSON.stringify({ version: name === "@narumitw/pi-goal" ? "0.58.3" : "0.58.4" }),
    )
  }
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

test("Copilot generations drop disable-model-invocation; other harnesses keep it", async () => {
  const { dependencies, office } = await world()
  await office.write({ "skills/powerpoint/SKILL.md": "---\nname: powerpoint\ndescription: Slides.\ndisable-model-invocation: true\n---\n\nBody\n" })
  const copilot = await prepareRun({ ...base, harness: "copilot", profiles: ["office"] }, dependencies())
  const copied = await readFile(path.join(copilot.layout.generationPath, "skills", "powerpoint", "SKILL.md"), "utf8")
  expect(copied).not.toContain("disable-model-invocation")
  expect(copied).toContain("name: powerpoint")
  const claude = await prepareRun({ ...base, harness: "claude", profiles: ["office"] }, dependencies())
  const kept = await readFile(path.join(claude.layout.generationPath, "skills", "powerpoint", "SKILL.md"), "utf8")
  expect(kept).toContain("disable-model-invocation: true")
})

const CLAUDE_CLEAN_ARGS = [
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--settings",
  '{"skipDangerousModePermissionPrompt":true}',
]

const cleanWorld = async () => {
  const w = await world()
  const configPath = path.join(w.root, "absent", "config.toml")
  const dependencies = (spawner?: Spawner): RunDependencies => {
    const shared = w.dependencies(spawner)
    return { ...shared, environment: { ...shared.environment, TRELLAGE_CONFIG: configPath, HOME: w.root } }
  }
  return { ...w, configPath, dependencies }
}

test("Claude clean publishes an empty generation without reading or creating the user config", async () => {
  const { dependencies, configPath } = await cleanWorld()
  const prepared = await prepareRun({ ...base, harness: "claude", profiles: ["clean"] }, dependencies())
  expect(existsSync(configPath)).toBe(false)
  expect(prepared.plan.skills).toEqual([])
  expect(prepared.plan.instructions).toEqual([])
  expect(prepared.plan.sources).toEqual([])
  expect(prepared.launch.args.slice(0, CLAUDE_CLEAN_ARGS.length)).toEqual(CLAUDE_CLEAN_ARGS)
  expect(prepared.launch.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1")
  const files = await readdir(prepared.layout.generationPath)
  expect(files).toContain(".claude.json")
  expect(files).toContain("manifest.json")
  expect(files).not.toContain("settings.json")
  expect(files).not.toContain("statusline.sh")
})

test("clean ignores always-on profiles and loads no Pi skills, extensions or context files", async () => {
  const { dependencies } = await alwaysWorld()
  const pi = await prepareRun({ ...base, harness: "pi", profiles: ["clean"] }, dependencies())
  expect(pi.plan.skills).toEqual([])
  expect(existsSync(path.join(pi.layout.generationPath, "APPEND_SYSTEM.md"))).toBe(false)
  expect(pi.launch.args).not.toContain("--skill")
  expect(pi.launch.args).not.toContain("--extension")
  expect(pi.launch.args).toContain("--no-context-files")
  expect(pi.launch.args).toContain("--no-mcp")
})

test("Codex clean ignores host Codex defaults and disables repository docs and skills", async () => {
  const { dependencies, root } = await cleanWorld()
  await mkdir(path.join(root, ".codex"))
  await writeFile(path.join(root, ".codex", "config.toml"), 'model = "host-model"\nmodel_reasoning_effort = "high"\n')
  const codex = await prepareRun(
    { ...base, harness: "codex", profiles: ["clean"], forwardedArgs: ["exec", "hi"] },
    dependencies(),
  )
  const args = codex.launch.args
  expect(args).not.toContain("-m")
  expect(args).not.toContain("host-model")
  const at = (value: string) => args.findIndex((argument, index) => argument === "-c" && args[index + 1] === value)
  expect(at("project_doc_max_bytes=0")).toBeGreaterThanOrEqual(0)
  expect(at("skills.include_instructions=false")).toBeGreaterThanOrEqual(0)
  expect(at("project_doc_max_bytes=0")).toBeLessThan(args.indexOf("exec"))
  expect(at("skills.include_instructions=false")).toBeLessThan(args.indexOf("exec"))
})

test("clean runs skip harness refresh and admission and count as proven isolation", async () => {
  const { dependencies } = await cleanWorld()
  const refreshed: string[] = []
  const spawner: Spawner = async (_launch, _environment, _cwd, onSpawn) => {
    onSpawn()
    return 0
  }
  const shared = dependencies(spawner)
  const claude = await runNative(
    { ...base, harness: "claude", profiles: ["clean"], allowUnprovenIsolation: false },
    {
      ...shared,
      environment: { ...shared.environment, TRELLAGE_CLAUDE_LIFECYCLE_BIN: "/nonexistent/claude-lifecycle" },
      refreshHarness: async (harness) => (refreshed.push(harness), undefined),
    },
  )
  expect(claude).toBe(0)
  const pi = await runNative(
    { ...base, harness: "pi", profiles: ["clean"], allowUnprovenIsolation: false },
    { ...shared, refreshHarness: async (harness) => (refreshed.push(harness), undefined) },
  )
  expect(pi).toBe(0)
  expect(refreshed).toEqual([])
})

test("clean rejects unsupported harnesses and mixed selections", async () => {
  const { dependencies } = await cleanWorld()
  await expect(prepareRun({ ...base, harness: "grok", profiles: ["clean"] }, dependencies())).rejects.toThrow(
    /Grok cannot run clean: .*Clean runs support: claude, codex, copilot, pi/,
  )
  await expect(prepareRun({ ...base, harness: "claude", profiles: ["clean", "office"] }, dependencies())).rejects.toThrow(
    /cannot be combined/,
  )
  await expect(
    prepareRun({ ...base, harness: "claude", profiles: ["clean"], skills: ["a/b:c"] }, dependencies()),
  ).rejects.toThrow(/cannot be combined/)
})

test("clean resume command names the clean profile", () => {
  expect(resumeCommand({ ...base, harness: "claude", profiles: ["clean"] })).toBe("trx run claude clean --continue")
})

test("Codex clean refuses a repository .codex layer up to the git root but not above it", async () => {
  const { dependencies, root, work } = await cleanWorld()
  await mkdir(path.join(work, ".codex"))
  await writeFile(path.join(work, ".codex", "config.toml"), 'developer_instructions = "repo"\n')
  await expect(prepareRun({ ...base, harness: "codex", profiles: ["clean"] }, dependencies())).rejects.toThrow(
    /cannot run clean here: .*\.codex/,
  )
  const nested = path.join(work, "sub", "dir")
  await mkdir(nested, { recursive: true })
  await expect(
    prepareRun({ ...base, harness: "codex", profiles: ["clean"] }, { ...dependencies(), cwd: nested }),
  ).rejects.toThrow(/cannot run clean here: .*\.codex/)
  await rm(path.join(work, ".codex"), { recursive: true })
  await mkdir(path.join(root, ".codex"))
  const codex = await prepareRun({ ...base, harness: "codex", profiles: ["clean"] }, dependencies())
  expect(codex.plan.skills).toEqual([])
})

test("Claude pins default model ids only for concrete models, never for aliases", async () => {
  const { dependencies } = await cleanWorld()
  const normal = await prepareRun({ ...base, harness: "claude", profiles: ["default"] }, dependencies())
  expect(normal.launch.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
  const clean = await prepareRun({ ...base, harness: "claude", profiles: ["clean"] }, dependencies())
  expect(clean.launch.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined()
  const concrete = await prepareRun(
    { ...base, harness: "claude", profiles: ["default"], model: "claude-opus-5" },
    dependencies(),
  )
  expect(concrete.launch.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("claude-opus-5")
  expect(concrete.launch.env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe("claude-opus-5")
})

const capture = () => {
  const launches: LaunchCommand[] = []
  const spawner: Spawner = async (launch, _environment, _cwd, onSpawn) => {
    launches.push(launch)
    onSpawn()
    return 0
  }
  return { launches, spawner }
}

test("Codex clean disables every skill its app server still lists", async () => {
  const { dependencies, root } = await cleanWorld()
  const fake = path.join(root, "fake-codex")
  await writeFile(
    fake,
    `#!${process.execPath}
const lines = require("node:readline").createInterface({ input: process.stdin })
lines.on("line", (line) => {
  const message = JSON.parse(line)
  if (message.id === 1) console.log(JSON.stringify({ id: 1, result: {} }))
  if (message.id === 2)
    console.log(JSON.stringify({ id: 2, result: { data: [{ skills: [
      { name: "a", path: "/a/SKILL.md", enabled: true },
      { name: "b", path: "/b/SKILL.md", enabled: true },
      { name: "c", path: "/c/SKILL.md", enabled: false },
    ] }] } }))
})
`,
    { mode: 0o755 },
  )
  const { launches, spawner } = capture()
  const shared = dependencies(spawner)
  const status = await runNative(
    { ...base, harness: "codex", profiles: ["clean"], forwardedArgs: ["exec", "hi"] },
    { ...shared, environment: { ...shared.environment, TRELLAGE_CODEX_BIN: fake } },
  )
  expect(status).toBe(0)
  const args = launches[0]!.args
  const config = args.indexOf('skills.config=[{path="/a/SKILL.md",enabled=false},{path="/b/SKILL.md",enabled=false}]')
  expect(args[config - 1]).toBe("-c")
  expect(config).toBeLessThan(args.indexOf("exec"))
  expect(args.slice(0, 2)).toEqual(["-c", "project_doc_max_bytes=0"])
})

test("Copilot clean disables listed skills and MCP servers and refuses repository hooks", async () => {
  const { dependencies, root, work } = await cleanWorld()
  const fake = path.join(root, "fake-copilot")
  await writeFile(
    fake,
    `#!/bin/sh
case "$*" in
  *"skill list"*) echo '[{"name":"repo-skill","source":"project","enabled":true},{"name":"host-skill","source":"personal","enabled":true}]' ;;
  *"mcp list"*) echo '{"mcpServers":{"repo-server":{},"host-server":{}}}' ;;
  *) exit 9 ;;
esac
`,
    { mode: 0o755 },
  )
  const { launches, spawner } = capture()
  const shared = dependencies(spawner)
  const environment = { ...shared.environment, TRELLAGE_COPILOT_BIN: fake }
  const status = await runNative(
    { ...base, harness: "copilot", profiles: ["clean"] },
    { ...shared, environment },
  )
  expect(status).toBe(0)
  const launch = launches[0]!
  expect(launch.args.slice(0, 8)).toEqual([
    "--no-auto-update",
    "--no-custom-instructions",
    "--disable-builtin-mcps",
    "--excluded-tools=task,read_agent,list_agents,write_agent",
    "--disable-mcp-server",
    "repo-server",
    "--disable-mcp-server",
    "host-server",
  ])
  const settings = JSON.parse(await readFile(path.join(launch.env.COPILOT_HOME!, "settings.json"), "utf8"))
  expect(settings).toEqual({ disabledSkills: ["repo-skill", "host-skill"], memory: false })
  expect(existsSync(path.join(launch.env.COPILOT_HOME!, "installed-plugins"))).toBe(false)
  await expect(
    prepareRun(
      { ...base, harness: "copilot", profiles: ["clean"], forwardedArgs: ["--enable-mcp-server=repo-server"] },
      { ...shared, environment },
    ),
  ).rejects.toThrow("--enable-mcp-server cannot be forwarded to a clean Copilot run")
  await mkdir(path.join(work, ".github", "hooks"), { recursive: true })
  await expect(
    prepareRun({ ...base, harness: "copilot", profiles: ["clean"] }, { ...shared, environment }),
  ).rejects.toThrow(/cannot run clean here: .*\.github\/hooks/)
})
