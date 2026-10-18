import assert from "node:assert/strict"
import { expectedRunSuffix } from "./exhaustive-run-command.ts"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { nativePresetProfiles, type RunOptions } from "@trellage/runtime/native-run"
import type { createRunWorld } from "./exhaustive-run-world.ts"
import type { assertRunSelection } from "./exhaustive-run-selection.ts"

export const assertRunLaunch = async (
  options: RunOptions,
  world: Awaited<ReturnType<typeof createRunWorld>>,
  generation: string,
  manifest: Awaited<ReturnType<typeof assertRunSelection>>,
  id: string,
) => {
  const { launch } = world.launches[0]!
  const harness = options.harness,
    clean = options.profiles.includes("clean"),
    plan = options.plan === true
  assert.equal(
    launch.command,
    harness === "prime"
      ? process.execPath
      : harness === "omp"
        ? world.runtime.executable
        : harness === "jcode"
          ? world.admission.executable
          : world.dependencies.environment[`TRELLAGE_${harness.toUpperCase()}_BIN`],
    id,
  )
  const homeKey = (
    {
      agency: "COPILOT_HOME",
      claude: "CLAUDE_CONFIG_DIR",
      codex: "CODEX_HOME",
      copilot: "COPILOT_HOME",
      grok: "GROK_HOME",
      jcode: "JCODE_HOME",
      pi: "PI_CODING_AGENT_DIR",
      prime: "PRIME_AGENT_CODING_AGENT_DIR",
      uji: "UJI_CONFIG_DIR",
    } as Record<string, string>
  )[harness]
  if (homeKey) assert.equal(launch.env[homeKey], generation, id)
  const presetPrefix = `preset-${harness}-`
  const preset =
    manifest.profiles.find((name) => name.startsWith(presetPrefix))?.slice(presetPrefix.length) ??
    manifest.profiles.find((name) => nativePresetProfiles(harness).includes(name)) ??
    (harness === "copilot" ? "hve" : "default")
  const defaults: Record<string, [string | undefined, string | undefined]> = {
    agency: ["gpt-6-astra", "low"],
    claude: ["opusplan", plan ? "max" : "medium"],
    codex: [undefined, undefined],
    copilot: ["gpt-6-astra", "low"],
    fx: [plan ? "gpt-6-astra" : "gpt-6.1-sol", plan ? "max" : "medium"],
    grok: ["grok-4.7", "medium"],
    headlong: ["claude-sonnet-5", undefined],
    jcode: ["gpt-5.6-sol", "medium"],
    omp: preset === "local" ? [undefined, undefined] : ["gpt-5.6-sol", "medium"],
    pi: ["gpt-6-astra", "medium"],
    prime: ["claude-opus-5.5", undefined],
    uji: ["copilot-proxy-rs/gpt-6-astra", undefined],
  }
  assert(Object.hasOwn(defaults, harness), `${id}: missing launch-value oracle`)
  const model = options.model ?? defaults[harness]![0],
    effort = options.effort ?? defaults[harness]![1]
  const suffix = expectedRunSuffix(options)
  let args = [...launch.args]
  if (!clean && harness === "claude" && ["default", "office", "office-charts"].includes(preset)) {
    assert.deepEqual(args.slice(-2), ["--plugin-dir", world.admission.plugin], id)
    args = args.slice(0, -2)
  }
  if (suffix.length) {
    assert.deepEqual(args.slice(-suffix.length), suffix, `${id}: resume/forwarded arguments`)
    args = args.slice(0, -suffix.length)
  }
  const oneValue = (flag: string, value: string | undefined) => {
    const positions = args.flatMap((arg, index) => (arg === flag ? [index] : []))
    assert.equal(positions.length, value === undefined ? 0 : 1, `${id}: ${flag} count`)
    if (value !== undefined) assert.equal(args[positions[0]! + 1], value, `${id}: ${flag} value`)
  }
  if (harness === "agency")
    assert.deepEqual(
      args,
      ["copilot", "--profile-only", "trellage-azure", "--", "--model", model!, "--effort", effort!],
      id,
    )
  else if (harness === "jcode") {
    assert.deepEqual(args, ["--no-update"], id)
    assert.equal(launch.env.JCODE_MODEL, model, id)
    assert.equal(launch.env.JCODE_OPENAI_REASONING_EFFORT, effort, id)
  } else if (harness === "headlong") {
    assert.deepEqual(args, [], id)
    assert.equal(launch.env.SHELLM_MODEL, model, id)
  } else if (harness === "fx") {
    assert.deepEqual(args, ["--effort", effort!], id)
    assert.equal(launch.env.FX_MODEL, model, id)
  } else if (harness === "uji") {
    assert.deepEqual(args, [], id)
    assert.equal(launch.env.TRX_UJI_MODEL, model, id)
    assert.equal(launch.env.TRX_UJI_EFFORT, effort ?? null, id)
    assert.equal(launch.env.TRX_UJI_PLAN, plan ? "1" : null, id)
  } else if (harness === "grok") {
    assert.deepEqual(
      args,
      [
        "--sandbox",
        "trellage-workspace",
        "--permission-mode",
        "bypassPermissions",
        "--always-approve",
        "--trust",
        "--model",
        model!,
        "--reasoning-effort",
        effort!,
      ],
      id,
    )
    assert.equal(launch.env.GROK_DEFAULT_MODEL, model, id)
  } else if (harness === "prime") {
    assert.deepEqual(
      args,
      [
        world.runtime.cli,
        "--provider",
        "copilot-proxy-rs",
        "--model",
        model!,
        "--offline",
        "--autonomous",
        "--daemon-socket",
        world.runtime.prime.daemonSocket,
      ],
      id,
    )
  } else if (harness === "omp") {
    const instructions = await readFile(path.join(generation, "always-on.md"), "utf8").catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      },
    )
    assert.deepEqual(
      args,
      [
        ...(instructions === undefined ? [] : ["--append-system-prompt", instructions]),
        ...(model ? ["--model", model.includes("/") ? model : `github-copilot/${model}`] : []),
        ...(effort ? ["--thinking", effort] : []),
      ],
      id,
    )
  } else if (harness === "copilot") {
    const prefix = clean
      ? [
          "--no-auto-update",
          "--no-custom-instructions",
          "--disable-builtin-mcps",
          "--excluded-tools=task,read_agent,list_agents,write_agent",
          "--disable-mcp-server",
          "fixture-server",
        ]
      : []
    assert.deepEqual(
      args,
      [
        ...prefix,
        ...(plan || options.forwardedArgs.includes("--plan")
          ? ["--plan"]
          : ["--autopilot", "--allow-all", "--no-ask-user"]),
        "--model",
        model!,
        "--effort",
        effort!,
      ],
      id,
    )
  } else if (harness === "claude") {
    const prefix = clean
      ? [
          "--setting-sources",
          "",
          "--strict-mcp-config",
          "--disable-slash-commands",
          "--settings",
          '{"skipDangerousModePermissionPrompt":true}',
        ]
      : []
    const interactive = manifest.profiles.some((name) =>
      ["blog", "council", "ecc", "frontend-design", "research", "social-media"].some(
        (preset) => name === `preset-claude-${preset}`,
      ),
    )
    assert.deepEqual(
      args,
      [
        ...prefix,
        ...manifest.plugins.flatMap((plugin) => ["--plugin-dir", path.join(generation, "plugins", plugin.name)]),
        ...(plan
          ? ["--allow-dangerously-skip-permissions", "--effort", effort!]
          : ["--dangerously-skip-permissions", "--permission-mode", "bypassPermissions"]),
        ...(interactive ? [] : ["--disallowedTools", "AskUserQuestion"]),
        "--model",
        model!,
        ...(plan ? ["--permission-mode", "plan"] : ["--effort", effort!]),
      ],
      id,
    )
  } else if (harness === "codex") {
    oneValue("-m", model)
    assert.deepEqual(
      args.filter((arg) => arg.startsWith("model_reasoning_effort=")),
      effort ? [`model_reasoning_effort="${effort}"`] : [],
      id,
    )
  } else if (harness === "pi") {
    const loading = clean
      ? [
          "--no-skills",
          "--no-extensions",
          "--no-prompt-templates",
          "--no-context-files",
          "--no-mcp",
          "--no-themes",
          "--no-approve",
        ]
      : [
          "--no-skills",
          "--no-extensions",
          "--extension",
          "builtin:codemode",
          "--no-prompt-templates",
          "--no-approve",
          ...manifest.skills.flatMap((skill) => ["--skill", path.join(generation, "skills", skill.name)]),
        ]
    assert.deepEqual(
      args,
      [
        ...loading,
        "--session-dir",
        path.join(path.dirname(path.dirname(generation)), "sessions"),
        "--provider",
        model!.startsWith("claude-") ? "copilot-proxy-rs-claude" : "copilot-proxy-rs",
        "--model",
        model!,
        "--thinking",
        effort!,
      ],
      id,
    )
  }
  if (options.profiles.includes("firstmate")) {
    if (harness === "pi") {
      const provider = model!.startsWith("claude-") ? "copilot-proxy-rs-claude" : "copilot-proxy-rs"
      assert.equal(
        await readFile(path.join(world.firstmate.directory, "config/pi-account"), "utf8"),
        `${generation}\n${provider}\n`,
        id,
      )
      assert.deepEqual(
        JSON.parse(await readFile(path.join(world.firstmate.directory, "config/crew-dispatch.json"), "utf8")),
        {
          rules: [],
          default: { harness: "pi", model: `${provider}/${model}`, effort, why: "Written by trx run pi firstmate" },
        },
        id,
      )
    } else if (harness === "claude") {
      const settings = JSON.parse(await readFile(path.join(generation, "settings.json"), "utf8"))
      for (const key of [
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL",
        "ANTHROPIC_DEFAULT_OPUS_MODEL",
        "ANTHROPIC_DEFAULT_SONNET_MODEL",
        "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
        "CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT",
      ])
        if (typeof launch.env[key] === "string") assert.equal(settings.env[key], launch.env[key], id)
    }
  }
}
