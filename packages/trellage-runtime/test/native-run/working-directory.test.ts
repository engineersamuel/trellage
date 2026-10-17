import { afterEach, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import { parseTrellageConfig } from "../../src/native-config.ts"
import { prepareRun, runNative, type RunDependencies, type Spawner } from "../../src/native-run/run.ts"
import { syncProfileRepository } from "../../src/native-run/repository-sync.ts"
import { gitSourceTransport } from "../../src/native-run/source.ts"
import { cleanupFixtures, fixturePaths, git, tempRoot } from "./fixtures.ts"

afterEach(cleanupFixtures)

const base = { dryRun: false, allowUnprovenIsolation: true, forwardedArgs: [] as string[] }

const world = async () => {
  const root = await tempRoot("workdir")
  const fleet = path.join(root, "fleet")
  await mkdir(path.join(fleet, ".pi", "extensions", "lib"), { recursive: true })
  await mkdir(path.join(fleet, ".agents", "skills", "ahoy"), { recursive: true })
  await mkdir(path.join(fleet, ".agents", "skills", "notes"), { recursive: true })
  await writeFile(path.join(fleet, ".pi", "extensions", "fm-watch.ts"), "export default () => {}\n")
  await writeFile(path.join(fleet, ".pi", "extensions", "lib", "helper.ts"), "export {}\n")
  await writeFile(path.join(fleet, ".agents", "skills", "ahoy", "SKILL.md"), "---\nname: ahoy\n---\n")
  const configPath = path.join(root, "config.toml")
  await writeFile(
    configPath,
    `schema_version = 1
[native.profiles.fleet]
harnesses = ["claude", "pi"]
current_working_directory = ${JSON.stringify(fleet)}
project_resources = true
[native.profiles.synced]
harnesses = ["claude"]
current_working_directory = "~/synced"
repository = { url = "https://example.invalid/fleet.git" }
[native.profiles.other]
current_working_directory = "/elsewhere"
`,
    { mode: 0o600 },
  )
  const work = path.join(root, "work")
  await mkdir(work)
  const paths = await fixturePaths(root)
  const synced: Array<{ directory: string; url: string; branch: string }> = []
  const dependencies = (spawner?: Spawner): RunDependencies => ({
    environment: { PATH: process.env.PATH ?? "", TRELLAGE_CONFIG: configPath, HOME: root },
    paths,
    cwd: work,
    transport: gitSourceTransport(() => {
      throw new Error("no sources")
    }),
    write: () => undefined,
    refreshHarness: async () => undefined,
    syncRepository: async (directory, repository) => {
      synced.push({ directory, ...repository })
    },
    ...(spawner ? { spawner } : {}),
  })
  return { root, fleet, work, synced, dependencies }
}

test("config accepts working-directory fields and rejects a repository without a directory", async () => {
  const parsed = await Effect.runPromise(
    parseTrellageConfig(`[native.profiles.fm]
current_working_directory = "~/fm"
repository = { url = "https://example.invalid/fm.git" }
project_resources = true
`),
  )
  expect(parsed.native.profiles.fm).toMatchObject({
    current_working_directory: "~/fm",
    repository: { url: "https://example.invalid/fm.git", branch: "main" },
    project_resources: true,
  })
  await expect(
    Effect.runPromise(parseTrellageConfig(`[native.profiles.fm]\nrepository = { url = "https://example.invalid/fm.git" }\n`)),
  ).rejects.toThrow(/repository without current_working_directory/)
  await expect(
    Effect.runPromise(parseTrellageConfig(`[native.profiles.fm]\ncurrent_working_directory = "relative/dir"\n`)),
  ).rejects.toThrow(/current_working_directory/)
})

test("a profile working directory replaces the invocation directory for launch and trust", async () => {
  const { root, fleet, dependencies } = await world()
  const prepared = await prepareRun({ ...base, harness: "claude", profiles: ["fleet"] }, dependencies())
  expect(prepared.workspace).toBe(fleet)
  const lifecycle = path.join(root, "claude-lifecycle")
  await writeFile(lifecycle, `#!/bin/sh\nprintf '{"pluginDir":null}'\n`, { mode: 0o755 })
  let spawnedIn = ""
  const status = await runNative(
    { ...base, harness: "claude", profiles: ["fleet"] },
    {
      ...dependencies(async (_launch, _environment, cwd, onSpawn) => {
        spawnedIn = cwd
        onSpawn(undefined)
        return 0
      }),
      environment: { ...dependencies().environment, TRELLAGE_CLAUDE_LIFECYCLE_BIN: lifecycle },
    },
  )
  expect(status).toBe(0)
  expect(spawnedIn).toBe(fleet)
  const state = JSON.parse(await readFile(path.join(prepared.layout.generationPath, ".claude.json"), "utf8"))
  expect(Object.keys(state.projects)).toContain(fleet)
})

test("without a profile working directory the invocation directory is used", async () => {
  const { work, dependencies } = await world()
  const prepared = await prepareRun({ ...base, harness: "pi", profiles: [] }, dependencies())
  expect(prepared.workspace).toBe(work)
})

test("a profile is refused on a harness outside its harness list", async () => {
  const { dependencies } = await world()
  await expect(prepareRun({ ...base, harness: "codex", profiles: ["fleet"] }, dependencies())).rejects.toThrow(
    /profile fleet does not support Codex; it supports: claude, pi/,
  )
})

test("two profiles with different working directories are refused", async () => {
  const { dependencies } = await world()
  await expect(prepareRun({ ...base, harness: "claude", profiles: ["fleet", "other"] }, dependencies())).rejects.toThrow(
    /different working directories/,
  )
})

test("the repository is synced before launch, expanded from home, and skipped on dry run", async () => {
  const { root, synced, dependencies } = await world()
  await prepareRun({ ...base, dryRun: true, harness: "claude", profiles: ["synced"] }, dependencies())
  expect(synced).toEqual([])
  const prepared = await prepareRun({ ...base, harness: "claude", profiles: ["synced"] }, dependencies())
  expect(prepared.workspace).toBe(path.join(root, "synced"))
  expect(synced).toEqual([{ directory: path.join(root, "synced"), url: "https://example.invalid/fleet.git", branch: "main" }])
})

test("pi loads the working directory's own extensions and skills only with project_resources", async () => {
  const { fleet, dependencies } = await world()
  const prepared = await prepareRun({ ...base, harness: "pi", profiles: ["fleet"] }, dependencies())
  const args = prepared.launch.args
  expect(args).toContain("--no-extensions")
  expect(args).toContain(path.join(fleet, ".pi", "extensions", "fm-watch.ts"))
  expect(args).not.toContain(path.join(fleet, ".pi", "extensions", "lib", "helper.ts"))
  expect(args).toContain(path.join(fleet, ".agents", "skills", "ahoy"))
  expect(args).not.toContain(path.join(fleet, ".agents", "skills", "notes"))
  const plain = await prepareRun({ ...base, harness: "pi", profiles: [] }, dependencies())
  expect(plain.launch.args.some((argument) => argument.startsWith(fleet))).toBe(false)
})

test("repository sync clones when missing, rebases when present, and refuses a foreign origin", async () => {
  const root = await tempRoot("sync")
  const origin = path.join(root, "origin.git")
  const seed = path.join(root, "seed")
  await mkdir(seed)
  await git(seed, "init", "-q", "-b", "main")
  await writeFile(path.join(seed, "AGENTS.md"), "one\n")
  await git(seed, "add", ".")
  await git(seed, "commit", "-qm", "one")
  await git(root, "clone", "-q", "--bare", seed, origin)
  const target = path.join(root, "home", "fleet")
  const environment = { PATH: process.env.PATH ?? "", HOME: root }
  await syncProfileRepository(target, { url: origin, branch: "main" }, environment)
  expect(await git(target, "log", "-1", "--format=%s")).toBe("one")

  await writeFile(path.join(seed, "AGENTS.md"), "two\n")
  await git(seed, "commit", "-qam", "two")
  await git(seed, "push", "-q", origin, "main")
  await syncProfileRepository(target, { url: origin, branch: "main" }, environment)
  expect(await git(target, "log", "-1", "--format=%s")).toBe("two")

  await expect(
    syncProfileRepository(target, { url: "https://example.invalid/other.git", branch: "main" }, environment),
  ).rejects.toThrow(/expected https:\/\/example.invalid\/other.git/)
})

test("the shipped firstmate profile runs on claude and pi from its own clone and is refused elsewhere", async () => {
  const { root, synced, dependencies } = await world()
  const tools = path.join(root, "tools")
  await mkdir(tools)
  for (const tool of ["git", "gh", "jq", "node", "treehouse", "gh-axi", "tasks-axi"])
    await writeFile(path.join(tools, tool), "#!/bin/sh\n", { mode: 0o755 })
  const withTools = { ...dependencies(), environment: { ...dependencies().environment, PATH: tools } }
  const prepared = await prepareRun({ ...base, harness: "claude", profiles: ["firstmate"] }, withTools)
  const home = path.join(root, ".local/share/trellage/firstmate")
  expect(prepared.workspace).toBe(home)
  expect(synced).toEqual([{ directory: home, url: "https://github.com/kunchenguid/firstmate.git", branch: "main" }])
  await expect(prepareRun({ ...base, harness: "grok", profiles: ["firstmate"] }, dependencies())).rejects.toThrow(
    /profile firstmate does not support Grok; it supports: claude, pi/,
  )
})
