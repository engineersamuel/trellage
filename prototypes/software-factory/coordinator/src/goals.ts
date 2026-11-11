// Goal specs and their run logs on disk: <dir>/<id>.json and <dir>/<id>.runs.jsonl (append only).
// The default dir is docs/goals/factory of the checkout the coordinator runs from, so specs are versioned.
import { Exit } from "effect"
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { decodeGoal, decodeGoalRun, goalProblems, type GoalRun, type GoalSpec, type Grade } from "../../shared/goal.ts"

export const goalsDir = (env = process.env): string =>
  env.SF_GOALS_DIR ?? path.resolve(new URL(".", import.meta.url).pathname, "../../../../docs/goals/factory")

export class GoalError extends Error {}

const errorText = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? String(exit.cause) : "Success")

export const decodeGoalOrThrow = (u: unknown, knownSteps?: readonly string[]): GoalSpec => {
  const exit = decodeGoal(u)
  if (!Exit.isSuccess(exit)) throw new GoalError(`invalid goal: ${errorText(exit)}`)
  const problems = goalProblems(exit.value, knownSteps)
  if (problems.length) throw new GoalError(`invalid goal: ${problems.join("; ")}`)
  return exit.value
}

/** `runs` and `last` count runner lines only, so grade lines do not use up the loop's run budget. */
const summarize = (
  spec: GoalSpec,
  all: GoalRun[],
): { spec: GoalSpec; runs: number; last: GoalRun | null; grades: Grade[] } => {
  const runnerLines = all.filter((x) => !x.grade)
  return {
    spec,
    runs: runnerLines.length,
    last: runnerLines.at(-1) ?? null,
    grades: all.flatMap((x) => (x.grade ? [x.grade] : [])),
  }
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
        if (Exit.isSuccess(exit)) return [exit.value]
        console.warn(`goal ${id}: dropped a run line that does not decode: ${l.slice(0, 200)}`)
        return []
      })
  }
  const decodeLine = (id: string, u: unknown): GoalRun => {
    if (!get(id)) throw new GoalError(`no goal ${id}`)
    return decodeRun(u)
  }
  const decodeRun = (u: unknown): GoalRun => {
    const exit = decodeGoalRun(u)
    if (!Exit.isSuccess(exit)) throw new GoalError(`invalid run: ${errorText(exit)}`)
    return exit.value
  }
  const write = (id: string, line: GoalRun): GoalRun => {
    const target = file(id, ".runs.jsonl")
    mkdirSync(dir, { recursive: true })
    appendFileSync(target, `${JSON.stringify(line)}\n`)
    return line
  }
  const get = (id: string): GoalSpec | null => {
    const f = file(id, ".json")
    return existsSync(f) ? decodeGoalOrThrow(JSON.parse(readFileSync(f, "utf8"))) : null
  }
  return {
    dir,
    list: (): ReturnType<typeof summarize>[] =>
      existsSync(dir)
        ? readdirSync(dir)
            .filter((n) => n.endsWith(".json"))
            .sort()
            .flatMap((n) => {
              try {
                const spec = get(n.slice(0, -5))
                if (!spec) return []
                return [summarize(spec, runs(spec.id))]
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
    appendRun: (id: string, u: unknown): GoalRun => write(id, decodeLine(id, u)),
    /** Append a grade line; null (nothing written) when a line with the same grade key exists, so a replay adds nothing. */
    appendGrade: (id: string, u: unknown): GoalRun | null => {
      const line = decodeRun(u)
      const key = line.grade?.key
      if (!key) throw new GoalError("a grade line needs a grade")
      return runs(id).some((r) => r.grade?.key === key) ? null : write(id, line)
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
