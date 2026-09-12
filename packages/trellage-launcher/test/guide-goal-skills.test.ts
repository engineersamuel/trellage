import { randomUUID } from "node:crypto"
import { cp, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { bunExecutable, sourceWorkspaceRoot } from "@trellage/runtime"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GuideGoalCancelledError } from "../src/guide-goal-augment.ts"
import {
  createGuideGoalSkillResolver,
  type GuideGoalSkills,
  type GuideGoalSkillResolverOptions,
} from "../src/guide-goal-skills.ts"
import type { CommandRunOptions } from "../src/guide-launch.ts"
import { goalMeSkill } from "./fixtures/goal-me-skill.ts"

const result = { exitCode: 0 as const, stdout: "", stderr: "" }
const grillSkill = "---\nname: grill-me\n---\nAsk frontier questions.\n"

let root: string
let options: GuideGoalSkillResolverOptions
let ownedSkills: GuideGoalSkills[]

const flag = (args: ReadonlyArray<string>, name: string): string => {
  const value = args[args.indexOf(name) + 1]
  if (value === undefined) throw new Error(`Missing ${name}`)
  return value
}

const putSkill = async (name: string, content: string): Promise<string> => {
  const directory = path.join(options.cachePath, "skills", name)
  await mkdir(directory, { recursive: true })
  await writeFile(path.join(directory, "SKILL.md"), content)
  return directory
}

const stage = async (): Promise<GuideGoalSkills> => {
  const skills = await createGuideGoalSkillResolver(options)(new AbortController().signal)
  ownedSkills.push(skills)
  return skills
}

const remainingStages = async (): Promise<string[]> =>
  (await readdir(root)).filter((entry) => entry.startsWith(".trx-guide-goal-"))

beforeEach(async () => {
  root = path.resolve(`.guide-goal-skills-test-${randomUUID()}`)
  await mkdir(root, { mode: 0o700 })
  const managerPath = path.join(root, "floating-skills.ts")
  const catalogPath = path.join(root, "skills.json")
  const cachePath = path.join(root, "native-cache")
  await writeFile(managerPath, "// Fake manager. Tests use the injected runner.\n")
  await writeFile(catalogPath, "{}\n")
  const runner = {
    run: vi.fn(async (_executable: string, args: ReadonlyArray<string>, _runOptions?: CommandRunOptions) => {
      await cp(path.join(cachePath, "skills"), flag(args, "--target"), { recursive: true })
      return result
    }),
  }
  options = { managerPath, catalogPath, cachePath, runner }
  ownedSkills = []
  await putSkill("goal-me", goalMeSkill)
})

afterEach(async () => {
  await Promise.allSettled(ownedSkills.map((skills) => skills.dispose()))
  await rm(root, { recursive: true, force: true })
})

describe("Goal me installed skill resolver", () => {
  it("is lazy and uses native-common ensure with explicit runtime paths and an owned target", async () => {
    const resolver = createGuideGoalSkillResolver(options)
    expect(options.runner.run).not.toHaveBeenCalled()
    const signal = new AbortController().signal
    const skills = await resolver(signal)
    ownedSkills.push(skills)
    const stageRoot = path.dirname(skills.workingDirectory)

    expect(options.runner.run).toHaveBeenCalledExactlyOnceWith(
      bunExecutable(),
      [
        "--no-install", "--no-env-file",
        `--config=${path.join(sourceWorkspaceRoot(), "packages/trellage-runtime/bunfig.toml")}`,
        options.managerPath, "--", "ensure",
        "--bundle", "native-common",
        "--catalog", options.catalogPath,
        "--cache", options.cachePath,
        "--target", path.join(stageRoot, "bundle"),
      ],
      expect.objectContaining({
        signal, cwd: stageRoot, timeoutMs: 180_000,
        env: expect.objectContaining({ BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", TMPDIR: stageRoot }),
      }),
    )
    expect(path.dirname(stageRoot)).toBe(path.dirname(options.cachePath))
    expect((await lstat(stageRoot)).mode & 0o777).toBe(0o700)
    expect(await readdir(skills.workingDirectory)).toEqual([])
    expect(await readdir(skills.baseDirectory)).toEqual([])
    await expect(lstat(path.join(stageRoot, "bundle"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("freezes only goal-me and optional grill-me, including their local resources", async () => {
    const originalGoal = path.join(options.cachePath, "skills", "goal-me")
    await mkdir(path.join(originalGoal, "references"))
    await writeFile(path.join(originalGoal, "references", "notes.txt"), "original reference")
    await putSkill("grill-me", grillSkill)
    await putSkill("unrelated-skill", "---\nname: unrelated-skill\n---\nNever load this.\n")

    const skills = await stage()
    const goalDirectory = skills.skillDirectories[0]!
    expect(skills.skillDirectories.map((directory) => path.basename(directory))).toEqual(["goal-me", "grill-me"])
    expect(await readdir(path.dirname(goalDirectory))).toEqual(["goal-me", "grill-me"])
    expect(skills.goalMeContent).toBe(goalMeSkill)
    expect((await lstat(path.join(goalDirectory, "SKILL.md"))).mode & 0o222).toBe(0)
    expect((await lstat(goalDirectory)).mode & 0o222).toBe(0)

    await writeFile(path.join(originalGoal, "SKILL.md"), "cache was updated during the interview")
    await writeFile(path.join(originalGoal, "references", "notes.txt"), "updated reference")
    expect(await readFile(path.join(goalDirectory, "SKILL.md"), "utf8")).toBe(goalMeSkill)
    expect(await readFile(path.join(goalDirectory, "references", "notes.txt"), "utf8")).toBe("original reference")

    await skills.dispose()
    await skills.dispose()
    expect(await remainingStages()).toEqual([])
    expect(await readFile(path.join(originalGoal, "SKILL.md"), "utf8")).toBe("cache was updated during the interview")
  })

  it("permits the installed goal-me frontier fallback when grill-me is absent", async () => {
    const skills = await stage()
    expect(skills.skillDirectories.map((directory) => path.basename(directory))).toEqual(["goal-me"])
    expect(skills.goalMeContent).toBe(goalMeSkill)
  })

  it("uses a new snapshot on an explicit later run without changing cache refresh policy", async () => {
    const first = await stage()
    await putSkill("goal-me", goalMeSkill.replace("Begin.", "Begin.\nUpdated template."))
    const second = await stage()
    expect(first.goalMeContent).toBe(goalMeSkill)
    expect(second.goalMeContent).toContain("Updated template.")
    expect(first.skillDirectories).not.toEqual(second.skillDirectories)
    expect(options.runner.run).toHaveBeenCalledTimes(2)
  })

  const invalidate = {
    "missing goal-me": async () => rm(path.join(options.cachePath, "skills", "goal-me"), { recursive: true }),
    "missing SKILL.md": async () => rm(path.join(options.cachePath, "skills", "goal-me", "SKILL.md")),
    "wrong skill name": async () => putSkill("goal-me", "---\nname: some-other-skill\n---\n"),
    "duplicate skill name": async () => putSkill("goal-me", "---\nname: goal-me\nname: goal-me\n---\n"),
    "symlinked skill directory": async () => {
      const target = await putSkill("other", goalMeSkill)
      const goal = path.join(options.cachePath, "skills", "goal-me")
      await rm(goal, { recursive: true })
      await symlink(target, goal)
    },
    "symlinked SKILL.md": async () => {
      const file = path.join(options.cachePath, "skills", "goal-me", "SKILL.md")
      await rm(file)
      await symlink(options.catalogPath, file)
    },
    "symlinked resource": async () => {
      await symlink(options.catalogPath, path.join(options.cachePath, "skills", "goal-me", "external.txt"))
    },
    "invalid optional grill-me": async () => putSkill("grill-me", "---\nname: unexpected\n---\n"),
  }

  it.each(Object.entries(invalidate))("fails closed for %s and removes partially frozen staging", async (_name, corrupt) => {
    await corrupt()
    await expect(stage()).rejects.toThrow("trx skills update")
    expect(await remainingStages()).toEqual([])
  })

  it.each(["managerPath", "catalogPath"] as const)("rejects an unsafe %s before running the manager", async (key) => {
    const unsafe = path.join(root, `unsafe-${key}`)
    await symlink(options[key], unsafe)
    const resolver = createGuideGoalSkillResolver({ ...options, [key]: unsafe })
    await expect(resolver(new AbortController().signal)).rejects.toThrow("trx skills update")
    expect(options.runner.run).not.toHaveBeenCalled()
    expect(await remainingStages()).toEqual([])
  })

  it("does not infer missing runtime paths from cwd", async () => {
    const resolver = createGuideGoalSkillResolver({ ...options, managerPath: "scripts/floating-skills.ts" })
    await expect(resolver(new AbortController().signal)).rejects.toThrow("must be absolute")
    expect(options.runner.run).not.toHaveBeenCalled()
  })

  it("rejects manager failure without removing the shared cache", async () => {
    const failure = new Error("ensure failed")
    options = { ...options, runner: { run: vi.fn(async () => { throw failure }) } }
    await expect(stage()).rejects.toMatchObject({ cause: failure })
    expect(await remainingStages()).toEqual([])
    expect(await readFile(path.join(options.cachePath, "skills", "goal-me", "SKILL.md"), "utf8")).toBe(goalMeSkill)
  })

  it("does no setup after cancellation", async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(createGuideGoalSkillResolver(options)(abort.signal)).rejects.toBeInstanceOf(GuideGoalCancelledError)
    expect(options.runner.run).not.toHaveBeenCalled()
    expect(await remainingStages()).toEqual([])
  })

  it("cancels an active ensure command through its real CommandRunner signal and removes staging", async () => {
    let started!: () => void
    const ready = new Promise<void>((resolve) => { started = resolve })
    options = {
      ...options,
      runner: {
        run: async (_executable, _args, runOptions) => new Promise((_resolve, reject) => {
          runOptions?.signal?.addEventListener("abort", () => reject(new Error("manager aborted")), { once: true })
          started()
        }),
      },
    }
    const abort = new AbortController()
    const loading = createGuideGoalSkillResolver(options)(abort.signal)
    const rejected = expect(loading).rejects.toBeInstanceOf(GuideGoalCancelledError)
    await ready
    abort.abort()
    await rejected
    expect(await remainingStages()).toEqual([])
  })
})
