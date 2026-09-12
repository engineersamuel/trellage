import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, readdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { bunArguments, bunExecutable, sourceEnvironment } from "@trellage/runtime"
import { GuideGoalCancelledError, GuideGoalError } from "./guide-goal-augment.ts"
import type { CommandRunner } from "./guide-launch.ts"

export interface GuideGoalSkills {
  readonly goalMeContent: string
  readonly skillDirectories: ReadonlyArray<string>
  readonly workingDirectory: string
  readonly baseDirectory: string
  dispose(): Promise<void>
}

export type GuideGoalSkillResolver = (signal: AbortSignal) => Promise<GuideGoalSkills>

export interface GuideGoalSkillResolverOptions {
  readonly managerPath: string
  readonly catalogPath: string
  readonly cachePath: string
  readonly runner: CommandRunner
  /** Defaults to the explicit cache's parent, outside the project. */
  readonly stagingRoot?: string
}

const updateGuidance = "Check the configured skills runtime, run `trx skills update`, then retry Goal me."
const maximumSkillFileBytes = 1024 * 1024

const skillError = (message: string, cause?: unknown): GuideGoalError =>
  new GuideGoalError(`${message} ${updateGuidance}`, { cause })

const checkSignal = (signal: AbortSignal): void => {
  if (signal.aborted) throw new GuideGoalCancelledError()
}

const regularFileBytes = async (file: string): Promise<Buffer> => {
  const status = await lstat(file)
  if (!status.isFile() || status.isSymbolicLink() || status.size > maximumSkillFileBytes) {
    throw skillError(`The installed skill file is not a supported regular file: ${file}.`)
  }
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const current = await handle.stat()
    if (!current.isFile() || current.size > maximumSkillFileBytes) {
      throw skillError(`The installed skill file changed while reading: ${file}.`)
    }
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

const assertSkillName = (content: string, expected: string): void => {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content)?.[1]
  const names = [...(frontmatter ?? "").matchAll(/^name:[ \t]*(.+?)[ \t]*\r?$/gmu)]
  const name = names[0]?.[1]
  if (names.length !== 1 || ![expected, `"${expected}"`, `'${expected}'`].includes(name ?? "")) {
    throw skillError(`The installed ${expected} SKILL.md has an invalid skill name.`)
  }
}

const freezeSkillTree = async (source: string, target: string, signal: AbortSignal): Promise<void> => {
  checkSignal(signal)
  const status = await lstat(source)
  if (status.isSymbolicLink()) throw skillError("An installed Goal me skill contains a symbolic link.")
  if (status.isDirectory()) {
    await mkdir(target, { mode: 0o700 })
    for (const entry of await readdir(source)) {
      await freezeSkillTree(path.join(source, entry), path.join(target, entry), signal)
    }
    await chmod(target, 0o500)
  } else if (status.isFile()) {
    await writeFile(target, await regularFileBytes(source), { flag: "wx", mode: 0o400 })
  } else {
    throw skillError("An installed Goal me skill contains an unsupported file.")
  }
}

const removeOwnedStage = async (root: string): Promise<void> => {
  const makeRemovable = async (directory: string): Promise<void> => {
    const status = await lstat(directory)
    if (!status.isDirectory() || status.isSymbolicLink()) return
    await chmod(directory, 0o700)
    for (const entry of await readdir(directory)) await makeRemovable(path.join(directory, entry))
  }
  await makeRemovable(root)
  await rm(root, { recursive: true, force: true })
}

const assertRuntimePath = async (file: string, label: string): Promise<void> => {
  if (!path.isAbsolute(file)) throw skillError(`The ${label} path must be absolute.`)
  const status = await lstat(file)
  if (!status.isFile() || status.isSymbolicLink()) {
    throw skillError(`The ${label} is missing or is not a regular file.`)
  }
}

const createOwnedStage = async (options: GuideGoalSkillResolverOptions, signal: AbortSignal): Promise<string> => {
  checkSignal(signal)
  await assertRuntimePath(options.managerPath, "floating-skills manager")
  await assertRuntimePath(options.catalogPath, "skill catalog")
  if (!path.isAbsolute(options.cachePath)) throw skillError("The native-common cache path must be absolute.")
  const stagingRoot = options.stagingRoot ?? path.dirname(options.cachePath)
  if (!path.isAbsolute(stagingRoot)) throw skillError("The Goal me staging path must be absolute.")
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
  const rootStatus = await lstat(stagingRoot)
  if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
    throw skillError("The Goal me staging root is not a regular directory.")
  }
  checkSignal(signal)
  const root = path.join(stagingRoot, `.trx-guide-goal-${randomUUID()}`)
  await mkdir(root, { mode: 0o700 })
  return root
}

const ensureBundle = async (
  options: GuideGoalSkillResolverOptions,
  root: string,
  signal: AbortSignal,
): Promise<string> => {
  const bundle = path.join(root, "bundle")
  try {
    await options.runner.run(
      bunExecutable(),
      bunArguments(options.managerPath, [
        "ensure",
        "--bundle", "native-common",
        "--catalog", options.catalogPath,
        "--cache", options.cachePath,
        "--target", bundle,
      ]),
      {
        cwd: root,
        signal,
        timeoutMs: 180_000,
        env: sourceEnvironment({ ...process.env, TMPDIR: root, TEMP: root, TMP: root, NODE_DISABLE_COMPILE_CACHE: "1" }),
      },
    )
  } catch (cause) {
    checkSignal(signal)
    throw skillError("The native-common skill bundle could not be prepared.", cause)
  }
  checkSignal(signal)
  return bundle
}

const stageSelectedSkill = async (
  bundle: string,
  skillsRoot: string,
  name: "goal-me" | "grill-me",
  signal: AbortSignal,
): Promise<{ readonly directory: string; readonly content: string } | undefined> => {
  const source = path.join(bundle, name)
  let status
  try {
    status = await lstat(source)
  } catch (cause) {
    if (name === "grill-me" && (cause as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw skillError(`The installed ${name} skill is missing.`, cause)
  }
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw skillError(`The installed ${name} skill is not a regular directory.`)
  }
  assertSkillName((await regularFileBytes(path.join(source, "SKILL.md"))).toString("utf8"), name)
  const directory = path.join(skillsRoot, name)
  await freezeSkillTree(source, directory, signal)
  const content = (await regularFileBytes(path.join(directory, "SKILL.md"))).toString("utf8")
  assertSkillName(content, name)
  return { directory, content }
}

const selectGoalSkills = async (root: string, bundle: string, signal: AbortSignal): Promise<GuideGoalSkills> => {
  const skillsRoot = path.join(root, "skills")
  await mkdir(skillsRoot, { mode: 0o700 })
  const goal = await stageSelectedSkill(bundle, skillsRoot, "goal-me", signal)
  if (goal === undefined) throw skillError("The installed goal-me skill is missing.")
  const grill = await stageSelectedSkill(bundle, skillsRoot, "grill-me", signal)
  await removeOwnedStage(bundle)
  const workingDirectory = path.join(root, "work")
  const baseDirectory = path.join(root, "runtime")
  await mkdir(workingDirectory, { mode: 0o700 })
  await mkdir(baseDirectory, { mode: 0o700 })
  checkSignal(signal)
  let disposal: Promise<void> | undefined
  return {
    goalMeContent: goal.content,
    skillDirectories: Object.freeze([goal.directory, ...(grill === undefined ? [] : [grill.directory])]),
    workingDirectory,
    baseDirectory,
    dispose: () => (disposal ??= removeOwnedStage(root)),
  }
}

/** No manager command or file read occurs until the returned resolver is called. */
export const createGuideGoalSkillResolver = (options: GuideGoalSkillResolverOptions): GuideGoalSkillResolver =>
  async (signal) => {
    let ownedRoot: string | undefined
    try {
      ownedRoot = await createOwnedStage(options, signal)
      return await selectGoalSkills(ownedRoot, await ensureBundle(options, ownedRoot, signal), signal)
    } catch (cause) {
      if (ownedRoot !== undefined) {
        try {
          await removeOwnedStage(ownedRoot)
        } catch {
          // The setup or cancellation error remains primary.
        }
      }
      checkSignal(signal)
      if (cause instanceof GuideGoalError) throw cause
      throw skillError("Goal me could not load its installed skill.", cause)
    }
  }
