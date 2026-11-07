// Goal specs and their run logs on disk: <dir>/<id>.json and <dir>/<id>.runs.jsonl (append only).
// The default dir is docs/goals/factory of the checkout the coordinator runs from, so specs are versioned.
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { decodeGoal, decodeGoalRun, goalProblems, type GoalRun, type GoalSpec } from "../../shared/goal.ts"

export const goalsDir = (env = process.env): string =>
  env.SF_GOALS_DIR ?? path.resolve(new URL(".", import.meta.url).pathname, "../../../../docs/goals/factory")

export class GoalError extends Error {}

const errorText = (exit: { _tag: string; cause?: unknown }) => String((exit as any).cause?.toString?.() ?? exit._tag)

export const decodeGoalOrThrow = (u: unknown, knownSteps?: readonly string[]): GoalSpec => {
  const exit = decodeGoal(u)
  if (exit._tag !== "Success") throw new GoalError(`invalid goal: ${errorText(exit)}`)
  const problems = goalProblems(exit.value, knownSteps)
  if (problems.length) throw new GoalError(`invalid goal: ${problems.join("; ")}`)
  return exit.value
}

export const makeGoals = (dir: string, knownSteps: readonly string[]) => {
  const file = (id: string, ext: string) => {
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id)) throw new GoalError(`bad goal id ${JSON.stringify(id)}`)
    return path.join(dir, `${id}${ext}`)
  }
  const runs = (id: string): GoalRun[] => {
    const f = file(id, ".runs.jsonl")
    if (!existsSync(f)) return []
    return readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        const exit = decodeGoalRun(JSON.parse(l))
        return exit._tag === "Success" ? [exit.value] : []
      })
  }
  const get = (id: string): GoalSpec | null => {
    const f = file(id, ".json")
    return existsSync(f) ? decodeGoalOrThrow(JSON.parse(readFileSync(f, "utf8"))) : null
  }
  return {
    dir,
    list: (): { spec: GoalSpec; runs: number; last: GoalRun | null }[] =>
      existsSync(dir)
        ? readdirSync(dir)
            .filter((n) => n.endsWith(".json"))
            .sort()
            .flatMap((n) => {
              try {
                const spec = get(n.slice(0, -5))
                if (!spec) return []
                const r = runs(spec.id)
                return [{ spec, runs: r.length, last: r.at(-1) ?? null }]
              } catch {
                return []
              }
            })
        : [],
    get,
    runs,
    /** Validate and write the spec (pretty JSON, so diffs read well). */
    save: (u: unknown): GoalSpec => {
      const spec = decodeGoalOrThrow(u, knownSteps)
      mkdirSync(dir, { recursive: true })
      writeFileSync(file(spec.id, ".json"), `${JSON.stringify(spec, null, 2)}\n`)
      return spec
    },
    appendRun: (id: string, u: unknown): GoalRun => {
      if (!get(id)) throw new GoalError(`no goal ${id}`)
      const exit = decodeGoalRun(u)
      if (exit._tag !== "Success") throw new GoalError(`invalid run: ${errorText(exit)}`)
      appendFileSync(file(id, ".runs.jsonl"), `${JSON.stringify(exit.value)}\n`)
      return exit.value
    },
  }
}
export type Goals = ReturnType<typeof makeGoals>

/**
 * The whole loop as one paste for an agent without the factory-loop skill: the skill's instructions
 * (frontmatter dropped), then the goal id and spec.
 */
export const loopPrompt = (skill: string, spec: GoalSpec): string =>
  `${skill.replace(/^---\n[\s\S]*?\n---\n/, "").trim()}\n\n## This goal\n\nGoal id: \`${spec.id}\` (saved spec; read it with \`sf goal show ${spec.id}\`).\n\n\`\`\`json\n${JSON.stringify(spec, null, 2)}\n\`\`\`\n\nBegin.\n`

/** HEAD of the checkout `dir` is in, with "+dirty" when `dir` itself has uncommitted changes; "unknown" outside git. */
export const checkoutCommit = (dir: string): string => {
  try {
    const head = execFileSync("git", ["-C", dir, "rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim()
    const dirty = execFileSync("git", ["-C", dir, "status", "--porcelain", "--", "."], { encoding: "utf8" }).trim()
    return dirty ? `${head}+dirty` : head
  } catch {
    return "unknown"
  }
}
