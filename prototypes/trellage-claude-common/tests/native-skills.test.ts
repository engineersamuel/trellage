import assert from "node:assert/strict"
import { spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding, type SpawnSyncReturns } from "node:child_process"
import { once } from "node:events"
import {
  chmod,
  copyFile,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test as nodeTest, type TestContext } from "node:test"
import { fileURLToPath } from "node:url"
import { bunExecutable } from "@trellage/runtime"
import { writeReadiness } from "@trellage/runtime/workspace"
import { compareBakedSkills, syncSnapshot, verifyTarget } from "../../../scripts/floating-skills.ts"

const repository = fileURLToPath(new URL("../../../", import.meta.url))
const common = path.join(repository, "prototypes/trellage-claude-common")
const manager = path.join(repository, "scripts/floating-skills.ts")

// Each contract runs several bounded CLI processes, sometimes for every profile.
const test = (name: string, run: (context: TestContext) => Promise<void>) => nodeTest(name, { timeout: 60_000 }, run)

interface LauncherDescriptor {
  alias: string
  package: string
  marker?: string
  owner?: string
  leaf?: string
}

interface Fixture {
  descriptor: LauncherDescriptor
  root: string
  home: string
  workspace: string
  runtime: string
  source: string
  bin: string
  cache: string
  youtubeCache: string
  communityCache: string
  forbiddenLog: string
  envLog: string
  env: NodeJS.ProcessEnv
  catalog: {
    profiles: Record<string, Record<string, unknown>>
    source: unknown
  }
}

interface SkillTarget {
  cache: string
  target: string
}

interface ProfileFixture {
  name: string
  root: string
  home: string
  targets: [SkillTarget, ...SkillTarget[]]
  guards: string[]
}

const launchers: LauncherDescriptor[] = [
  { alias: "agx", package: "agency", marker: "agency", owner: "trellage-agency-profile-v1" },
  { alias: "cpx", package: "copilot" },
  { alias: "cdx", package: "codex" },
  { alias: "cldx", package: "claude", marker: "claude", owner: "trellage-claude-profile-v1" },
  { alias: "grx", package: "grok" },
  { alias: "jcx", package: "jcode", marker: "jcode", owner: "trellage-jcode-profile-v1" },
  { alias: "omp", package: "omp", marker: "omp", owner: "trellage-omp-profile-v1", leaf: "agent" },
  { alias: "picx", package: "picx", marker: "picx", owner: "trellage-picx-profile-v2", leaf: "agent" },
  { alias: "prx", package: "prime", marker: "prime", owner: "trellage-prime-profile-v1" },
  { alias: "fmx", package: "firstmate", marker: "firstmate", owner: "trellage-firstmate-profiles-v1" },
]

const write = async (file: string, content: string, mode = 0o600) => {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, content, { mode })
}

const copy = async (source: string, target: string) => {
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
  await copyFile(source, target)
}

const commandPath = (name: string) => {
  const result = spawnSync("/bin/bash", ["-c", 'command -v "$1"', "skills-test", name], { encoding: "utf8" })
  assert.equal(result.status, 0, `${name} is required for Native contracts`)
  return result.stdout.trim()
}

const installFakes = async (fixture: Fixture) => {
  const forbidden = `#!/bin/sh\nprintf '%s\\n' "$0 $*" >>"$SKILLS_FORBIDDEN_LOG"\nexit 97\n`
  for (const name of [
    "agency",
    "copilot",
    "codex",
    "claude",
    "grok",
    "jcode",
    "omp",
    "pi",
    "prime",
    "prime-agent",
    "copilot-proxy-rs",
    "curl",
    "git",
    "gh",
    "npm",
    "npx",
    "node",
    "mise",
    "uv",
    "varlock",
  ]) {
    await write(path.join(fixture.bin, name), forbidden, 0o755)
  }
  await symlink(commandPath("jq"), path.join(fixture.bin, "jq"))
  await symlink(commandPath("python3"), path.join(fixture.bin, "python3"))
  await write(
    path.join(fixture.bin, "bun"),
    `#!/bin/sh
for argument in "$@"; do
  case "$argument" in
    install|add|update|build|run)
      printf '%s\\n' "$0 $*" >>"$SKILLS_FORBIDDEN_LOG"
      exit 97
      ;;
    *.ts|*.tsx) break ;;
  esac
done
printf '%s|%s|%s|%s|%s|%s\\n' "\${GH_CONFIG_DIR-unset}" "\${GH_TOKEN-unset}" "\${ANTHROPIC_API_KEY-unset}" "\${OPENAI_API_KEY-unset}" "\${TRANSCRIPT_API_KEY-unset}" "\${CODEX_API_KEY-unset}" >>"$SKILLS_ENV_LOG"
exec '${process.execPath.replaceAll("'", "'\\''")}' "$@"
`,
    0o755,
  )
}

const fixtureFor = async (context: TestContext, descriptor: LauncherDescriptor | undefined) => {
  assert.ok(descriptor, "requested launcher must be in the fixture matrix")
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "native-skills-contract-")))
  context.after(() => rm(root, { recursive: true, force: true }))
  const home = path.join(root, "home")
  await mkdir(home, { mode: 0o700 })
  const workspace = path.join(root, "source")
  const runtime = path.join(workspace, `prototypes/trellage-${descriptor.package}-profiles`)
  const source = path.join(repository, `prototypes/trellage-${descriptor.package}-profiles`)
  const rawCatalog: unknown = JSON.parse(await readFile(path.join(source, "catalog.json"), "utf8"))
  assert.ok(typeof rawCatalog === "object" && rawCatalog !== null && "profiles" in rawCatalog)
  const rawProfiles = rawCatalog.profiles
  assert.ok(typeof rawProfiles === "object" && rawProfiles !== null && !Array.isArray(rawProfiles))
  const profiles: Record<string, Record<string, unknown>> = {}
  for (const [name, profile] of Object.entries(rawProfiles)) {
    assert.ok(typeof profile === "object" && profile !== null && !Array.isArray(profile))
    profiles[name] = Object.fromEntries(Object.entries(profile))
  }
  const fixture: Fixture = {
    descriptor,
    root,
    home,
    workspace,
    runtime,
    source,
    bin: path.join(root, "bin"),
    cache: path.join(home, ".local/share/trellage/common", descriptor.alias === "cdx" ? "cdx-skills" : "skills"),
    youtubeCache: path.join(home, ".local/share/trellage/common/cdx-youtube-pro-skills"),
    communityCache: path.join(home, ".local/share/trellage/common/omp-community-skills"),
    forbiddenLog: path.join(root, "forbidden.log"),
    envLog: path.join(root, "bun-environment.log"),
    env: {},
    catalog: { profiles, source: "source" in rawCatalog ? rawCatalog.source : undefined },
  }
  await copy(path.join(source, "bin", descriptor.alias), path.join(runtime, "bin", descriptor.alias))
  await copy(path.join(source, "catalog.json"), path.join(runtime, "catalog.json"))
  await copy(path.join(common, "native-skills.ts"), path.join(runtime, "native-skills.ts"))
  await copy(path.join(common, "manual-skills.ts"), path.join(runtime, "manual-skills.ts"))
  await copy(manager, path.join(workspace, "scripts/floating-skills.ts"))
  await copy(path.join(repository, "skills.json"), path.join(workspace, "skills.json"))
  await installSharedRuntime(fixture)
  await write(fixture.forbiddenLog, "")
  await write(fixture.envLog, "")
  await installFakes(fixture)
  await mkdir(path.join(root, "work"), { mode: 0o700 })
  fixture.env = {
    HOME: home,
    PATH: `${fixture.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: path.join(root, "work"),
    SKILLS_FORBIDDEN_LOG: fixture.forbiddenLog,
    SKILLS_ENV_LOG: fixture.envLog,
    GH_CONFIG_DIR: path.join(home, ".config/gh"),
  }
  await installSourceFixture(fixture)
  return fixture
}

const installSourceFixture = async (fixture: Fixture) => {
  const { workspace } = fixture
  for (const directory of ["bin", "packages", "prototypes", "scripts", "profile-guides", "profiles"]) {
    await mkdir(path.join(workspace, directory), { recursive: true, mode: 0o700 })
  }
  for (const file of [
    "scripts/run-source.sh",
    "scripts/bun-runtime.sh",
    "packages/trellage-runtime/bunfig.toml",
    "packages/trellage-runtime/src/index.ts",
    "packages/trellage-runtime/src/workspace.ts",
    "packages/trellage-runtime/src/workspace-cli.ts",
    "packages/trellage-runtime/src/lock-transport.ts",
  ])
    await copy(path.join(repository, file), path.join(workspace, file))
  await write(
    path.join(workspace, "package.json"),
    JSON.stringify({
      name: "native-skills-fixture",
      private: true,
      type: "module",
      workspaces: ["packages/*"],
      dependencies: { "@trellage/runtime": "workspace:*" },
    }),
  )
  await write(
    path.join(workspace, "packages/trellage-runtime/package.json"),
    JSON.stringify({
      name: "@trellage/runtime",
      version: "0.1.0",
      type: "module",
      exports: { ".": "./src/index.ts" },
    }),
  )
  await write(path.join(workspace, "bunfig.toml"), '[install]\nauto = "disable"\nlinker = "isolated"\n')
  await write(path.join(workspace, "tsconfig.base.json"), '{"compilerOptions":{"noEmit":true,"strict":true}}')
  succeeds(
    spawnSync(
      bunExecutable(),
      [
        "--no-env-file",
        `--config=${path.join(workspace, "bunfig.toml")}`,
        "install",
        "--ignore-scripts",
        "--no-progress",
      ],
      { cwd: workspace, env: fixture.env, encoding: "utf8" },
    ),
  )
  writeReadiness(workspace)
}

const installSharedRuntime = async ({ descriptor, runtime }: Fixture) => {
  if (descriptor.alias === "cdx") {
    await copy(
      path.join(repository, "prototypes/trellage-codex-common/native-codex"),
      path.join(runtime, "lib/native-codex"),
    )
  }
  if (["cldx", "fmx"].includes(descriptor.alias)) {
    await copy(path.join(common, "native-claude"), path.join(runtime, "lib/native-claude"))
  }
}

const run = (fixture: Fixture, args: readonly string[], environment: NodeJS.ProcessEnv = {}) => {
  writeReadiness(fixture.workspace)
  return spawnSync(path.join(fixture.runtime, "bin", fixture.descriptor.alias), args, {
    cwd: fixture.root,
    env: { ...fixture.env, ...environment },
    encoding: "utf8",
    timeout: 20_000,
  })
}

const succeeds = (result: SpawnSyncReturns<string>) => {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`)
}

const fails = (result: SpawnSyncReturns<string>, message: RegExp) => {
  assert.notEqual(result.status, 0, result.stdout)
  assert.equal(result.signal, null, "command must fail promptly, not start a session")
  assert.match(result.stderr, message)
}

const seedSnapshot = async (cache: string, names: string[], version: number) => {
  await rm(cache, { recursive: true, force: true })
  for (const name of names) await write(path.join(cache, "skills", name, "SKILL.md"), `# ${name} ${version}\n`)
  await write(path.join(cache, "managed-skills.txt"), `${names.sort((a, b) => a.localeCompare(b, "en")).join("\n")}\n`)
  await write(path.join(cache, "always-on.md"), "")
}

const seedCaches = async (fixture: Fixture, version: number) => {
  const names = version === 1 ? ["kept", "retired"] : ["added", "kept"]
  await seedSnapshot(fixture.cache, [...names], version)
  await seedSnapshot(fixture.youtubeCache, [...names, "youtube-full"], version)
  await seedSnapshot(fixture.communityCache, names.map((name) => `omp-${name}`).concat("pstack-omp"), version)
}

const firstProfileName = (fixture: Fixture) => {
  const [name] = Object.keys(fixture.catalog.profiles)
  assert.ok(name !== undefined, "fixture catalog must contain a profile")
  return name
}

const profileRoot = (fixture: Fixture, name: string) => {
  const profile = fixture.catalog.profiles[name]
  assert.ok(profile, "requested profile must be in the fixture catalog")
  if (fixture.descriptor.alias === "omp") {
    assert.ok(typeof profile.ompProfile === "string")
    return path.join(fixture.home, ".omp/profiles", profile.ompProfile)
  }
  if (fixture.descriptor.alias === "picx") {
    assert.ok(typeof profile.piProfile === "string")
    return path.join(fixture.home, ".local/share/trellage/profiles/pi", profile.piProfile)
  }
  return path.join(fixture.home, ".local/share/trellage/profiles", fixture.descriptor.package, name)
}

const markOwned = async (fixture: Fixture, root: string) => {
  if (fixture.descriptor.marker !== undefined) {
    await write(
      path.join(root, `.managed-by-trellage-${fixture.descriptor.marker}-profiles`),
      `${fixture.descriptor.owner}\n`,
    )
  }
}

const seedSkillTarget = async (cache: string, home: string) => {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const target = path.join(home, "skills")
  await syncSnapshot(cache, target)
  await write(path.join(target, "custom/SKILL.md"), "# User skill\n")
  await write(path.join(target, "user-notes.md"), "Unmanaged notes\n")
  return { cache, target }
}

const seedFirstmate = async (fixture: Fixture, profile: ProfileFixture, name: string) => {
  const root = profile.root
  await mkdir(path.join(root, "runtime"), { recursive: true, mode: 0o700 })
  await mkdir(path.join(root, "home/state"), { recursive: true, mode: 0o700 })
  const sourceReceipt = JSON.stringify(fixture.catalog.source)
  assert.ok(sourceReceipt, "Firstmate fixture must have a source receipt")
  await write(path.join(root, "receipts/source.json"), sourceReceipt)
  await markOwned(fixture, root)
  await markOwned(fixture, path.join(root, "captain"))
  const worker = path.join(root, "workers", `${name}-task`)
  await markOwned(fixture, worker)
  await write(
    path.join(worker, "worker.json"),
    JSON.stringify({ schemaVersion: 1, profile: name, task: `${name}-task` }),
  )
  profile.targets.push(await seedSkillTarget(fixture.cache, path.join(worker, "claude")))
  profile.guards.push(path.join(root, "receipts/source.json"), path.join(worker, "worker.json"))
}

const seedProfile = async (fixture: Fixture, name: string) => {
  const root = profileRoot(fixture, name)
  const home = path.join(
    root,
    fixture.descriptor.alias === "fmx" ? "captain/claude" : (fixture.descriptor.leaf ?? "home"),
  )
  const cache = name === "youtube" ? fixture.youtubeCache : fixture.cache
  const profile: ProfileFixture = { name, root, home, targets: [await seedSkillTarget(cache, home)], guards: [] }
  await markOwned(fixture, root)
  if (fixture.descriptor.alias === "jcx") {
    await syncSnapshot(cache, path.join(root, "skill-library"))
  }
  if (fixture.descriptor.alias === "omp") {
    const target = path.join(home, "community-skills")
    await syncSnapshot(fixture.communityCache, target)
    await write(path.join(target, "custom/SKILL.md"), "# User community skill\n")
    profile.targets.push({ cache: fixture.communityCache, target })
  }
  if (fixture.descriptor.alias === "fmx") await seedFirstmate(fixture, profile, name)
  for (const file of ["auth.json", "config.toml", "installed-plugins/user/source-pin", "extensions/custom.js"]) {
    const target = path.join(home, file)
    await write(target, `User-owned ${file}\n`, 0o640)
    profile.guards.push(target)
  }
  profile.guards.push(path.join(fixture.runtime, "catalog.json"))
  return profile
}

const treeState = async (directory: string, includeIdentity = false) => {
  const state: (string | number | null)[][] = []
  const visit = async (candidate: string): Promise<void> => {
    const status = await lstat(candidate)
    assert.equal(status.isSymbolicLink(), false, candidate)
    const entry = [
      path.relative(directory, candidate),
      status.mode & 0o7777,
      status.isFile() ? await readFile(candidate, "utf8") : null,
    ]
    if (includeIdentity) entry.push(status.ino, status.mtimeMs)
    state.push(entry)
    if (status.isDirectory())
      for (const name of (await readdir(candidate)).sort()) await visit(path.join(candidate, name))
  }
  await visit(directory)
  return state
}

const guardState = async (files: readonly string[]) =>
  Promise.all(
    files.map(async (file) => {
      const status = await lstat(file)
      return [file, status.mode, status.ino, status.mtimeMs, await readFile(file, "utf8")]
    }),
  )

const noExternalCalls = async (fixture: Fixture) => assert.equal(await readFile(fixture.forbiddenLog, "utf8"), "")

const otherProfileState = async (profiles: readonly ProfileFixture[], selected: ProfileFixture) => {
  const targets = profiles.filter((profile) => profile !== selected).flatMap((profile) => profile.targets)
  return Promise.all(targets.map(({ target }) => treeState(target, true)))
}

test("baked Container skills use immutable contents and distinguish ambiguous older ownership", async (context) => {
  const fixture = await fixtureFor(
    context,
    launchers.find(({ alias }) => alias === "cpx"),
  )
  await seedSnapshot(fixture.cache, ["kept", "retired"], 1)
  const baked = path.join(fixture.root, "baked")
  await cp(path.join(fixture.cache, "skills"), baked, { recursive: true })
  assert.deepEqual(await compareBakedSkills(fixture.cache, baked), {
    kind: "unknown",
    diagnostic: "Older image lacks floating ownership and instruction evidence.",
  })
  await write(path.join(baked, "kept/SKILL.md"), "# older baked content\n")
  assert.deepEqual(await compareBakedSkills(fixture.cache, baked), { kind: "available" })
  await write(path.join(baked, "kept/SKILL.md"), "# kept 1\n")
  const empty = path.join(fixture.root, "empty")
  await mkdir(empty)
  await assert.rejects(compareBakedSkills(fixture.cache, empty), /no identifiable managed/)
  await write(path.join(baked, "static-plugin/SKILL.md"), "# static plugin\n")
  assert.equal((await compareBakedSkills(fixture.cache, baked)).kind, "unknown")
  await write(path.join(baked, ".trellage-floating-skills"), "kept\nretired\n")
  await write(path.join(baked, ".trellage-floating-always-on.md"), "")
  assert.deepEqual(await compareBakedSkills(fixture.cache, baked), { kind: "current" })
  await write(path.join(fixture.cache, "always-on.md"), "# changed activation policy\n")
  assert.deepEqual(await compareBakedSkills(fixture.cache, baked), { kind: "available" })
  await seedSnapshot(fixture.cache, ["added", "kept"], 2)
  const before = await treeState(baked, true)
  assert.deepEqual(await compareBakedSkills(fixture.cache, baked), { kind: "available" })
  assert.deepEqual(await treeState(baked, true), before)
})

test("matching skill files cannot prove baked instruction currency without evidence", async (context) => {
  const fixture = await fixtureFor(
    context,
    launchers.find(({ alias }) => alias === "cpx"),
  )
  await seedSnapshot(fixture.cache, ["kept"], 1)
  await write(path.join(fixture.cache, "always-on.md"), "# new activation policy\n")
  const baked = path.join(fixture.root, "baked-instructions")
  await cp(path.join(fixture.cache, "skills"), baked, { recursive: true })
  assert.equal((await compareBakedSkills(fixture.cache, baked)).kind, "unknown")
  await write(path.join(baked, ".trellage-floating-skills"), "kept\n")
  await assert.rejects(compareBakedSkills(fixture.cache, baked), /instruction evidence is missing/)
  await write(path.join(baked, ".trellage-floating-always-on.md"), "# old activation policy\n")
  assert.deepEqual(await compareBakedSkills(fixture.cache, baked), { kind: "available" })
  await write(path.join(baked, ".trellage-floating-always-on.md"), "# new activation policy\n")
  assert.deepEqual(await compareBakedSkills(fixture.cache, baked), { kind: "current" })
})

test("Sandbox skills-check and help bypass dependency bootstrap and environment setup", async (context) => {
  const fixture = await fixtureFor(
    context,
    launchers.find(({ alias }) => alias === "cpx"),
  )
  const launcher = path.join(fixture.workspace, "prototypes/trellage/trellage")
  await copy(path.join(repository, "prototypes/trellage/trellage"), launcher)
  await write(
    path.join(fixture.workspace, "scripts/bootstrap-development-dependencies.sh"),
    "#!/bin/sh\nexit 97\n",
    0o755,
  )
  await write(
    path.join(fixture.workspace, "packages/trellage-cli/src/cli.ts"),
    'if (process.argv[2] !== "skills-check") process.exit(98); console.log(JSON.stringify({kind:"current"}))\n',
  )
  writeReadiness(fixture.workspace)
  const options: SpawnSyncOptionsWithStringEncoding = {
    cwd: fixture.root,
    env: fixture.env,
    encoding: "utf8",
    timeout: 10000,
  }
  const help = spawnSync(launcher, ["--help"], options)
  succeeds(help)
  assert.match(help.stdout, /skills-check PROFILE/)
  const result = spawnSync(launcher, ["skills-check", "example"], options)
  succeeds(result)
  assert.deepEqual(JSON.parse(result.stdout), { kind: "current" })
  await noExternalCalls(fixture)
})

test("read-only source staging uses an existing CLI and never installs a missing one", async (context) => {
  const fixture = await fixtureFor(
    context,
    launchers.find(({ alias }) => alias === "cpx"),
  )
  await seedCaches(fixture, 1)
  const profile = await seedProfile(fixture, firstProfileName(fixture))
  const runtime = fixture.workspace
  await write(
    path.join(runtime, "skills.json"),
    JSON.stringify({
      schema: 1,
      sources: { fixture: { repository: "https://github.com/fixture/skills.git", select: ["kept", "retired"] } },
      bundles: { "native-common": ["fixture"] },
    }),
  )
  await write(path.join(fixture.bin, "git"), "#!/bin/sh\nexit 0\n", 0o755)
  const before = await treeState(profile.root, true)
  const missing = run(fixture, ["skills-check", profile.name])
  fails(missing, /read-only skills check requires the installed skills CLI/)
  const cli = path.join(runtime, "node_modules/skills/bin/cli.mjs")
  await write(
    path.join(runtime, "node_modules/skills/package.json"),
    JSON.stringify({
      name: "skills",
      type: "module",
      exports: { "./bin/cli.mjs": "./bin/cli.mjs" },
    }),
  )
  await write(
    cli,
    `
import { mkdirSync, writeFileSync } from "node:fs"
if (process.env.HOME !== process.cwd() || process.env.TMPDIR !== process.cwd()) throw new Error("generator is not isolated")
if (!process.env.XDG_STATE_HOME.startsWith(process.cwd() + "/")) throw new Error("global state is not isolated")
for (const name of ["kept", "retired"]) {
  const target = ".agents/skills/" + name
  mkdirSync(target, { recursive: true })
  writeFileSync(target + "/SKILL.md", "# " + name + " 1\\n")
}
console.log("generator progress must not enter the JSON report")
`,
  )
  const current = run(fixture, ["skills-check", profile.name])
  succeeds(current)
  assert.deepEqual(JSON.parse(current.stdout), { kind: "current" })
  assert.deepEqual(await treeState(profile.root, true), before)
  await write(path.join(profile.targets[0].target, "kept/SKILL.md"), "# stale deployed skill\n")
  const deployedBefore = await treeState(profile.root, true)
  const available = run(fixture, ["skills-check", profile.name])
  succeeds(available)
  assert.deepEqual(JSON.parse(available.stdout), { kind: "available" })
  assert.deepEqual(await treeState(profile.root, true), deployedBefore)
  await rename(fixture.cache, `${fixture.cache}.saved`)
  fails(run(fixture, ["skills-check", profile.name]), /skill cache is missing/)
  assert.deepEqual(await treeState(profile.root, true), deployedBefore)
  assert.deepEqual(
    (await readdir(fixture.root)).filter((name) => name.startsWith(".trellage-skills-check.")),
    [],
  )
  await noExternalCalls(fixture)
})

test("router checks all shared caches, including guide-only changes, without profile copies", async (context) => {
  const fixture = await fixtureFor(
    context,
    launchers.find(({ alias }) => alias === "cpx"),
  )
  const runtime = fixture.workspace
  const routerRoot = path.join(fixture.workspace, "prototypes/trellage-router")
  const router = path.join(routerRoot, "bin/trx")
  await copy(path.join(repository, "prototypes/trellage-router/bin/trx"), router)
  const guideCache = path.join(fixture.home, ".local/share/trellage/common/guide-prompt-master-skills")
  const codexCache = path.join(fixture.home, ".local/share/trellage/common/cdx-skills")
  const caches = [fixture.cache, codexCache, fixture.youtubeCache, fixture.communityCache, guideCache]
  for (const cache of caches) await seedSnapshot(cache, ["fixture"], 1)
  await write(
    path.join(runtime, "skills.json"),
    JSON.stringify({
      schema: 1,
      sources: { fixture: { repository: "https://github.com/fixture/skills.git", select: ["fixture"] } },
      bundles: {
        "native-common": ["fixture"],
        "codex-common": ["fixture"],
        youtube: ["fixture"],
        "omp-community": ["fixture"],
        "guide-prompt-master": ["fixture"],
      },
    }),
  )
  await write(path.join(fixture.bin, "git"), "#!/bin/sh\nexit 0\n", 0o755)
  await write(
    path.join(runtime, "node_modules/skills/package.json"),
    JSON.stringify({
      name: "skills",
      type: "module",
      exports: { "./bin/cli.mjs": "./bin/cli.mjs" },
    }),
  )
  await write(
    path.join(runtime, "node_modules/skills/bin/cli.mjs"),
    `
import { mkdirSync, writeFileSync } from "node:fs"
mkdirSync(".agents/skills/fixture", { recursive: true })
writeFileSync(".agents/skills/fixture/SKILL.md", "# fixture 1\\n")
`,
  )
  const check = () => {
    writeReadiness(fixture.workspace)
    return spawnSync(router, ["skills", "check", "--json"], {
      cwd: fixture.root,
      env: { ...fixture.env, TRELLAGE_TRX_SOURCE_ROOT: routerRoot },
      encoding: "utf8",
      timeout: 20000,
    })
  }
  const before = await treeState(fixture.home, true)
  const current = check()
  succeeds(current)
  assert.deepEqual(JSON.parse(current.stdout), { kind: "current" })
  assert.deepEqual(await treeState(fixture.home, true), before)
  await seedSnapshot(guideCache, ["fixture"], 0)
  const guideBefore = await treeState(fixture.home, true)
  const available = check()
  succeeds(available)
  assert.deepEqual(JSON.parse(available.stdout), { kind: "available" })
  assert.deepEqual(await treeState(fixture.home, true), guideBefore)
  await rm(guideCache, { recursive: true })
  const missing = check()
  succeeds(missing)
  assert.equal(JSON.parse(missing.stdout).kind, "unknown")
  assert.match(JSON.parse(missing.stdout).diagnostic, /guide-prompt-master.*ENOENT/)
  await seedSnapshot(fixture.cache, ["fixture"], 0)
  const partial = check()
  succeeds(partial)
  assert.equal(JSON.parse(partial.stdout).kind, "available")
  assert.match(JSON.parse(partial.stdout).diagnostic, /guide-prompt-master.*ENOENT/)
  await write(path.join(fixture.bin, "git"), "#!/bin/sh\nexit 9\n", 0o755)
  const failed = check()
  succeeds(failed)
  assert.equal(JSON.parse(failed.stdout).kind, "unknown")
  assert.match(JSON.parse(failed.stdout).diagnostic, /command failed: git/)
  assert.deepEqual(
    (await readdir(fixture.root)).filter((name) => name.startsWith(".trellage-shared-skills-check.")),
    [],
  )
  await noExternalCalls(fixture)
})

test("older skill managers fail closed before fetching or installing", async (context) => {
  const fixture = await fixtureFor(
    context,
    launchers.find(({ alias }) => alias === "cpx"),
  )
  await seedCaches(fixture, 1)
  const profile = await seedProfile(fixture, firstProfileName(fixture))
  await write(path.join(fixture.workspace, "scripts/floating-skills.ts"), "")
  fails(run(fixture, ["skills-check", profile.name]), /refresh the floating-skills runtime/)
  assert.deepEqual(
    (await readdir(fixture.root)).filter((name) => name.startsWith(".trellage-skills-check.")),
    [],
  )
  await noExternalCalls(fixture)
})

for (const descriptor of launchers) {
  if (["cpx", "cdx", "cldx", "fmx", "jcx"].includes(descriptor.alias)) {
    test(`${descriptor.alias} cleans skill check staging when cancelled`, async (context) => {
      const fixture = await fixtureFor(context, descriptor)
      await seedCaches(fixture, 1)
      const profile = await seedProfile(fixture, firstProfileName(fixture))
      await write(
        path.join(fixture.workspace, "scripts/floating-skills.ts"),
        `
export * from ${JSON.stringify(new URL("../../../scripts/floating-skills.ts", import.meta.url).href)}
export const stageLatest = async ({ signal }) => {
  process.stdout.write("fetch-started\\n")
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 30000)
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}
`,
      )
      writeReadiness(fixture.workspace)
      const child = spawn(path.join(fixture.runtime, "bin", descriptor.alias), ["skills-check", profile.name], {
        cwd: fixture.root,
        env: fixture.env,
        stdio: ["ignore", "pipe", "pipe"],
      })
      const closed = once(child, "close")
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
      try {
        await Promise.race([
          once(child.stdout, "data"),
          closed.then(() => {
            throw new Error("skill check exited before fetching")
          }),
        ])
        child.kill("SIGTERM")
        const [code, signal] = await closed
        assert.equal(signal, null)
        assert.notEqual(code, 0)
        assert.deepEqual(
          (await readdir(fixture.root)).filter((name) => name.startsWith(".trellage-skills-check.")),
          [],
        )
      } finally {
        clearTimeout(timer)
      }
    })
  }

  test(`${descriptor.alias} checks fresh skill contents without changing caches or deployed profiles`, async (context) => {
    const fixture = await fixtureFor(context, descriptor)
    await seedCaches(fixture, 1)
    const profiles = []
    for (const name of Object.keys(fixture.catalog.profiles)) profiles.push(await seedProfile(fixture, name))
    const freshRoot = path.join(fixture.root, "latest")
    const runtimeManager = path.join(fixture.workspace, "scripts/floating-skills.ts")
    await write(
      runtimeManager,
      `
export * from ${JSON.stringify(new URL("../../../scripts/floating-skills.ts", import.meta.url).href)}
import { cp } from "node:fs/promises"
import path from "node:path"
export const stageLatest = async ({ bundleIds, destination, readOnly }) => {
  if (readOnly !== true) throw new Error("check must prohibit package installation")
  if (process.env.SKILLS_FETCH_FAIL === "1") throw new Error("source fetch failed")
  await cp(path.join(${JSON.stringify(freshRoot)}, bundleIds.join("+")), destination, { recursive: true })
}
`,
    )
    await seedSnapshot(
      path.join(freshRoot, descriptor.alias === "cdx" ? "native-common+codex-common" : "native-common"),
      ["kept", "retired"],
      1,
    )
    await seedSnapshot(
      path.join(freshRoot, "native-common+codex-common+youtube"),
      ["kept", "retired", "youtube-full"],
      1,
    )
    await seedSnapshot(path.join(freshRoot, "omp-community"), ["omp-kept", "omp-retired", "pstack-omp"], 1)
    const before = await Promise.all(profiles.map((profile) => treeState(profile.root, true)))
    const caches = await Promise.all(
      [fixture.cache, fixture.youtubeCache, fixture.communityCache].map((cache) => treeState(cache, true)),
    )
    succeeds(run(fixture, ["--help"]))
    assert.match(run(fixture, ["--help"]).stdout, /skills-check PROFILE/)
    for (const profile of profiles) {
      const current = run(fixture, ["skills-check", profile.name])
      succeeds(current)
      assert.ok(
        current.stdout
          .trim()
          .split("\n")
          .every((line) => JSON.parse(line).kind === "current"),
      )
    }
    await seedSnapshot(
      path.join(freshRoot, descriptor.alias === "cdx" ? "native-common+codex-common" : "native-common"),
      ["kept", "retired"],
      2,
    )
    await seedSnapshot(
      path.join(freshRoot, "native-common+codex-common+youtube"),
      ["kept", "retired", "youtube-full"],
      2,
    )
    for (const profile of profiles) {
      const available = run(fixture, ["skills-check", profile.name])
      succeeds(available)
      assert.ok(
        available.stdout
          .trim()
          .split("\n")
          .every((line) => JSON.parse(line).kind === "available"),
      )
    }
    fails(run(fixture, ["skills-check", firstProfileName(fixture)], { SKILLS_FETCH_FAIL: "1" }), /source fetch failed/)
    assert.deepEqual(await Promise.all(profiles.map((profile) => treeState(profile.root, true))), before)
    assert.deepEqual(
      await Promise.all(
        [fixture.cache, fixture.youtubeCache, fixture.communityCache].map((cache) => treeState(cache, true)),
      ),
      caches,
    )
    assert.deepEqual(
      (await readdir(fixture.root)).filter((name) => name.startsWith(".trellage-skills-check.")),
      [],
    )
    await noExternalCalls(fixture)
  })

  test(`${descriptor.alias} updates every catalog profile from cache without other mutations`, async (context) => {
    const fixture = await fixtureFor(context, descriptor)
    const help = run(fixture, ["--help"])
    succeeds(help)
    assert.match(help.stdout, /skills-update PROFILE/)
    await seedCaches(fixture, 1)
    const profiles = []
    for (const name of Object.keys(fixture.catalog.profiles)) profiles.push(await seedProfile(fixture, name))
    await seedCaches(fixture, 2)
    const caches = [fixture.cache, fixture.youtubeCache, fixture.communityCache]
    const cachesBefore = await Promise.all(caches.map((cache) => treeState(cache, true)))
    for (const profile of profiles) {
      const before = await guardState(profile.guards)
      const othersBefore = await otherProfileState(profiles, profile)
      succeeds(run(fixture, ["skills-update", profile.name]))
      for (const { cache, target } of profile.targets) {
        await verifyTarget(cache, target)
        assert.match(await readFile(path.join(target, "custom/SKILL.md"), "utf8"), /^# User/)
        const removed = cache === fixture.communityCache ? "omp-retired" : "retired"
        await assert.rejects(lstat(path.join(target, removed)), { code: "ENOENT" })
      }
      assert.equal(await readFile(path.join(profile.targets[0].target, "user-notes.md"), "utf8"), "Unmanaged notes\n")
      assert.deepEqual(await guardState(profile.guards), before)
      succeeds(run(fixture, ["skills-update", profile.name]))
      assert.deepEqual(await otherProfileState(profiles, profile), othersBefore)
    }
    assert.deepEqual(await Promise.all(caches.map((cache) => treeState(cache, true))), cachesBefore)
    await noExternalCalls(fixture)
  })

  test(`${descriptor.alias} refuses missing profiles, missing caches, and unsafe skill ownership`, async (context) => {
    const fixture = await fixtureFor(context, descriptor)
    const name = firstProfileName(fixture)
    fails(run(fixture, ["skills-update"]), /requires PROFILE|usage:/)
    fails(run(fixture, ["skills-update", name, "extra"]), /requires PROFILE|usage:/)
    fails(run(fixture, ["skills-update", "--all"]), /unknown profile|requires PROFILE|usage:|unsafe profile name/)
    fails(run(fixture, ["skills-update", name]), /not set up|not managed/)
    await seedCaches(fixture, 1)
    const profile = await seedProfile(fixture, name)
    await seedCaches(fixture, 2)
    const target = profile.targets[0].target
    const before = await treeState(target)
    const guards = await guardState(profile.guards)
    await rename(fixture.cache, `${fixture.cache}.saved`)
    fails(run(fixture, ["skills-update", name]), /skill cache is missing:.*run trx skills update first/)
    assert.deepEqual(await treeState(target), before)
    await rename(`${fixture.cache}.saved`, fixture.cache)
    await rename(profile.home, `${profile.home}.saved`)
    await symlink(`${profile.home}.saved`, profile.home)
    fails(run(fixture, ["skills-update", name]), /unsafe|redirected/)
    await rm(profile.home)
    await rename(`${profile.home}.saved`, profile.home)
    await rename(target, `${target}.saved`)
    await symlink(`${target}.saved`, target)
    fails(run(fixture, ["skills-update", name]), /unsafe|symlink/)
    await rm(target)
    await rename(`${target}.saved`, target)
    const manifest = path.join(target, ".trellage-managed-skills")
    const managed = await readFile(manifest, "utf8")
    await rename(manifest, `${manifest}.saved`)
    fails(run(fixture, ["skills-update", name]), /profile skills are not managed/)
    await rename(`${manifest}.saved`, manifest)
    await writeFile(manifest, "../outside\n")
    fails(run(fixture, ["skills-update", name]), /invalid managed skill manifest/)
    await writeFile(manifest, managed)
    await seedSnapshot(fixture.cache, ["custom", "kept"], 2)
    fails(run(fixture, ["skills-update", name]), /refusing to replace unmanaged skill/)
    assert.deepEqual(await treeState(target), before)
    assert.deepEqual(await guardState(profile.guards), guards)
    await noExternalCalls(fixture)
  })
}

test("OMP preflights both bundles before it replaces either copy", async (context) => {
  const fixture = await fixtureFor(
    context,
    launchers.find(({ alias }) => alias === "omp"),
  )
  await seedCaches(fixture, 1)
  const profile = await seedProfile(fixture, "copilot")
  await seedCaches(fixture, 2)
  const before = await treeState(profile.targets[0].target)
  await writeFile(path.join(fixture.communityCache, "managed-skills.txt"), "../invalid\n")
  fails(run(fixture, ["skills-update", "copilot"]), /invalid skill snapshot manifest/)
  assert.deepEqual(await treeState(profile.targets[0].target), before)
  await noExternalCalls(fixture)
})

test("Firstmate keeps both fleets idle and validates worker ownership before it changes the captain", async (context) => {
  const fixture = await fixtureFor(
    context,
    launchers.find(({ alias }) => alias === "fmx"),
  )
  await seedCaches(fixture, 1)
  const profile = await seedProfile(fixture, "pstack-workers")
  await seedCaches(fixture, 2)
  const before = await treeState(profile.targets[0].target)
  const lock = path.join(profile.root, "locks/session")
  await write(path.join(lock, "owner"), `${fixture.descriptor.owner}\n`)
  await write(path.join(lock, "pid"), `${process.pid}\n`)
  fails(run(fixture, ["skills-update", profile.name]), /fleet is active/)
  assert.deepEqual(await treeState(profile.targets[0].target), before)
  await rm(lock, { recursive: true })
  const workerTarget = profile.targets[1]
  assert.ok(workerTarget, "Firstmate fixture must contain a worker target")
  const worker = path.dirname(path.dirname(workerTarget.target))
  await write(path.join(worker, ".managed-by-trellage-firstmate-profiles"), "not-owned\n")
  fails(run(fixture, ["skills-update", profile.name]), /ownership marker differs/)
  assert.deepEqual(await treeState(profile.targets[0].target), before)
  await noExternalCalls(fixture)
})

test("Codex YouTube management bypasses Varlock and rejects management verbs as native-auth profiles", async (context) => {
  const fixture = await fixtureFor(
    context,
    launchers.find(({ alias }) => alias === "cdx"),
  )
  await seedCaches(fixture, 1)
  const profile = await seedProfile(fixture, "youtube")
  await seedCaches(fixture, 2)
  await write(
    path.join(fixture.home, ".local/share/trellage/common/native-environment-runtime"),
    "unsafe Varlock path\n",
  )
  succeeds(run(fixture, ["skills-update", "youtube"]))
  await verifyTarget(fixture.youtubeCache, profile.targets[0].target)
  fails(run(fixture, ["--native-auth", "skills-update"]), /Usage:/)
  await noExternalCalls(fixture)
})

test("Claude and Codex skills management scrub provider credentials but retain file-backed GitHub configuration", async (context) => {
  for (const alias of ["cldx", "cdx", "fmx"]) {
    const fixture = await fixtureFor(
      context,
      launchers.find((entry) => entry.alias === alias),
    )
    await seedCaches(fixture, 1)
    const name = firstProfileName(fixture)
    await seedProfile(fixture, name)
    await seedCaches(fixture, 2)
    succeeds(
      run(fixture, ["skills-update", name], {
        GH_TOKEN: "fixture-github",
        ANTHROPIC_API_KEY: "fixture-claude",
        OPENAI_API_KEY: "fixture-openai",
        TRANSCRIPT_API_KEY: "fixture-transcript",
        CODEX_API_KEY: "fixture-codex",
      }),
    )
    const lines = (await readFile(fixture.envLog, "utf8")).trim().split("\n")
    assert.ok(lines.length > 0)
    for (const line of lines) {
      const [ghConfig, github, claude, openai, transcript, codex] = line.split("|")
      assert.equal(ghConfig, fixture.env.GH_CONFIG_DIR)
      assert.deepEqual([github, claude, openai], ["unset", "unset", "unset"])
      if (alias === "cdx") assert.deepEqual([transcript, codex], ["unset", "unset"])
    }
    await noExternalCalls(fixture)
  }
})

test("cache-only updates reject redirected caches, shared writes, hard links, and managed skill symlinks", async (context) => {
  const fixture = await fixtureFor(
    context,
    launchers.find(({ alias }) => alias === "cpx"),
  )
  await seedCaches(fixture, 1)
  const profile = await seedProfile(fixture, "superpowers")
  await seedCaches(fixture, 2)
  const target = profile.targets[0].target
  const before = await treeState(target)
  await rename(fixture.cache, `${fixture.cache}.saved`)
  await symlink(`${fixture.cache}.saved`, fixture.cache)
  fails(run(fixture, ["skills-update", profile.name]), /symlink/)
  await rm(fixture.cache)
  await rename(`${fixture.cache}.saved`, fixture.cache)
  const redirectedData = path.join(fixture.root, "redirected-data")
  await symlink(path.join(fixture.home, ".local/share"), redirectedData)
  fails(run(fixture, ["skills-update", profile.name], { XDG_DATA_HOME: redirectedData }), /redirected skill cache/)
  await chmod(fixture.cache, 0o777)
  fails(run(fixture, ["skills-update", profile.name]), /writable by another user/)
  await chmod(fixture.cache, 0o700)
  const skill = path.join(target, "kept/SKILL.md")
  const linked = path.join(fixture.root, "linked-skill")
  await link(skill, linked)
  fails(run(fixture, ["skills-update", profile.name]), /hard-linked/)
  await rm(linked)
  await rename(skill, `${skill}.saved`)
  await symlink(`${skill}.saved`, skill)
  fails(run(fixture, ["skills-update", profile.name]), /symlink/)
  await rm(skill)
  await rename(`${skill}.saved`, skill)
  const legacy = path.join(target, ".trellage-engineersamuel-skills")
  await write(legacy, "not-a-source-commit\nkept\n")
  fails(run(fixture, ["skills-update", profile.name]), /invalid legacy managed skill manifest/)
  await rm(legacy)
  const lock = path.join(target, ".trellage-floating-skills.lock")
  await write(path.join(lock, "pid"), "999999999\n")
  await write(path.join(lock, "unowned-data"), "Do not delete\n")
  const lockBefore = await treeState(lock, true)
  fails(run(fixture, ["skills-update", profile.name]), /invalid skill lock/)
  assert.deepEqual(await treeState(lock, true), lockBefore)
  await rm(lock, { recursive: true })
  assert.deepEqual(await treeState(target), before)
  await noExternalCalls(fixture)
})

test("cache-only updates honor XDG_DATA_HOME without changing the default cache", async (context) => {
  const fixture = await fixtureFor(
    context,
    launchers.find(({ alias }) => alias === "cdx"),
  )
  await seedCaches(fixture, 1)
  const profile = await seedProfile(fixture, "youtube")
  const defaultBefore = await treeState(fixture.youtubeCache, true)
  const xdg = path.join(fixture.root, "data")
  const cache = path.join(xdg, "trellage/common/cdx-youtube-pro-skills")
  await seedSnapshot(cache, ["added", "kept", "youtube-full"], 2)
  succeeds(run(fixture, ["skills-update", "youtube"], { XDG_DATA_HOME: xdg }))
  await verifyTarget(cache, profile.targets[0].target)
  assert.deepEqual(await treeState(fixture.youtubeCache, true), defaultBefore)
  await noExternalCalls(fixture)
})

test("cache-only updates accept the Native wrappers' canonical HOME boundary", async (context) => {
  const fixture = await fixtureFor(
    context,
    launchers.find(({ alias }) => alias === "cpx"),
  )
  await seedCaches(fixture, 1)
  const profile = await seedProfile(fixture, "superpowers")
  await seedCaches(fixture, 2)
  const parentAlias = path.join(fixture.root, "parent-alias")
  await symlink(fixture.root, parentAlias)
  succeeds(run(fixture, ["skills-update", profile.name], { HOME: path.join(parentAlias, "home") }))
  await verifyTarget(fixture.cache, profile.targets[0].target)
  await noExternalCalls(fixture)
})

test("Pi skills-only synchronization keeps the legacy managed ownership migration safe", async (context) => {
  const fixture = await fixtureFor(
    context,
    launchers.find(({ alias }) => alias === "picx"),
  )
  await seedCaches(fixture, 1)
  const profile = await seedProfile(fixture, "default")
  const target = profile.targets[0].target
  await rm(path.join(target, ".trellage-managed-skills"))
  await write(path.join(target, ".trellage-engineersamuel-skills"), `${"a".repeat(40)}\nkept\nretired\n`)
  await write(path.join(target, "show-me/SKILL.md"), "# Legacy show-me\n")
  await write(path.join(target, "show-me/.managed-by-trellage-picx-profiles"), "trellage-picx-profile-v2\n")
  await seedSnapshot(fixture.cache, ["added", "kept", "show-me"], 2)
  succeeds(run(fixture, ["skills-update", "default"]))
  await verifyTarget(fixture.cache, target)
  await assert.rejects(lstat(path.join(target, "retired")), { code: "ENOENT" })
  assert.equal(await readFile(path.join(target, "custom/SKILL.md"), "utf8"), "# User skill\n")
  await noExternalCalls(fixture)
})
