// SDLC step catalog. Jev picks the next step from these descriptions; code holds the hard rules.
import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import path from "node:path"
import { parseEnv } from "node:util"
import { choice, noul } from "@typesafe-ai/sdk"
import { decisionsAvailable, systemOne } from "./decide.ts"
import { guideOptimizeSkills } from "../../../../packages/trellage-launcher/src/guide-optimize-catalog.ts"
import { loadPrompt } from "./prompt.ts"
import { factoryConfig, type FactoryConfig } from "./config.ts"

export type Step = {
  id: string
  description: string
  bestFor: string[]
  avoidFor: string[]
  /** Skills loaded into the worker for this step (names under the skills directory). */
  skills: string[]
  /** Skill directories relative to the skills directory, for skills nested inside their repo. Replaces the whole skills directory, so no other skill loads. */
  skillDirs?: string[]
  /** Extra rules added after the skill sentence, for example where to stop in the skill. */
  instructions?: string
  /** The quality-gate tools go on PATH. Default true when the step loads skills. */
  gateTools?: boolean
  /** Started by the factory itself; Jev and spawn_worker never pick it. */
  factoryOnly?: boolean
  /** Run in the Claude Agent SDK or Pi SDK with these trx profiles, for skills and plugins built for that harness. Default: Copilot SDK. */
  harness?: HarnessSpec
}

/** A non-Copilot harness: trx profiles composed for it, and an optional command that starts the profile's workflow. */
export type HarnessSpec = { kind: "claude" | "pi"; profiles: string[]; entry?: string }

/** The debug worker finds the cause; the coordinator decides what happens next (research, implement, or nothing). */
export const DEBUG_ONLY = (): string => stepById("debug").instructions ?? ""

/** Steps from [steps.<id>] in the factory config. */
const configSteps = (c: FactoryConfig): Step[] =>
  Object.entries(c.steps).map(([id, x]) => ({
    id,
    description: x.description,
    bestFor: [...x.best_for],
    avoidFor: [...x.avoid_for],
    skills: [...x.skills],
    ...(x.skill_dirs ? { skillDirs: [...x.skill_dirs] } : {}),
    ...(x.instructions ? { instructions: x.instructions } : {}),
    ...(x.gate_tools !== undefined ? { gateTools: x.gate_tools } : {}),
    ...(x.factory_only ? { factoryOnly: true } : {}),
    ...(x.harness
      ? {
          harness: {
            kind: x.harness.kind,
            profiles: [...x.harness.profiles],
            ...(x.harness.entry ? { entry: x.harness.entry } : {}),
          },
        }
      : {}),
  }))

/** Skill directories (under the skills directory) for the GitHub repos Optimize skills come from. */
const OPTIMIZE_SKILL_DIRS: Record<string, string> = { "mattpocock/skills": "mattpocock-skills/skills/engineering" }

export const optimizeStepId = (skillId: string) => `optimize-${skillId}`

/** One read-only step per `trx guide --optimize` skill; fanout starts them. */
const OPTIMIZE_STEPS: Step[] = guideOptimizeSkills.map((skill) => {
  const refs = (skill.harnessSkills ?? []).map((r) => r.split(":") as [string, string])
  return {
    id: optimizeStepId(skill.id),
    description: `Optimize lens "${skill.title}": ${skill.description} Read-only; writes a ranked report.`,
    bestFor: ["Finding and ranking optimizations in a repository"],
    avoidFor: ["Manual selection"],
    skills: refs.map(([, name]) => name),
    ...(refs.length ? { skillDirs: [...new Set(refs.map(([repo]) => OPTIMIZE_SKILL_DIRS[repo]!))] } : {}),
    gateTools: false,
    factoryOnly: true,
  }
})

/** Every step: the config's, then the Optimize steps. Read at use time, so config edits apply. */
export const steps = (c: FactoryConfig = factoryConfig()): Step[] => [...configSteps(c), ...OPTIMIZE_STEPS]

/** Steps the coordinator and Jev may choose. */
export const selectableSteps = (c: FactoryConfig = factoryConfig()): Step[] => steps(c).filter((s) => !s.factoryOnly)

/** A repo URL, or a URL with the only folders to check out (a sparse clone, for large repos). */
export type Repo = string | { url: string; sparse: string[] }

/** Skills and quality-gate tools the factory fetches once into its state directory. */
export const SKILL_REPOS: Record<string, Repo> = {
  "ub-mode": "https://github.com/unclebob/ub-mode.git",
  "security-audit-skill": "https://github.com/cloudflare/security-audit-skill.git",
  "mattpocock-skills": "https://github.com/mattpocock/skills.git",
  "prompt-master": "https://github.com/nidhinjs/prompt-master.git",
  "hve-core": "https://github.com/microsoft/hve-core.git",
  "claude-code-templates": {
    url: "https://github.com/davila7/claude-code-templates.git",
    sparse: ["cli-tool/components/skills/development/systematic-debugging"],
  },
}
export const TOOL_REPOS: Record<string, string> = {
  crapper: "https://github.com/unclebob/crapper.git",
  dryer: "https://github.com/unclebob/dryer.git",
  mutator: "https://github.com/unclebob/mutator.git",
}

/** Clone missing repos into `dir/<name>`. Idempotent: existing clones stay as they are. */
export const ensureClones = (dir: string, repos: Record<string, Repo>): void => {
  mkdirSync(dir, { recursive: true })
  for (const [name, repo] of Object.entries(repos)) {
    const dest = path.join(dir, name)
    if (existsSync(path.join(dest, ".git"))) continue
    const { url, sparse } = typeof repo === "string" ? { url: repo, sparse: null } : repo
    const git = (args: string[]) => execFileSync("git", args, { stdio: ["ignore", "ignore", "pipe"] })
    try {
      git(["clone", "-q", "--depth", "1", ...(sparse ? ["--filter=blob:none", "--sparse"] : []), url, dest])
      if (sparse) git(["-C", dest, "sparse-checkout", "set", ...sparse])
    } catch (e) {
      // A half-made clone would be skipped next time as if it were complete.
      rmSync(dest, { recursive: true, force: true })
      const why = String((e as { stderr?: Buffer }).stderr ?? "").trim() || (e as Error).message
      throw new Error(`clone ${name} failed: ${why}`, { cause: e })
    }
  }
}

export type StepSetup = { skillDirectories: string[]; extraPath: string[]; prefix: string }

/** What a worker on this step loads: skill directories, PATH additions, and the task's prefix. */
export const stepSetup = (step: Step | null, skillRoot: string, toolRoot: string): StepSetup => {
  if (!step?.skills.length) return { skillDirectories: [], extraPath: [], prefix: "" }
  const gate = step.gateTools ?? true
  const tools = Object.keys(TOOL_REPOS)
  return {
    skillDirectories: step.skillDirs ? step.skillDirs.map((d) => path.join(skillRoot, d)) : [skillRoot],
    extraPath: gate ? tools.map((t) => path.join(toolRoot, t)) : [],
    prefix: [
      ...step.skills.map((k) => `Use the ${k} skill.`),
      ...(step.instructions ? [step.instructions] : []),
      ...(gate ? [`The quality-gate tools ${tools.join(", ")} are on PATH.`] : []),
    ].join(" "),
  }
}

/** One skill a step names, resolved to its folder. `problem` says why a worker cannot use it. */
export type SkillCheck = { name: string; dir: string | null; healed: boolean; problem: string | null }

/** Why a model-invoked worker cannot use the skill in `dir`, or null. */
export const skillProblem = (dir: string | null): string | null => {
  const file = dir && path.join(dir, "SKILL.md")
  if (!file || !existsSync(file)) return "SKILL.md not found"
  const front = readFileSync(file, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]
  if (!front) return "SKILL.md has no frontmatter"
  if (!/^name:\s*\S/m.test(front) || !/^description:\s*\S/m.test(front)) return "frontmatter lacks name or description"
  if (/^disable-model-invocation:\s*true\s*$/m.test(front))
    return "model invocation is disabled (disable-model-invocation: true), so the runtime hides it from the worker"
  return null
}

/** Resolve each skill the step names. A healed copy in `healRoot/<name>` wins over the source folders. */
export const checkStepSkills = (sourceDirs: string[], healRoot: string, step: Step): SkillCheck[] =>
  step.skills.map((name) => {
    const healed = path.join(healRoot, name)
    if (existsSync(path.join(healed, "SKILL.md")))
      return { name, dir: healed, healed: true, problem: skillProblem(healed) }
    const dir = sourceDirs.map((d) => path.join(d, name)).find((d) => existsSync(path.join(d, "SKILL.md"))) ?? null
    return { name, dir, healed: false, problem: skillProblem(dir) }
  })

/** Thrown before a worker starts when a skill its step names is missing or unusable. */
export class SkillPreflightError extends Error {
  constructor(
    readonly step: string,
    readonly failures: SkillCheck[],
  ) {
    super(
      `step ${step}: ${failures.map((f) => `skill ${f.name}: ${f.problem}${f.dir ? ` (${f.dir})` : ""}`).join("; ")}`,
    )
  }
}

/** Fail fast on an unusable skill; else link exactly the step's skills into `stepDir` and return it. */
export const prepareStepSkills = (
  sourceDirs: string[],
  healRoot: string,
  stepDir: string,
  step: Step,
): SkillCheck[] => {
  const checks = checkStepSkills(sourceDirs, healRoot, step)
  const bad = checks.filter((c) => c.problem)
  if (bad.length) throw new SkillPreflightError(step.id, bad)
  rmSync(stepDir, { recursive: true, force: true })
  mkdirSync(stepDir, { recursive: true })
  for (const c of checks) symlinkSync(c.dir!, path.join(stepDir, c.name))
  return checks
}

export const stepById = (id: string, c: FactoryConfig = factoryConfig()): Step => {
  const all = steps(c)
  const s = all.find((x) => x.id === id)
  if (!s) throw new Error(`unknown step '${id}'; one of ${all.map((x) => x.id).join(", ")}`)
  return s
}

/** TypeSafe key: process env, then the private Trellage user environment file. */
export const jevKey = (env = process.env): string | undefined => {
  if (env.TYPESAFE_API_KEY?.trim()) return env.TYPESAFE_API_KEY.trim()
  const dir = env.XDG_CONFIG_HOME
    ? path.join(env.XDG_CONFIG_HOME, "trellage")
    : path.join(env.HOME ?? "", ".config", "trellage")
  for (const name of [".env.local", ".env"]) {
    const file = path.join(dir, name)
    try {
      const st = lstatSync(file)
      if (!st.isFile() || (st.mode & 0o077) !== 0) continue
      const v = parseEnv(readFileSync(file, "utf8")).TYPESAFE_API_KEY?.trim()
      if (v) return v
    } catch {}
  }
  return undefined
}

export type Decision = {
  moreWork: number
  step: string
  confidence: number
  probabilities: Record<string, number>
}

/** Ask Jev, per worker, whether its latest activity is on track for its task. Returns probability per worker id. */
export const onTrack = async (
  items: { id: string; task: string; latest: string }[],
): Promise<Record<string, number>> => {
  if (!decisionsAvailable() || items.length === 0) return {}
  const res = await systemOne({
    state: JSON.stringify(
      items.map(({ id, task, latest }) => ({ id, task: task.slice(0, 2000), latest: latest.slice(0, 2000) })),
    ),
    questions: Object.fromEntries(
      items.map((x) => [x.id.replace(/\W/g, "_"), noul(loadPrompt("jev/progress", { worker: x.id }))]),
    ),
  })
  return Object.fromEntries(items.map((x) => [x.id, res.answers[x.id.replace(/\W/g, "_")]?.noul ?? 1]))
}

/** Ask Jev whether more work is useful and which step comes next. */
export const decideNext = async (state: {
  request: string
  progress: string
  lastOutput: string
}): Promise<Decision> => {
  const criteria = Object.fromEntries(
    selectableSteps().map((s) => [
      s.id,
      `${s.description} Best for: ${s.bestFor.join("; ")}. Avoid for: ${s.avoidFor.join("; ")}.`,
    ]),
  )
  const res = await systemOne({
    state: JSON.stringify(state),
    questions: {
      more: noul(loadPrompt("jev/more-work")),
      next: choice(loadPrompt("jev/next-step"), criteria),
    },
  })
  const a = res.answers
  if (typeof a.more?.noul !== "number" || typeof a.next?.choice !== "string")
    throw new Error("next step not decided: the decision engine gave no answer")
  return {
    moreWork: a.more.noul,
    step: a.next.choice,
    confidence: a.next.confidence,
    probabilities: a.next.probabilities,
  }
}
