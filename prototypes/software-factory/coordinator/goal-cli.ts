// `sf goal ...`: create, list, run and score factory goal specs (shared/goal.ts).
//   sf goal list                       every spec with its run count and last outcome
//   sf goal show ID                    the spec
//   sf goal new                        guided questions in the terminal; saves the spec
//   sf goal save FILE.json             validate and save a spec from a file
//   sf goal run ID [--thread T]        start a run (or watch thread T), answer decisions the policy allows,
//                                      score it, append the result to the run log.
//                                      Exit 0 pass, 1 fail or timeout, 2 a decision waits for the human, 3 blocked
//   sf goal check ID THREAD            score one thread once, no waiting, no log
//   sf goal history ID                 the run log: factory commit per run, so fixes show as commit changes
import { Console, Duration, Effect } from "effect"
import { createInterface } from "node:readline/promises"
import { readFileSync } from "node:fs"
import { APPROVAL_TOPICS, goalUnmet, splitPending, stopReason, type GoalRun, type GoalSpec, type Run } from "../shared/goal.ts"

type Json = (path: string, init?: RequestInit) => Effect.Effect<any, Error>
type Ask = (prompt: string, folderId: string, base: string) => Effect.Effect<string, Error>

const POLL = Duration.seconds(15)
const enc = encodeURIComponent

/** One line per run: when, factory commit, outcome, thread, PR, unmet count. */
const runLine = (r: GoalRun) =>
  `${new Date(r.at).toISOString().slice(0, 16)}  ${r.factoryCommit.padEnd(18)} ${r.outcome.padEnd(8)} ${r.threadId.slice(0, 8)}  ${r.prUrl ?? "-"}${r.unmet.length ? `  unmet ${r.unmet.length}` : ""}`

/** A short score card of a run: each expected step with its count, skills, PR. */
export const scoreCard = (run: Run, spec: GoalSpec, unmet: string[]): string => {
  const lines = [`thread ${run.threadId}  status ${run.status}`]
  for (const [step, c] of Object.entries(spec.expect.steps)) {
    const n = run.workers.filter((w) => w.step === step).length
    const ok = n >= c.min && (c.max === undefined || n <= c.max)
    lines.push(`${ok ? "✓" : "✗"} step ${step}: ${n} (want ${c.min}${c.max !== undefined ? `..${c.max}` : "+"})`)
  }
  const loaded = new Set(run.workers.flatMap((w) => w.skills))
  for (const s of spec.expect.skills) lines.push(`${loaded.has(s) ? "✓" : "✗"} skill ${s}`)
  if (spec.expect.sdlc) {
    const s = run.sdlc
    if (!s) lines.push("✗ no SDLC record")
    else {
      lines.push(`${s.unproven.length ? "✗" : "✓"} criteria ${s.criteria.length - s.unproven.length}/${s.criteria.length} proven · tier ${s.tier ?? "?"}`)
      for (const g of s.gates) lines.push(`  ${g.chosen ? "●" : "○"} ${g.id} ${g.chosen ? g.status : "skipped"} (${g.reason})`)
      for (const r of s.codeReviews) lines.push(`  review ${r.id} ${r.status} lenses ${r.lenses.join(",")} kept ${r.kept} dropped ${r.dropped}`)
      lines.push(`  metrics: ${s.metrics.minutes} min, ${s.metrics.workers} workers, findings kept ${s.metrics.findingsKept} dropped ${s.metrics.findingsDropped}`)
    }
  }
  if (spec.expect.pr) lines.push(run.pr ? `${unmet.some((u) => u.startsWith("PR") || u.startsWith("no PR")) ? "✗" : "✓"} PR ${run.pr.url} ${run.pr.state} checks ${run.pr.checks}` : "✗ no PR")
  const other = run.workers.filter((w) => w.step && !(w.step in spec.expect.steps)).map((w) => w.step)
  if (other.length) lines.push(`  also ran: ${[...new Set(other)].join(", ")}`)
  if (unmet.length) lines.push("unmet:", ...unmet.map((u) => `  - ${u}`))
  return lines.join("\n")
}

const question = async (rl: ReturnType<typeof createInterface>, q: string, dflt = ""): Promise<string> =>
  (await rl.question(dflt ? `${q} [${dflt}]: ` : `${q}: `)).trim() || dflt

/** `implement,review,finish=1,verify=1..2` → {implement:{min:1}, finish:{min:1,max:1}, verify:{min:1,max:2}}. */
export const parseSteps = (s: string): Record<string, { min: number; max?: number }> =>
  Object.fromEntries(
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const [id, n] = x.split("=")
        if (!n) return [id!, { min: 1 }]
        const [lo, hi] = n.split("..")
        return [id!, hi === undefined ? { min: Number(lo), max: Number(lo) } : { min: Number(lo), ...(hi ? { max: Number(hi) } : {}) }]
      }),
  )

const list = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean)

const guided = (json: Json) =>
  Effect.gen(function* () {
    const steps: { id: string; skills: string[] }[] = (yield* json("/api/steps")).steps
    const answers = yield* Effect.tryPromise({
      try: async () => {
        const rl = createInterface({ input: process.stdin, output: process.stderr })
        try {
          console.error(`steps: ${steps.map((s) => s.id).join(", ")}`)
          console.error(`skills: ${[...new Set(steps.flatMap((s) => s.skills))].join(", ")}`)
          const id = await question(rl, "id (slug)")
          const repo = await question(rl, "repo (absolute path)")
          const base = await question(rl, "base branch", "main")
          const promptIn = await question(rl, "prompt (text, or @file)")
          const prompt = promptIn.startsWith("@") ? readFileSync(promptIn.slice(1), "utf8") : promptIn
          const stepsIn = await question(rl, "steps (id, id=N, id=MIN..MAX)", "implement,verify,review,security,finish=1")
          const skills = list(await question(rl, "skills that must load (comma)", "security-audit"))
          const pr = (await question(rl, "expect a PR? y/n", "y")) === "y"
          const checks = pr && (await question(rl, "PR checks must be green? y/n", "y")) === "y"
          const bodyIncludes = pr ? list(await question(rl, "PR body must include (comma)")) : []
          const untouched = pr ? list(await question(rl, "files the PR must not change (comma)")) : []
          const gatesRun = list(await question(rl, "SDLC gates that must run (design,testFirst,codeReview,supplyChain,docs,postMerge)"))
          const gatesSkipped = list(await question(rl, "SDLC gates that must be skipped (comma)"))
          const approvals = Object.fromEntries(
            await APPROVAL_TOPICS.reduce(
              async (acc, t) => [...(await acc), [t, await question(rl, `${t} decisions: auto or human`, t === "other" ? "human" : "auto")]],
              Promise.resolve([] as string[][]),
            ),
          )
          const runs = Number(await question(rl, "max runs", "5"))
          const minutesPerRun = Number(await question(rl, "minutes per run", "90"))
          return {
            id,
            repo,
            base,
            prompt,
            expect: {
              steps: parseSteps(stepsIn),
              skills,
              ...(pr ? { pr: { state: "OPEN", ...(checks ? { checks: "SUCCESS" } : {}), base, bodyIncludes, untouched } } : {}),
              sdlc: { criteriaProven: true, gatesRun, gatesSkipped },
            },
            approvals,
            limits: { runs, minutesPerRun },
          }
        } finally {
          rl.close()
        }
      },
      catch: (e) => (e instanceof Error ? e : new Error(String(e))),
    })
    const saved = yield* json("/api/goals", { method: "POST", body: JSON.stringify(answers) })
    yield* Console.log(`saved ${saved.id}\nnext: /factory-loop ${saved.id}   (or: sf goal run ${saved.id})`)
  })

/** Watch a thread until the goal is met, a human decision or a block stops it, or the time runs out. Returns the exit code. */
const watch = (json: Json, spec: GoalSpec, threadId: string) =>
  Effect.gen(function* () {
    const deadline = Date.now() + spec.limits.minutesPerRun * 60_000
    const answered = new Set<string>()
    while (true) {
      const run: Run = yield* json(`/api/runs/${enc(threadId)}`)
      const unmet = goalUnmet(run, spec.expect, spec.base)
      if (!unmet.length) return { run, unmet, outcome: "pass" as const, code: 0 }
      for (const a of splitPending(run, spec.approvals).auto.filter((a) => !answered.has(a.id))) {
        answered.add(a.id)
        yield* json(`/api/approvals/${enc(a.id)}`, {
          method: "POST",
          body: JSON.stringify({ answer: a.options[0], note: `Answered by goal ${spec.id} (policy ${a.topic}=auto).` }),
        })
        yield* Console.error(`auto-answered ${a.id} [${a.topic}] ${a.title}: ${a.options[0]}`)
      }
      const stop = stopReason(run, spec.approvals)
      if (stop?.code === 2) return { run, unmet, outcome: "waiting" as const, code: 2, reason: stop.reason }
      if (stop?.code === 3) return { run, unmet, outcome: "blocked" as const, code: 3, reason: stop.reason }
      if (Date.now() >= deadline) return { run, unmet, outcome: "timeout" as const, code: 1 }
      yield* Effect.sleep(POLL)
    }
  })

const runGoal = (json: Json, ask: Ask, id: string, thread?: string) =>
  Effect.gen(function* () {
    const spec: GoalSpec = yield* json(`/api/goals/${enc(id)}`)
    const before: GoalRun[] = yield* json(`/api/goals/${enc(id)}/runs`)
    yield* Console.error(`goal ${spec.id}: run ${before.length + 1} (limit ${spec.limits.runs} per loop)`)
    let threadId = thread
    if (!threadId) {
      const folder = yield* json("/api/folders", { method: "POST", body: JSON.stringify({ path: spec.repo }) })
      threadId = yield* ask(spec.prompt, folder.id, spec.base)
    }
    const r = yield* watch(json, spec, threadId)
    yield* Console.log(scoreCard(r.run, spec, r.unmet))
    if (r.outcome === "waiting") {
      yield* Console.log(`WAITING ${r.reason}\nanswer with: sf approve ID "Option", then: sf goal run ${spec.id} --thread ${threadId}`)
      return r.code
    }
    yield* json(`/api/goals/${enc(id)}/runs`, {
      method: "POST",
      body: JSON.stringify({ at: Date.now(), threadId, outcome: r.outcome, unmet: r.unmet, prUrl: r.run.pr?.url ?? null }),
    })
    yield* Console.log(r.outcome === "pass" ? "PASS" : `${r.outcome.toUpperCase()}${"reason" in r && r.reason ? ` ${r.reason}` : ""}`)
    return r.code
  })

export const goalCommand = (json: Json, ask: Ask, args: string[]): Effect.Effect<number | void, Error> => {
  const [sub, a, ...more] = args
  const out = (v: unknown) => Console.log(JSON.stringify(v, null, 2))
  switch (sub) {
    case "list":
    case undefined:
      return json("/api/goals").pipe(
        Effect.flatMap((v: any) =>
          Console.log(
            [`goals in ${v.dir} (factory ${v.factoryCommit})`, ...v.goals.map((g: any) => `${g.spec.id.padEnd(28)} runs ${String(g.runs).padStart(3)}  last ${g.last?.outcome ?? "-"}  ${g.spec.repo}`)].join("\n"),
          ),
        ),
      )
    case "show":
      return json(`/api/goals/${enc(a ?? "")}`).pipe(Effect.flatMap(out))
    case "new":
      return guided(json)
    case "save":
      return Effect.try({ try: () => readFileSync(a ?? "", "utf8"), catch: (e) => e as Error }).pipe(
        Effect.flatMap((body) => json("/api/goals", { method: "POST", body })),
        Effect.flatMap((g: any) => Console.log(`saved ${g.id}`)),
      )
    case "run":
      return runGoal(json, ask, a ?? "", more[0] === "--thread" ? more[1] : undefined)
    case "check":
      return Effect.gen(function* () {
        const spec: GoalSpec = yield* json(`/api/goals/${enc(a ?? "")}`)
        const run: Run = yield* json(`/api/runs/${enc(more[0] ?? "")}`)
        const unmet = goalUnmet(run, spec.expect, spec.base)
        yield* Console.log(`${scoreCard(run, spec, unmet)}\n${unmet.length ? "FAIL" : "PASS"}`)
        return unmet.length ? 1 : 0
      })
    case "history":
      return json(`/api/goals/${enc(a ?? "")}/runs`).pipe(Effect.flatMap((rs: GoalRun[]) => Console.log(rs.length ? rs.map(runLine).join("\n") : "no runs")))
    default:
      return Effect.fail(new Error(`unknown: sf goal ${sub}; one of list, show, new, save, run, check, history`))
  }
}
