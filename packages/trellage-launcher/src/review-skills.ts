import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, lstat, mkdir, open, opendir, realpath, rmdir, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { bunArguments, bunExecutable, sourceEnvironment } from "@trellage/runtime"
import type { CommandRunner } from "./guide-launch.ts"
import type { ReviewDefinition } from "./review-catalog.ts"

export interface ReviewSkillOptions {
  readonly managerPath: string
  readonly catalogPath: string
  readonly cachePath: string
  readonly runner: CommandRunner
  readonly stagingRoot?: string
}

export interface ReviewWorkspace {
  readonly root: string
  readonly work: string
  readonly runtime: string
  readonly skills: ReadonlyMap<string, string>
  readonly references: ReadonlyMap<string, string>
  dispose(): Promise<void>
}

interface FreezeBudget {
  remaining: number
  entries: number
  deadline: number
}

const check = (signal: AbortSignal, budget: FreezeBudget, file: string): void => {
  signal.throwIfAborted()
  if (performance.now() >= budget.deadline) throw new Error(`Review skill freeze exceeded 30000 ms: ${file}`)
}

const bytes = async (file: string, checkBudget: () => void = () => {}): Promise<Buffer> => {
  checkBudget()
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Unsafe installed skill file: ${file}`)
  if (stat.size > 1024 * 1024) throw new Error(`Installed skill file exceeds 1 MiB: ${file}`)
  checkBudget()
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    checkBudget()
    const opened = await handle.stat()
    if (!opened.isFile()) throw new Error(`Unsafe installed skill file: ${file}`)
    if (opened.size > 1024 * 1024) throw new Error(`Installed skill file exceeds 1 MiB: ${file}`)
    const content = Buffer.alloc(1024 * 1024 + 1)
    let length = 0
    while (length < content.length) {
      checkBudget()
      const { bytesRead } = await handle.read(content, length, content.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    checkBudget()
    if (length > 1024 * 1024) throw new Error(`Installed skill file exceeds 1 MiB: ${file}`)
    return content.subarray(0, length)
  } finally {
    await handle.close()
  }
}

const freeze = async (source: string, target: string, signal: AbortSignal, budget: FreezeBudget, depth = 0): Promise<void> => {
  const guard = (): void => check(signal, budget, source)
  guard()
  if (++budget.entries > 1024) throw new Error(`Installed review skills exceed 1024 entries: ${source}`)
  if (depth > 16) throw new Error(`Installed review skill exceeds depth 16: ${source}`)
  const stat = await lstat(source)
  guard()
  if (stat.isSymbolicLink()) throw new Error(`Installed review skill contains a symbolic link: ${source}`)
  if (stat.isDirectory()) {
    await mkdir(target, { mode: 0o700 })
    guard()
    const directory = await opendir(source)
    try {
      while (true) {
        guard()
        const entry = await directory.read()
        if (!entry) break
        await freeze(path.join(source, entry.name), path.join(target, entry.name), signal, budget, depth + 1)
      }
    } finally {
      await directory.close()
    }
    guard()
    await chmod(target, 0o500)
  } else if (stat.isFile()) {
    const content = await bytes(source, guard)
    budget.remaining -= content.length
    if (budget.remaining < 0) throw new Error(`Installed review skills exceed 4 MiB: ${source}`)
    guard()
    await writeFile(target, content, { flag: "wx", mode: 0o400 })
  } else throw new Error(`Installed review skill contains an unsupported file: ${source}`)
  guard()
}

class CleanupError extends Error {}

const dispose = async (root: string): Promise<void> => {
  const deadline = performance.now() + 5000
  const guard = (): void => {
    if (performance.now() >= deadline) throw new Error("Cleanup exceeded 5000 ms")
  }
  const remove = async (file: string): Promise<void> => {
    guard()
    const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (!stat) return
    guard()
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      await unlink(file)
      return
    }
    await chmod(file, 0o700)
    guard()
    const directory = await opendir(file)
    try {
      while (true) {
        guard()
        const entry = await directory.read()
        if (!entry) break
        await remove(path.join(file, entry.name))
      }
    } finally {
      await directory.close()
    }
    guard()
    await rmdir(file)
  }
  try {
    await remove(root)
  } catch (error) {
    throw new CleanupError(`Review cleanup failed; retained owned path ${root}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

const validFile = async (file: string): Promise<void> => {
  if (!path.isAbsolute(file)) throw new Error("Review skill runtime paths must be absolute.")
  await bytes(file)
}

const stageRoot = async (options: ReviewSkillOptions, repository: string): Promise<string> => {
  await validFile(options.managerPath)
  await validFile(options.catalogPath)
  if (!path.isAbsolute(options.cachePath)) throw new Error("Review cache path must be absolute.")
  const stagingRoot = options.stagingRoot ?? path.dirname(options.cachePath)
  if (!path.isAbsolute(stagingRoot)) throw new Error("Review staging root must be absolute.")
  const repo = await realpath(repository)
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 })
  const parent = await realpath(stagingRoot)
  if (parent === repo || parent.startsWith(`${repo}${path.sep}`) || repo.startsWith(`${parent}${path.sep}`)) {
    throw new Error("Review staging must be outside the reviewed repository.")
  }
  const cache = path.resolve(options.cachePath)
  if (cache === repo || cache.startsWith(`${repo}${path.sep}`)) throw new Error("Review cache must be outside the repository.")
  return parent
}

const stageSkill = async (
  review: ReviewDefinition,
  bundle: string,
  skillsRoot: string,
  signal: AbortSignal,
  budget: FreezeBudget,
): Promise<{ directory: string; references: ReadonlyMap<string, string> }> => {
  if (!/^[a-z][a-z0-9-]*$/u.test(review.skill)) throw new Error("Invalid review skill name.")
  const source = path.join(bundle, review.skill)
  const guard = (): void => check(signal, budget, source)
  guard()
  const status = await lstat(source)
  if (!status.isDirectory() || status.isSymbolicLink()) throw new Error(`Unsafe installed skill directory: ${source}`)
  const content = (await bytes(path.join(source, "SKILL.md"), guard)).toString("utf8")
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(content)?.[1] ?? ""
  const names = [...frontmatter.matchAll(/^name:[ \t]*['"]?([a-z][a-z0-9-]*)['"]?[ \t]*$/gmu)]
  if (names.length !== 1 || names[0]?.[1] !== review.skill) throw new Error(`Invalid installed review skill: ${review.skill}.`)
  const directory = path.join(skillsRoot, review.skill)
  await freeze(source, directory, signal, budget)
  const references = new Map<string, string>()
  if (review.kind === "two-axis") {
    const frozen = (await bytes(path.join(directory, "SKILL.md"), guard)).toString("utf8")
    if (frozen !== content) throw new Error("Installed review skill changed during staging.")
    references.set("code-review/SKILL.md", frozen)
  }
  if (review.kind === "fleet") {
    for (const name of ["report-template.md", "review-schema.md"]) {
      references.set(name, (await bytes(path.join(directory, "references", name), guard)).toString("utf8"))
    }
  }
  return { directory, references }
}

const stageReviews = async (
  reviews: ReadonlyArray<ReviewDefinition>,
  bundle: string,
  skillsRoot: string,
  signal: AbortSignal,
  budget: FreezeBudget,
  skills: Map<string, string>,
  references: Map<string, string>,
  allowMissing: boolean,
): Promise<ReviewDefinition[]> => {
  const missing: ReviewDefinition[] = []
  for (const review of reviews) {
    if (!/^[a-z][a-z0-9-]*$/u.test(review.skill)) throw new Error("Invalid review skill name.")
    const source = path.join(bundle, review.skill)
    check(signal, budget, source)
    const status = await lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    check(signal, budget, source)
    if (!status && allowMissing) {
      missing.push(review)
      continue
    }
    const staged = await stageSkill(review, bundle, skillsRoot, signal, budget)
    skills.set(review.id, staged.directory)
    for (const [name, content] of staged.references) references.set(name, content)
  }
  return missing
}

export const prepareReviewWorkspace = async (
  options: ReviewSkillOptions,
  reviews: ReadonlyArray<ReviewDefinition>,
  repository: string,
  signal: AbortSignal,
): Promise<ReviewWorkspace> => {
  const parent = await stageRoot(options, repository)
  const root = path.join(parent, `.trx-review-${randomUUID()}`)
  await mkdir(root, { mode: 0o700 })
  try {
    if (signal.aborted) throw signal.reason
    const bundle = path.join(root, "bundle")
    const manage = async (command: "ensure" | "update"): Promise<void> => {
      await options.runner.run(bunExecutable(), bunArguments(options.managerPath, [
        command, "--bundle", "native-common", "--catalog", options.catalogPath,
        "--cache", options.cachePath, ...(command === "ensure" ? ["--target", bundle] : []),
      ]), {
        cwd: root, signal, timeoutMs: 180_000,
        env: sourceEnvironment({ ...process.env, TMPDIR: root, TEMP: root, TMP: root, NODE_DISABLE_COMPILE_CACHE: "1" }),
      })
    }
    await manage("ensure")
    const skillsRoot = path.join(root, "skills")
    await mkdir(skillsRoot, { mode: 0o700 })
    const skills = new Map<string, string>()
    const references = new Map<string, string>()
    let budget = { remaining: 4 * 1024 * 1024, entries: 0, deadline: performance.now() + 30_000 }
    const missing = await stageReviews(reviews, bundle, skillsRoot, signal, budget, skills, references, true)
    if (missing.length > 0) {
      await manage("update")
      await dispose(bundle)
      signal.throwIfAborted()
      await manage("ensure")
      await dispose(skillsRoot)
      await mkdir(skillsRoot, { mode: 0o700 })
      skills.clear()
      references.clear()
      budget = { remaining: 4 * 1024 * 1024, entries: 0, deadline: performance.now() + 30_000 }
      await stageReviews(reviews, bundle, skillsRoot, signal, budget, skills, references, false)
    }
    await dispose(bundle)
    signal.throwIfAborted()
    const work = path.join(root, "work")
    const runtime = path.join(root, "runtime")
    await mkdir(work, { mode: 0o700 })
    await mkdir(runtime, { mode: 0o700 })
    signal.throwIfAborted()
    return { root, work, runtime, skills, references, dispose: () => dispose(root) }
  } catch (error) {
    if (error instanceof CleanupError) {
      throw new Error(`Review preparation failed; retained owned path ${root}: ${error.message}`, { cause: error })
    }
    try {
      await dispose(root)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError],
        `Review skills unavailable or unsafe: ${String(error)}; ${String(cleanupError)}`)
    }
    throw new Error(`Review skills unavailable or unsafe: ${error instanceof Error ? error.message : String(error)}. Run \`trx skills update\` if needed.`, { cause: error })
  }
}
