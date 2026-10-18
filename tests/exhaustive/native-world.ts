import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { readTrellageConfig, type NativeCatalog, type NativeProfile } from "../../packages/trellage-runtime/src/native-config.ts"
import type { SourceTransport } from "../../packages/trellage-runtime/src/native-run/source.ts"
import type { RunDependencies } from "../../packages/trellage-runtime/src/native-run/run.ts"

const requestRecorder = (requests: Map<string, number>) => (operation: string, repository: string, value: string): void => {
  const key = JSON.stringify([operation, repository, value])
  requests.set(key, (requests.get(key) ?? 0) + 1)
}

const repositoryIndex = () => {
  const repositories = new Map<string, Map<string, string>>()
  const commits = new Map<string, Set<string>>()
  const filesFor = (repository: string) => {
    let files = repositories.get(repository)
    if (!files) repositories.set(repository, (files = new Map()))
    return files
  }
  return { repositories, commits, filesFor }
}

const skillFactory = (filesFor: (repository: string) => Map<string, string>) => (repository: string, name: string): void => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`Undeclared fixture skill grammar: ${name}`)
  filesFor(repository).set(
    `skills/${name}/SKILL.md`,
    `---\nname: ${name}\ndescription: Deterministic local source fixture\n${name === "i-have-adhd" ? "disable-model-invocation: true\n" : ""}---\n# ${name}\n`,
  )
}

const addProfileSkills = (
  profile: NativeProfile,
  config: NativeCatalog,
  addSkill: (repository: string, name: string) => void,
): void => {
  for (const selection of profile.skills) {
    const source = config.sources[selection.source]!
    for (const name of selection.names) addSkill(source.repository, name === "*" ? "wildcard-fixture" : name)
  }
}

const addProfilePlugins = (
  profile: NativeProfile,
  config: NativeCatalog,
  filesFor: (repository: string) => Map<string, string>,
): void => {
  for (const selection of profile.plugins) {
    const source = config.sources[selection.source]!
    const name = selection.name ?? selection.plugin ?? path.basename(selection.path)
    const relative = path.join(selection.path, ".claude-plugin/plugin.json")
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Unsafe plugin fixture: ${relative}`)
    const files = filesFor(source.repository)
    const manifest = JSON.stringify({ name, description: "Deterministic plugin fixture", version: "1.0.0" })
    if (files.has(relative) && files.get(relative) !== manifest)
      throw new Error(`Conflicting plugin fixture: ${source.repository}/${relative}`)
    files.set(relative, manifest)
    files.set(path.join(selection.path, "commands/fixture.md"), "# Deterministic plugin command\n")
  }
}

const seedRepositories = (
  config: NativeCatalog,
  repositories: Map<string, Map<string, string>>,
  commits: Map<string, Set<string>>,
  filesFor: (repository: string) => Map<string, string>,
  addSkill: (repository: string, name: string) => void,
): void => {
  for (const source of Object.values(config.sources)) {
    filesFor(source.repository)
    if (source.commit) {
      const values = commits.get(source.repository) ?? new Set<string>()
      values.add(source.commit)
      commits.set(source.repository, values)
    }
    for (const name of source.required ?? []) addSkill(source.repository, name)
  }
  for (const profile of Object.values(config.profiles)) {
    addProfileSkills(profile, config, addSkill)
    addProfilePlugins(profile, config, filesFor)
  }
  for (const repository of ["example/skills", "example/.github", "example-team/skills"]) addSkill(repository, "review")
  addSkill("example/skills", "initial")
}

const identityFor = (repositories: Map<string, Map<string, string>>) => (repository: string): string => {
  const files = repositories.get(repository)
  if (!files) throw new Error(`Unexpected fixture source request: ${repository}`)
  return createHash("sha1").update(JSON.stringify([repository, [...files].sort()])).digest("hex")
}

const createFixtureTransport = (
  config: NativeCatalog,
  requests: Map<string, number>,
) => {
  const { repositories, commits, filesFor } = repositoryIndex()
  const recordRequest = requestRecorder(requests)
  const addSkill = skillFactory(filesFor)
  seedRepositories(config, repositories, commits, filesFor, addSkill)
  const identity = identityFor(repositories)
  const transport: SourceTransport = {
    async resolveRef(repository, ref) {
      recordRequest("resolve", repository, ref)
      return identity(repository)
    },
    async fetchCommit(repository, commit, destination) {
      recordRequest("fetch", repository, commit)
      if (commit !== identity(repository) && !commits.get(repository)?.has(commit))
        throw new Error(`Unexpected commit request: ${repository}@${commit}`)
      for (const [relative, text] of repositories.get(repository)!) {
        const file = path.join(destination, relative)
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, text, { mode: 0o644 })
      }
    },
  }
  const inventory = [...repositories].map(([repository, files]) => ({
    repository,
    files: [...files.keys()].sort(),
    commit: identity(repository),
  }))
  return { transport, inventory }
}

const copyInstructionFiles = async (
  instructions: NativeCatalog["instructions"],
  repositoryRoot: string,
  destinationRoot: string,
): Promise<void> => {
  for (const instruction of Object.values(instructions)) {
    const source = path.resolve(repositoryRoot, instruction.file)
    const relative = path.relative(repositoryRoot, source)
    if (relative.startsWith("..") || path.isAbsolute(relative))
      throw new Error(`Instruction fixture must belong to the source repository: ${instruction.file}`)
    const destination = path.join(destinationRoot, relative)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, await readFile(source), { mode: 0o600 })
  }
}

const dependenciesFor = (
  root: string,
  repositoryRoot: string,
  configPath: string,
  transport: SourceTransport,
): RunDependencies => ({
  environment: {
    PATH: process.env.PATH ?? "",
    HOME: root,
    TRELLAGE_CONFIG: configPath,
    TRELLAGE_TEST_OFFLINE: "1",
    TRELLAGE_TEST_VIOLATIONS: process.env.TRELLAGE_TEST_VIOLATIONS,
  },
  paths: { cache: path.join(root, "cache"), data: path.join(root, "data"), state: path.join(root, "state") },
  cwd: repositoryRoot,
  configHome: root,
  transport,
  write: () => {},
  refreshHarness: async () => undefined,
  spawner: async () => {
    throw new Error("Unexpected launch: install an explicit assertion spawner for this case")
  },
})

export const nativeMatrixWorld = async (repositoryRoot: string) => {
  await mkdir(path.join(repositoryRoot, ".test-performance"), { recursive: true })
  const root = await mkdtemp(path.join(repositoryRoot, ".test-performance/native-matrix-world."))
  const configPath = path.join(root, "config.example.toml")
  const original = path.join(repositoryRoot, "config.example.toml")
  await writeFile(configPath, await readFile(original), { mode: 0o600 })
  const { config } = await readTrellageConfig({ environment: { TRELLAGE_CONFIG: original } })
  await copyInstructionFiles(config.native.instructions, repositoryRoot, root)
  const requests = new Map<string, number>()
  const fixture = createFixtureTransport(config.native, requests)
  return {
    root,
    config,
    dependencies: dependenciesFor(root, repositoryRoot, configPath, fixture.transport),
    requests,
    inventory: fixture.inventory,
    dispose: () => rm(root, { recursive: true, force: true }),
  }
}
