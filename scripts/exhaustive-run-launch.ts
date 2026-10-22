import assert from "node:assert/strict"
import { expectedRunSuffix } from "./exhaustive-run-command.ts"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { nativePresetProfiles, type RunOptions } from "@trellage/runtime/native-run"
import type { createRunWorld } from "./exhaustive-run-world.ts"
import type { assertRunSelection } from "./exhaustive-run-selection.ts"

type World = Awaited<ReturnType<typeof createRunWorld>>
type Manifest = Awaited<ReturnType<typeof assertRunSelection>>
type Launch = World["launches"][number]["launch"]
type Check = {
  options: RunOptions
  world: World
  generation: string
  manifest: Manifest
  id: string
  launch: Launch
  harness: string
  clean: boolean
  plan: boolean
  model: string | undefined
  effort: string | undefined
  args: string[]
}

const homeKeys: Record<string, string> = {
  agency: "COPILOT_HOME",
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  copilot: "COPILOT_HOME",
  grok: "GROK_HOME",
  jcode: "JCODE_HOME",
  pi: "PI_CODING_AGENT_DIR",
  prime: "PRIME_AGENT_CODING_AGENT_DIR",
  uji: "UJI_CONFIG_DIR",
}

const expectedCommand = (harness: string, world: World) => {
  if (harness === "prime") return world.runtime.cli
  if (harness === "omp") return world.runtime.executable
  if (harness === "jcode") return world.admission.executable
  return world.dependencies.environment[`TRELLAGE_${harness.toUpperCase()}_BIN`]
}

const presetOf = (harness: string, manifest: Manifest) => {
  const presetPrefix = `preset-${harness}-`
  return (
    manifest.profiles.find((name) => name.startsWith(presetPrefix))?.slice(presetPrefix.length) ??
    manifest.profiles.find((name) => nativePresetProfiles(harness).includes(name)) ??
    (harness === "copilot" ? "hve" : "default")
  )
}

const launchDefaults = (harness: string, preset: string, plan: boolean, id: string) => {
  const defaults: Record<string, [string | undefined, string | undefined]> = {
    agency: ["gpt-6-astra", "medium"],
    claude: ["claude-opus-5.5", plan ? "max" : "medium"],
    codex: [undefined, "medium"],
    copilot: ["gpt-6-astra", "medium"],
    fx: [plan ? "gpt-6-astra" : "gpt-6.1-sol", plan ? "max" : "medium"],
    grok: ["grok-4.7", "medium"],
    headlong: ["claude-sonnet-5", undefined],
    jcode: ["gpt-5.6-sol", "medium"],
    omp: preset === "local" ? [undefined, "medium"] : ["gpt-5.6-sol", "medium"],
    pi: ["gpt-6-astra", "medium"],
    prime: ["claude-opus-5.5", undefined],
    uji: ["copilot-proxy-rs/gpt-6-astra", "medium"],
  }
  assert(Object.hasOwn(defaults, harness), `${id}: missing launch-value oracle`)
  return defaults[harness]!
}

const stripAdmission = (c: Pick<Check, "args" | "clean" | "harness" | "world" | "id">, preset: string) => {
  let args = c.args
  if (!c.clean && c.harness === "claude" && ["default", "office", "office-charts"].includes(preset)) {
    assert.deepEqual(args.slice(-2), ["--plugin-dir", c.world.admission.plugin], c.id)
    args = args.slice(0, -2)
  }
  return args
}

const stripSuffix = (args: string[], options: RunOptions, id: string) => {
  const suffix = expectedRunSuffix(options)
  if (!suffix.length) return args
  assert.deepEqual(args.slice(-suffix.length), suffix, `${id}: resume/forwarded arguments`)
  return args.slice(0, -suffix.length)
}

const checkAgency = (c: Check) =>
  assert.deepEqual(
    c.args,
    ["copilot", "--profile-only", "trellage-azure", "--", "--model", c.model!, "--effort", c.effort!],
    c.id,
  )

const checkJcode = (c: Check) => {
  assert.deepEqual(c.args, ["--no-update"], c.id)
  assert.equal(c.launch.env.JCODE_MODEL, c.model, c.id)
  assert.equal(c.launch.env.JCODE_OPENAI_REASONING_EFFORT, c.effort, c.id)
}

const checkHeadlong = (c: Check) => {
  assert.deepEqual(c.args, [], c.id)
  assert.equal(c.launch.env.SHELLM_MODEL, c.model, c.id)
}

const checkFx = (c: Check) => {
  assert.deepEqual(c.args, ["--effort", c.effort!], c.id)
  assert.equal(c.launch.env.FX_MODEL, c.model, c.id)
}

const checkUji = (c: Check) => {
  assert.deepEqual(c.args, [], c.id)
  assert.equal(c.launch.env.TRX_UJI_MODEL, c.model, c.id)
  assert.equal(c.launch.env.TRX_UJI_EFFORT, c.effort ?? null, c.id)
  assert.equal(c.launch.env.TRX_UJI_PLAN, c.plan ? "1" : null, c.id)
}

const checkGrok = (c: Check) => {
  assert.deepEqual(
    c.args,
    [
      "--sandbox",
      "trellage-workspace",
      "--permission-mode",
      "bypassPermissions",
      "--always-approve",
      "--trust",
      "--model",
      c.model!,
      "--reasoning-effort",
      c.effort!,
    ],
    c.id,
  )
  assert.equal(c.launch.env.GROK_DEFAULT_MODEL, c.model, c.id)
}

const checkPrime = (c: Check) =>
  assert.deepEqual(
    c.args,
    [
      "--provider",
      "copilot-proxy-rs",
      "--model",
      c.model!,
      "--offline",
      "--autonomous",
      "--daemon-socket",
      c.world.runtime.prime.daemonSocket,
    ],
    c.id,
  )

const readOptional = (file: string) =>
  readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })

const checkOmp = async (c: Check) => {
  const instructions = await readOptional(path.join(c.generation, "always-on.md"))
  const model = c.model
  assert.deepEqual(
    c.args,
    [
      ...(instructions === undefined ? [] : ["--append-system-prompt", instructions]),
      ...(model ? ["--model", model.includes("/") ? model : `github-copilot/${model}`] : []),
      ...(c.effort ? ["--thinking", c.effort] : []),
    ],
    c.id,
  )
}

const copilotCleanPrefix = [
  "--no-auto-update",
  "--no-custom-instructions",
  "--disable-builtin-mcps",
  "--excluded-tools=task,read_agent,list_agents,write_agent",
  "--disable-mcp-server",
  "fixture-server",
]

const checkCopilot = (c: Check) => {
  const planned = c.plan || c.options.forwardedArgs.includes("--plan")
  assert.deepEqual(
    c.args,
    [
      ...(c.clean ? copilotCleanPrefix : []),
      ...(planned ? ["--plan"] : ["--autopilot", "--allow-all", "--no-ask-user"]),
      "--model",
      c.model!,
      "--effort",
      c.effort!,
    ],
    c.id,
  )
}

const claudeCleanPrefix = [
  "--setting-sources",
  "",
  "--strict-mcp-config",
  "--disable-slash-commands",
  "--settings",
  '{"skipDangerousModePermissionPrompt":true}',
]

const claudeInteractivePresets = ["blog", "council", "ecc", "frontend-design", "research", "social-media"]

const checkClaude = (c: Check) => {
  const interactive = c.manifest.profiles.some((name) =>
    claudeInteractivePresets.some((preset) => name === `preset-claude-${preset}`),
  )
  const pluginArgs = c.manifest.plugins.flatMap((plugin) => [
    "--plugin-dir",
    path.join(c.generation, "plugins", plugin.name),
  ])
  const permissions = c.plan
    ? ["--allow-dangerously-skip-permissions", "--effort", c.effort!]
    : ["--dangerously-skip-permissions", "--permission-mode", "bypassPermissions"]
  assert.deepEqual(
    c.args,
    [
      ...(c.clean ? claudeCleanPrefix : []),
      ...pluginArgs,
      ...permissions,
      ...(interactive ? [] : ["--disallowedTools", "AskUserQuestion"]),
      "--model",
      c.model!,
      ...(c.plan ? ["--permission-mode", "plan"] : ["--effort", c.effort!]),
    ],
    c.id,
  )
}

const checkCodex = (c: Check) => {
  const positions = c.args.flatMap((arg, index) => (arg === "-m" ? [index] : []))
  assert.equal(positions.length, c.model === undefined ? 0 : 1, `${c.id}: -m count`)
  if (c.model !== undefined) assert.equal(c.args[positions[0]! + 1], c.model, `${c.id}: -m value`)
  assert.deepEqual(
    c.args.filter((arg) => arg.startsWith("model_reasoning_effort=")),
    c.effort ? [`model_reasoning_effort="${c.effort}"`] : [],
    c.id,
  )
}

const piProvider = (model: string) => (model.startsWith("claude-") ? "copilot-proxy-rs-claude" : "copilot-proxy-rs")

const piCleanLoading = [
  "--no-skills",
  "--no-extensions",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-mcp",
  "--no-themes",
  "--no-approve",
]

const checkPi = (c: Check) => {
  const loading = c.clean
    ? piCleanLoading
    : [
        "--no-skills",
        "--no-extensions",
        "--extension",
        "builtin:codemode",
        "--no-prompt-templates",
        "--no-approve",
        ...c.manifest.skills.flatMap((skill) => ["--skill", path.join(c.generation, "skills", skill.name)]),
      ]
  assert.deepEqual(
    c.args,
    [
      ...loading,
      "--session-dir",
      path.join(path.dirname(path.dirname(c.generation)), "sessions"),
      "--provider",
      piProvider(c.model!),
      "--model",
      c.model!,
      "--thinking",
      c.effort!,
    ],
    c.id,
  )
}

const argumentChecks: Record<string, (c: Check) => void | Promise<void>> = {
  agency: checkAgency,
  claude: checkClaude,
  codex: checkCodex,
  copilot: checkCopilot,
  fx: checkFx,
  grok: checkGrok,
  headlong: checkHeadlong,
  jcode: checkJcode,
  omp: checkOmp,
  pi: checkPi,
  prime: checkPrime,
  uji: checkUji,
}

const checkFirstmatePi = async (c: Check) => {
  const provider = piProvider(c.model!)
  const directory = c.world.firstmate.directory
  assert.equal(
    await readFile(path.join(directory, "config/pi-account"), "utf8"),
    `${c.generation}\n${provider}\n`,
    c.id,
  )
  assert.deepEqual(
    JSON.parse(await readFile(path.join(directory, "config/crew-dispatch.json"), "utf8")),
    {
      rules: [],
      default: {
        harness: "pi",
        model: `${provider}/${c.model}`,
        effort: c.effort,
        why: "Written by trx run pi firstmate",
      },
    },
    c.id,
  )
}

const claudeSettingsKeys = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
  "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
]

const checkFirstmateClaude = async (c: Check) => {
  const settings = JSON.parse(await readFile(path.join(c.generation, "settings.json"), "utf8"))
  for (const key of claudeSettingsKeys)
    if (typeof c.launch.env[key] === "string") assert.equal(settings.env[key], c.launch.env[key], c.id)
}

const firstmateChecks: Record<string, (c: Check) => Promise<void>> = {
  claude: checkFirstmateClaude,
  pi: checkFirstmatePi,
}

export const assertRunLaunch = async (
  options: RunOptions,
  world: World,
  generation: string,
  manifest: Manifest,
  id: string,
) => {
  const { launch } = world.launches[0]!
  const harness = options.harness,
    clean = options.profiles.includes("clean"),
    plan = options.plan === true
  assert.equal(launch.command, expectedCommand(harness, world), id)
  const homeKey = homeKeys[harness]
  if (homeKey) assert.equal(launch.env[homeKey], generation, id)
  const preset = presetOf(harness, manifest)
  const [defaultModel, defaultEffort] = launchDefaults(harness, preset, plan, id)
  const partial = { args: [...launch.args], clean, harness, world, id }
  const args = stripSuffix(stripAdmission(partial, preset), options, id)
  const check: Check = {
    options,
    world,
    generation,
    manifest,
    id,
    launch,
    harness,
    clean,
    plan,
    model: options.model ?? defaultModel,
    effort: options.effort ?? defaultEffort,
    args,
  }
  await argumentChecks[harness]?.(check)
  if (options.profiles.includes("firstmate")) await firstmateChecks[harness]?.(check)
}
