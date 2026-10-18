import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, readdir, access, realpath, lstat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readTrellageConfig } from "@trellage/runtime/native-config"
import { NativeRunError, nativePresetProfiles, parseRunArguments, runNative } from "@trellage/runtime/native-run"
import { assertCliSourcesUnchanged, loadCliDomains } from "./exhaustive-cli-domains.ts"
import { createFirstmateFixture } from "./exhaustive-firstmate.ts"
import { createGithubBridge } from "./exhaustive-github-bridge.ts"
import { createRuntimeAdmission } from "./exhaustive-runtime-admission.ts"
import { createHostAdmission } from "./exhaustive-host-admission.ts"
import { createAdmissionMocks } from "./exhaustive-admission-mocks.ts"
import { createCleanRunWorld } from "./exhaustive-clean-run-world.ts"

assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "use scripts/test-offline.sh --native-sources")
assert.ok(process.env.TRELLAGE_DEV_SOURCES, "local source mappings are required")
const harness = process.argv[2]
assert.ok(
  harness === "codex" ||
    harness === "agency" ||
    harness === "jcode" ||
    harness === "fx" ||
    harness === "headlong" ||
    harness === "omp" ||
    harness === "prime" ||
    harness === "grok" ||
    harness === "uji" ||
    harness === "pi" ||
    harness === "claude" ||
    harness === "copilot",
  "expected codex, agency, jcode, fx, headlong, omp, prime, grok, uji, pi, claude, or copilot",
)
assert.equal(process.argv.length, 3, "unexpected runner arguments")
const resumeSupported = ["codex", "grok", "uji", "pi", "claude", "copilot"].includes(harness)
const homeVariable = {
  codex: "CODEX_HOME",
  agency: "COPILOT_HOME",
  jcode: "JCODE_HOME",
  fx: "",
  headlong: "",
  omp: "",
  prime: "PRIME_AGENT_CODING_AGENT_DIR",
  grok: "GROK_HOME",
  uji: "UJI_CONFIG_DIR",
  pi: "PI_CODING_AGENT_DIR",
  claude: "CLAUDE_CONFIG_DIR",
  copilot: "COPILOT_HOME",
}[harness]
const root = fileURLToPath(new URL("../", import.meta.url))
const configPath = path.join(root, "config.toml")
const {
  config: { native: catalog },
} = await readTrellageConfig({ environment: { TRELLAGE_CONFIG: configPath } })
const { run, sourceHashes: cliSourceHashes } = await loadCliDomains()
const sourceHashes = { ...cliSourceHashes }
const profiles = run.find((domain) => domain.name === "profiles")!.values
const flags = run
  .filter((domain) => domain.name.startsWith("--") && domain.values.length === 2 && domain.values[1]!.argv.length === 1)
  .map((domain) => domain.name)
assert.deepEqual(
  [...flags].sort(),
  [
    "--allow-unproven-isolation",
    "--continue",
    "--dry-run",
    "--no-always",
    "--plan",
    "--require-proven-isolation",
    "--resume",
  ],
  "Native launch oracle must cover every run boolean",
)
const hash = async (relative: string) => {
  sourceHashes[relative] = createHash("sha256")
    .update(await readFile(path.join(root, relative)))
    .digest("hex")
}
await hash("scripts/exhaustive-native-launch.ts")
await hash("scripts/exhaustive-clean-run-world.ts")
await hash("scripts/exhaustive-admission-mocks.ts")
await hash("scripts/exhaustive-host-admission.ts")
await hash("scripts/exhaustive-runtime-admission.ts")
await hash("scripts/exhaustive-github-bridge.ts")
await hash("scripts/exhaustive-firstmate.ts")
await hash("scripts/trellage-statusline.sh")
await hash("tests/helpers/native-source-fixtures.ts")
const hashTree = async (relative: string): Promise<void> => {
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name)
    if (entry.isDirectory()) await hashTree(name)
    else if (entry.isFile()) await hash(name)
  }
}
await hashTree("packages/trellage-runtime/src/native-run")
const world = await createCleanRunWorld()
const fixture = await createAdmissionMocks(world.root, world.dependencies.environment!.TRELLAGE_CODEX_BIN!)
const hostFixture = await createHostAdmission(world.root)
const runtimeFixture = await createRuntimeAdmission(
  world.root,
  world.home,
  world.dependencies.environment!.TRELLAGE_CODEX_BIN!,
)
const githubFixture = await createGithubBridge(world.root, world.home, path.join(world.root, "bin"))
const environment: NodeJS.ProcessEnv = {
  ...runtimeFixture.environment,
  ...hostFixture.environment,
  ...fixture.environment,
  ...world.dependencies.environment,
  TRELLAGE_CONFIG: configPath,
  TRELLAGE_DEV_SOURCES: process.env.TRELLAGE_DEV_SOURCES,
}
const firstmateFixture = await createFirstmateFixture(world.root, environment)
if (harness === "jcode") delete environment.TRELLAGE_JCODE_BIN
const forwarded = ["exec", "space value", "", "*"]
const historyPath = path.join(world.paths.state, "selections.json")
const historyText = () =>
  readFile(historyPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null
    throw error
  })
let refreshes = 0
const outcomes: Record<string, number> = {}
const digest = createHash("sha256")
let executed = 0
try {
  for (let profileIndex = 0; profileIndex < profiles.length; profileIndex++) {
    const profile = profiles[profileIndex]!
    for (let mask = 0; mask < 2 ** flags.length; mask++) {
      const selected = flags.filter((_, index) => (mask & (1 << index)) !== 0)
      const id = `${profileIndex}:${mask}`
      const clean = profile.argv.includes("clean")
      const dry = selected.includes("--dry-run")
      const strict = selected.includes("--require-proven-isolation") && !selected.includes("--allow-unproven-isolation")
      const noAlways = selected.includes("--no-always")
      const resolved: string[] = [
        ...new Set(
          profile.argv.map((name): string =>
            Object.hasOwn(catalog.profiles, name)
              ? name
              : Object.hasOwn(catalog.profiles, `preset-${harness}-${name}`)
                ? `preset-${harness}-${name}`
                : name,
          ),
        ),
      ].sort()
      let expectedError: string | undefined
      if (!resumeSupported && (selected.includes("--resume") || selected.includes("--continue")))
        expectedError = "unsupported"
      else if (clean && profile.argv.length > 1) expectedError = "usage"
      else if (clean && !["codex", "pi", "claude", "copilot"].includes(harness)) expectedError = "unsupported"
      else if (!clean) {
        if (
          resolved.some(
            (name) => catalog.profiles[name]?.harnesses && !catalog.profiles[name]!.harnesses!.includes(harness),
          )
        )
          expectedError = "unsupported"
        else if (resolved.some((name) => !catalog.profiles[name])) expectedError = "unknown-profile"
        else if (!dry && strict && harness !== "pi") expectedError = "isolation"
      }
      const presetPrefix: string = `preset-${harness}-`
      const lifecycle: string =
        resolved.find((name) => name.startsWith(presetPrefix))?.slice(presetPrefix.length) ??
        resolved.find((name) => nativePresetProfiles(harness).includes(name)) ??
        (harness === "copilot" ? "hve" : "default")
      const claudeAdmission: boolean =
        !clean && harness === "claude" && ["default", "office", "office-charts"].includes(lifecycle)
      const firstmate = resolved.some((name) => catalog.profiles[name]?.workers === "firstmate")
      const syncCount = firstmateFixture.calls.length
      const launchCount = world.launches.length
      const refreshCount = refreshes
      const discoveries = (await world.discoveries()).length
      const beforeHistory = await historyText()
      const metadataCount = (await fixture.calls()).length
      const lineCount = world.lines.length
      const hostCallCount = (await hostFixture.calls()).length
      const runtimeCallCount = (await runtimeFixture.calls()).length
      const githubCallCount = (await githubFixture.calls()).length
      let launchedGeneration: string | undefined
      let result: number | undefined, error: unknown
      try {
        result = await runNative(parseRunArguments([harness, ...profile.argv, ...selected, "--", ...forwarded]), {
          ...world.dependencies,
          environment,
          syncRepository: firstmateFixture.syncRepository,
          refreshHarness: async (requested) => {
            assert.equal(requested, harness, id)
            refreshes++
          },
          spawner: async (launch, env, cwd, onSpawn) => {
            launchedGeneration = launch.env[homeVariable] ?? undefined
            if (!launchedGeneration) {
              const active = []
              for (const generation of await readdir(path.join(world.paths.state, "leases")))
                if ((await readdir(path.join(world.paths.state, "leases", generation))).length) active.push(generation)
              assert.equal(active.length, 1, id)
              const candidates = []
              for (const owner of await readdir(path.join(world.paths.data, "compositions"))) {
                const candidate = path.join(world.paths.data, "compositions", owner, "generations", active[0]!)
                const exists = await access(candidate).then(
                  () => true,
                  (error: NodeJS.ErrnoException) => {
                    if (error.code === "ENOENT") return false
                    throw error
                  },
                )
                if (exists) {
                  const manifest = JSON.parse(await readFile(path.join(candidate, "manifest.json"), "utf8"))
                  if (manifest.harness === harness && JSON.stringify(manifest.profiles) === JSON.stringify(resolved))
                    candidates.push(candidate)
                }
              }
              assert.equal(candidates.length, 1, id)
              launchedGeneration = candidates[0]!
            }
            const generation = path.basename(launchedGeneration)
            assert.equal((await readdir(path.join(world.paths.state, "leases", generation))).length, 1, id)
            return world.dependencies.spawner!(launch, env, cwd, onSpawn)
          },
        })
      } catch (caught) {
        error = caught
      }
      if (expectedError) {
        assert(error instanceof NativeRunError, `${id}: expected ${expectedError}, got ${String(error)}`)
        assert.equal(error.code, expectedError, id)
      } else {
        assert.equal(error, undefined, id)
        assert.equal(result, dry ? 0 : 23, id)
      }
      const launched = !expectedError && !dry
      assert.equal(world.launches.length - launchCount, launched ? 1 : 0, id)
      assert.equal(
        refreshes - refreshCount,
        !clean && !dry && (expectedError === undefined || expectedError === "isolation") ? 1 : 0,
        id,
      )
      if (launched) {
        const { launch, cwd } = world.launches.at(-1)!
        assert.equal(cwd, firstmate ? firstmateFixture.directory : world.work, id)
        assert.equal(
          launch.command,
          harness === "prime"
            ? process.execPath
            : harness === "omp"
              ? runtimeFixture.executable
              : harness === "jcode"
                ? fixture.executable
                : environment[`TRELLAGE_${harness.toUpperCase()}_BIN`],
          id,
        )
        assert.deepEqual(claudeAdmission ? launch.args.slice(-5, -2) : launch.args.slice(-3), forwarded.slice(-3), id)
        if (harness === "codex") {
          const resume: string[] = selected.includes("--resume")
            ? ["resume"]
            : selected.includes("--continue")
              ? ["resume", "--last"]
              : []
          const exec = launch.args.indexOf("exec")
          assert(exec >= 0, id)
          assert.deepEqual(launch.args.slice(exec), ["exec", ...resume, ...forwarded.slice(1)], id)
        } else if (harness === "agency") {
          assert.deepEqual(
            launch.args,
            [
              "copilot",
              "--profile-only",
              "trellage-azure",
              "--",
              "--model",
              "gpt-6-astra",
              "--effort",
              "low",
              ...forwarded,
            ],
            id,
          )
          assert.equal(launch.env.AZURE_TOKEN_CREDENTIALS, "AzureCliCredential", id)
        } else if (harness === "jcode") {
          assert.deepEqual(launch.args, ["--no-update", ...forwarded], id)
          assert.equal(launch.env.JCODE_PROVIDER, "trellage-copilot-proxy", id)
          assert.equal(launch.env.JCODE_MODEL, "gpt-5.6-sol", id)
        }
        if (harness === "fx") {
          assert.deepEqual(launch.args, ["--effort", selected.includes("--plan") ? "max" : "medium", ...forwarded], id)
          assert.equal(launch.env.FX_MODEL, selected.includes("--plan") ? "gpt-6-astra" : "gpt-6.1-sol", id)
          const settings = JSON.parse(await readFile(path.join(world.home, ".fx", "settings.json"), "utf8"))
          assert.equal(settings.providers["trellage-copilot-proxy"].base_url, "http://127.0.0.1:8080/v1", id)
        } else if (harness === "headlong") {
          assert.deepEqual(launch.args, forwarded, id)
          assert.equal(launch.env.HEADLONG_HOME, hostFixture.home, id)
          assert.equal(launch.env.HEADLONG_APP_DIR, hostFixture.app, id)
          assert.equal(launch.env.HEADLONG_NO_THINKERS, undefined, id)
          for (const category of ["skills", "kernel"])
            assert(!(await readdir(path.join(hostFixture.identity, category))).includes("i-have-adhd"), id)
        }
        if (harness === "omp") {
          const content = await readFile(path.join(launchedGeneration!, "always-on.md"), "utf8").catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code === "ENOENT") return undefined
              throw error
            },
          )
          const local = resolved.includes("preset-omp-local")
          assert.deepEqual(
            launch.args,
            [
              ...(content === undefined ? [] : ["--append-system-prompt", content]),
              ...(local ? [] : ["--model", "github-copilot/gpt-5.6-sol", "--thinking", "medium"]),
              ...forwarded,
            ],
            id,
          )
          assert.equal(launch.env.OMP_PROFILE, local ? "trellage-qwen-local" : "trellage-copilot-native", id)
          assert.equal(launch.env.PI_CONFIG_FILES, runtimeFixture.overlay, id)
          assert.equal(launch.env.COPILOT_GITHUB_TOKEN, local ? undefined : "fixture-copilot-token", id)
          await assert.rejects(access(runtimeFixture.credential), { code: "ENOENT" }, id)
        } else if (harness === "prime") {
          assert.deepEqual(
            launch.args,
            [
              runtimeFixture.cli,
              "--provider",
              "copilot-proxy-rs",
              "--model",
              "claude-opus-5.5",
              "--offline",
              "--autonomous",
              "--daemon-socket",
              runtimeFixture.prime.daemonSocket,
              ...forwarded,
            ],
            id,
          )
          assert.equal(launch.env.PRIME_AGENT_KERNEL_PYTHON, runtimeFixture.prime.kernelPython, id)
          const stamp = JSON.parse(await readFile(runtimeFixture.prime.daemonEnvStamp, "utf8"))
          assert.equal(stamp.kernelPython, runtimeFixture.prime.kernelPython, id)
          for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"])
            assert.equal(launch.env[key], null, id)
        }
        if (harness === "grok") {
          const resume: string[] = selected.includes("--resume")
            ? ["--resume"]
            : selected.includes("--continue")
              ? ["--continue"]
              : []
          assert.deepEqual(
            launch.args,
            [
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
              ...resume,
              ...forwarded,
            ],
            id,
          )
          assert.equal(launch.env.GH_TOKEN, "fixture-github-token", id)
          assert.equal(launch.env.XAI_API_KEY, "local-copilot-proxy", id)
          const config = Bun.TOML.parse(await readFile(path.join(launchedGeneration!, "config.toml"), "utf8")) as {
            auth: { preferred_method: string }
          }
          assert.equal(config.auth.preferred_method, "api_key", id)
          const sandbox = Bun.TOML.parse(await readFile(path.join(launchedGeneration!, "sandbox.toml"), "utf8")) as {
            profiles: Record<string, { extends: string; read_write: string[] }>
          }
          assert.deepEqual(
            sandbox.profiles["trellage-workspace"],
            {
              extends: "workspace",
              read_write: [launchedGeneration, path.join(path.dirname(path.dirname(launchedGeneration!)), "state")],
            },
            id,
          )
          const trust = Bun.TOML.parse(
            await readFile(path.join(launchedGeneration!, "trusted_folders.toml"), "utf8"),
          ) as { folders: Record<string, { trusted: boolean }> }
          assert.equal(trust.folders[await realpath(world.work)]!.trusted, true, id)
          await assert.rejects(lstat(path.join(launchedGeneration!, "auth.json")), { code: "ENOENT" }, id)
        } else if (harness === "uji") {
          const resume = selected.includes("--resume") || selected.includes("--continue")
          assert.deepEqual(launch.args, [resume ? "resume" : "new", ...forwarded], id)
          assert.equal(
            launch.env.UJI_DB,
            path.join(path.dirname(path.dirname(launchedGeneration!)), "sessions", "uji.db"),
            id,
          )
          assert.equal(launch.env.TRX_UJI_MODEL, "copilot-proxy-rs/gpt-6-astra", id)
          assert.equal(launch.env.TRX_UJI_EFFORT, null, id)
          assert.equal(launch.env.TRX_UJI_PLAN, selected.includes("--plan") ? "1" : null, id)
          assert.equal(
            await readFile(path.join(launchedGeneration!, "plugin", "trellage-tools.lua"), "utf8"),
            await readFile(path.join(root, "packages/trellage-runtime/src/native-run/uji-tools.lua"), "utf8"),
            id,
          )
        }
        const manifest = JSON.parse(await readFile(path.join(launchedGeneration!, "manifest.json"), "utf8"))
        if (harness === "claude" || harness === "copilot") {
          const resume: string[] = selected.includes("--resume")
            ? ["--resume"]
            : selected.includes("--continue")
              ? ["--continue"]
              : []
          const plan = selected.includes("--plan")
          if (harness === "copilot") {
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
              launch.args,
              [
                ...prefix,
                ...(plan ? ["--plan"] : ["--autopilot", "--allow-all", "--no-ask-user"]),
                "--model",
                "gpt-6-astra",
                "--effort",
                "low",
                ...resume,
                ...forwarded,
              ],
              id,
            )
            const settings = JSON.parse(await readFile(path.join(launchedGeneration!, "settings.json"), "utf8"))
            const config = JSON.parse(await readFile(path.join(launchedGeneration!, "config.json"), "utf8"))
            assert(config.trustedFolders.includes(cwd), id)
            if (clean) {
              assert.deepEqual(settings.disabledSkills, ["unselected-fixture"], id)
              assert.equal(settings.memory, false, id)
            } else {
              for (const [key, value] of Object.entries(fixture.payloads.copilot.settings))
                assert.deepEqual(settings[key], value, id)
              assert.deepEqual(config.installedPlugins, fixture.payloads.copilot.pluginRegistrations, id)
              assert.equal(
                await realpath(path.join(launchedGeneration!, "installed-plugins")),
                await realpath(fixture.payloads.copilot.installedPlugins),
                id,
              )
            }
          } else {
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
            const interactive = resolved.some((name) =>
              ["blog", "council", "ecc", "frontend-design", "research", "social-media"].some(
                (preset) => name === `preset-claude-${preset}`,
              ),
            )
            assert.deepEqual(
              launch.args,
              [
                ...prefix,
                ...manifest.plugins.flatMap((plugin: { name: string }) => [
                  "--plugin-dir",
                  path.join(launchedGeneration!, "plugins", plugin.name),
                ]),
                ...(plan
                  ? ["--allow-dangerously-skip-permissions", "--effort", "max"]
                  : ["--dangerously-skip-permissions", "--permission-mode", "bypassPermissions"]),
                ...(interactive ? [] : ["--disallowedTools", "AskUserQuestion"]),
                "--model",
                "opusplan",
                ...(plan ? ["--permission-mode", "plan"] : ["--effort", "medium"]),
                ...resume,
                ...forwarded,
                ...(claudeAdmission ? ["--plugin-dir", fixture.plugin] : []),
              ],
              id,
            )
            assert.equal(launch.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:8080", id)
            assert.equal(launch.env.ANTHROPIC_AUTH_TOKEN, "trellage-local-proxy", id)
            assert.equal(launch.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, "claude-haiku-4.5", id)
            assert.equal(launch.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT, "1", id)
            if (clean) assert.equal(launch.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1", id)
            const config = JSON.parse(await readFile(path.join(launchedGeneration!, ".claude.json"), "utf8"))
            assert.equal(config.projects[cwd].hasTrustDialogAccepted, true, id)
            assert.equal(config.projects[cwd].hasCompletedProjectOnboarding, true, id)
            if (firstmate) {
              assert((await lstat(path.join(launchedGeneration!, ".trellage-workers"))).isFile(), id)
              const settings = JSON.parse(await readFile(path.join(launchedGeneration!, "settings.json"), "utf8"))
              assert.equal(settings.env.ANTHROPIC_BASE_URL, launch.env.ANTHROPIC_BASE_URL, id)
              assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, launch.env.ANTHROPIC_AUTH_TOKEN, id)
              for (const name of ["pi-account", "crew-dispatch.json"])
                await assert.rejects(
                  lstat(path.join(firstmateFixture.directory, "config", name)),
                  { code: "ENOENT" },
                  id,
                )
            }
          }
        }
        if (harness === "pi") {
          const resume: string[] = selected.includes("--resume")
            ? ["--resume"]
            : selected.includes("--continue")
              ? ["--continue"]
              : []
          const loading: string[] = clean
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
                ...manifest.skills.flatMap((skill: { name: string }) => [
                  "--skill",
                  path.join(launchedGeneration!, "skills", skill.name),
                ]),
              ]
          assert.deepEqual(
            launch.args,
            [
              ...loading,
              "--session-dir",
              path.join(path.dirname(path.dirname(launchedGeneration!)), "sessions"),
              "--provider",
              "copilot-proxy-rs",
              "--model",
              "gpt-6-astra",
              "--thinking",
              "medium",
              ...resume,
              ...forwarded,
            ],
            id,
          )
          assert.equal(launch.env.PI_SKIP_VERSION_CHECK, "1", id)
          assert.equal(launch.env.PI_TELEMETRY, "0", id)
          for (const key of ["NODE_OPTIONS", "NODE_PATH", "NODE_COMPILE_CACHE"]) assert.equal(launch.env[key], null, id)
          if (firstmate) {
            assert((await lstat(path.join(launchedGeneration!, ".trellage-workers"))).isFile(), id)
            assert.equal(
              await readFile(path.join(firstmateFixture.directory, "config/pi-account"), "utf8"),
              `${launchedGeneration}\ncopilot-proxy-rs\n`,
              id,
            )
            assert.deepEqual(
              JSON.parse(await readFile(path.join(firstmateFixture.directory, "config/crew-dispatch.json"), "utf8")),
              {
                rules: [],
                default: {
                  harness: "pi",
                  model: "copilot-proxy-rs/gpt-6-astra",
                  effort: "medium",
                  why: "Written by trx run pi firstmate",
                },
              },
              id,
            )
          }
        }
        assert.equal(manifest.harness, harness, id)
        assert.deepEqual(manifest.profiles, clean ? ["clean"] : resolved, id)
        const always: string[] =
          clean || noAlways
            ? []
            : Object.entries(catalog.profiles)
                .filter(([, value]) => value.always && (!value.harnesses || value.harnesses.includes(harness)))
                .map(([name]) => name)
                .sort()
        assert.deepEqual(manifest.alwaysProfiles, always, id)
        assert.deepEqual(JSON.parse((await historyText())!).global, { harness, profiles: profile.argv }, id)
        assert.deepEqual(
          await readdir(path.join(world.paths.state, "leases", path.basename(launchedGeneration!))),
          [],
          id,
        )
      } else assert.equal(await historyText(), beforeHistory, id)
      assert.equal(
        world.lines.slice(lineCount).some((line) => line.startsWith("Resume     ")),
        launched && resumeSupported,
        id,
      )
      const metadataCalls: { role: string; args: string[] }[] = !launched
        ? []
        : harness === "agency"
          ? [{ role: harness, args: ["inventory", "trellage-azure", "--json"] }]
          : harness === "jcode"
            ? [{ role: harness, args: ["_trx-executable"] }]
            : claudeAdmission || (harness === "copilot" && !clean)
              ? [{ role: harness, args: ["_trx-admit", lifecycle] }]
              : []
      assert.deepEqual((await fixture.calls()).slice(metadataCount), metadataCalls, id)
      assert.deepEqual(
        (await hostFixture.calls()).slice(hostCallCount),
        launched && harness === "headlong" ? [{ operation: "initialize", args: [] }] : [],
        id,
      )
      const runtimeCalls: { role: string; args: string[] }[] = !launched
        ? []
        : harness === "omp"
          ? [{ role: "omp", args: ["_trx-admit", resolved.includes("preset-omp-local") ? "local" : "default"] }]
          : harness === "prime"
            ? [
                { role: "prime", args: [runtimeCallCount === 0 ? "setup" : "repair", "default"] },
                { role: "prime-version", args: ["--version"] },
              ]
            : []
      assert.deepEqual((await runtimeFixture.calls()).slice(runtimeCallCount), runtimeCalls, id)
      assert.deepEqual(
        (await githubFixture.calls()).slice(githubCallCount),
        launched && harness === "grok" ? [{ args: githubFixture.args }] : [],
        id,
      )
      assert.equal(
        (await world.discoveries()).length - discoveries,
        clean && launched ? (harness === "codex" ? 4 : harness === "copilot" ? 2 : 0) : 0,
        id,
      )
      assert.equal(
        firstmateFixture.calls.length - syncCount,
        firstmate && !dry && (expectedError === undefined || expectedError === "isolation") ? 1 : 0,
        id,
      )
      assert.deepEqual(world.unexpected, [], id)
      const outcome = expectedError ?? (dry ? "dry-run" : "launched")
      outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
      digest.update(`${id}\n`)
      executed++
    }
    console.error(JSON.stringify({ profile: profile.id, executed, total: profiles.length * 2 ** flags.length }))
  }
} finally {
  await world.close()
}
await assertCliSourcesUnchanged(cliSourceHashes)
for (const [name, expected] of Object.entries(sourceHashes)) {
  const current = createHash("sha256")
    .update(await readFile(path.join(root, name)))
    .digest("hex")
  assert.equal(current, expected, `source changed during execution: ${name}`)
}
assert.equal(executed, profiles.length * 2 ** flags.length)
console.log(
  JSON.stringify(
    {
      scope: `${harness}-run-profile-boolean-product`,
      harness,
      profiles,
      flags,
      expectedCases: profiles.length * 2 ** flags.length,
      executedCases: executed,
      distinctTupleIds: executed,
      idSequenceSha256: digest.digest("hex"),
      outcomes,
      sourceHashes,
      mockedBoundaries: [
        "source snapshots from explicit local repositories; unmapped transport throws",
        "Grok GitHub-token lookup resolves only a strict fixture executable; no host credential store is read",
        "Firstmate synchronization validates the exact owned path and repository; missing prerequisite stubs reject execution",
        "refresh callback records the call without updating",
        "lifecycle executables accept only declared metadata requests; model calls fail closed",
        "Headlong initialization creates a fixture identity only with exact paths and disabled background processes",
        "OMP guarded metadata emits a disposable fixture credential; Prime setup/repair seeds an owned runtime with a version-only CLI and inert kernel",
        "final spawner records launch, checks active lease, calls onSpawn without a fake PID, and returns 23",
        "clean discovery executable only supports initialize/initialized/skills/list; model calls fail closed",
      ],
      limitations: [
        "One explicitly selected harness; remaining adapters require separate coverage",
        "All declared profile inputs and boolean flags, but model/effort/inline-resume/ad-hoc skills/syntax domains remain separate",
        "Fixed forwarded exec suffix; no real model process executes",
      ],
    },
    null,
    2,
  ),
)
