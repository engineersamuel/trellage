import { Effect } from "effect"
import { noul } from "@typesafe-ai/sdk"
import { decisionsAvailable, systemOne } from "./decide.ts"
import { guideOptimizeSkills } from "../../../../packages/trellage-launcher/src/guide-optimize-catalog.ts"
import { optimizeStepId } from "./steps.ts"
import { loadPrompt } from "./prompt.ts"
import { factoryConfig, type FactoryConfig } from "./config.ts"

/** Deliberation and research workflows from [research.<id>]; each runs the step of the same id (see steps.ts). */
export const researchWorkflows = (c: FactoryConfig = factoryConfig()) =>
  Object.entries(c.research).map(([id, w]) => ({ id, description: w.description }))

type Choice = { readonly id: string; readonly description: string }


export const selectWorkflows = <C extends Choice>(
  probabilities: Record<string, number>,
  catalog: ReadonlyArray<C> = researchWorkflows() as unknown as ReadonlyArray<C>,
  c: FactoryConfig = factoryConfig(),
): { selected: C["id"][]; probabilities: Record<string, number> } => {
  for (const { id } of catalog) {
    const p = probabilities[id]
    if (p === undefined || !Number.isFinite(p) || p < 0 || p > 1) throw new Error(`Invalid Jev probability for ${id}`)
  }
  const top = new Set(
    catalog
      .filter(({ id }) => probabilities[id]! >= c.fanout.select_threshold)
      .sort((a, b) => probabilities[b.id]! - probabilities[a.id]!)
      .slice(0, c.fanout.max_workers)
      .map(({ id }) => id),
  )
  return { selected: catalog.filter(({ id }) => top.has(id)).map(({ id }) => id), probabilities }
}

/** One independent Jev yes/no judgment per catalog entry. */
const jevSelect = <C extends Choice>(catalog: ReadonlyArray<C>, request: string, question: (c: C) => string) =>
  Effect.runPromise(
    Effect.tryPromise(async () => {
      if (!decisionsAvailable()) throw new Error("Jev unavailable: no TYPESAFE_API_KEY")
      const questions = Object.fromEntries(catalog.map((c) => [c.id, noul(question(c))]))
      const result = await systemOne({ state: JSON.stringify({ request }), questions })
      return selectWorkflows(Object.fromEntries(catalog.map(({ id }) => [id, result.answers[id]?.noul ?? Number.NaN])), catalog)
    }),
  )

/** The `trx guide --optimize` skills, one read-only fan-out worker each. */
export const OPTIMIZE_SKILLS = guideOptimizeSkills

/** Task for one research or deliberation workflow: write its own report only. */
export const researchTask = (id: string, request: string, report?: string): string => {
  return loadPrompt("tasks/research", { request, report: report ?? id })
}

/** One fan-out option. `step` decides harness and skills; the worker saves reports/<step>.md. */
export type FanoutEntry = { id: string; kind: "research" | "optimize"; description: string; step: string; task: (request: string) => string }

/** Research workflows (from the config) and Optimize lenses, read at use time. */
export const fanoutCatalog = (c: FactoryConfig = factoryConfig()): FanoutEntry[] => [
  ...researchWorkflows(c).map((w) => ({
    id: w.id,
    kind: "research" as const,
    description: w.description,
    step: w.id,
    task: (r: string) => researchTask(w.id, r),
  })),
  ...OPTIMIZE_SKILLS.map((s) => ({
    id: s.id,
    kind: "optimize" as const,
    description: `Read-only repository review lens "${s.title}": ${s.description}`,
    step: optimizeStepId(s.id),
    task: (r: string) => optimizeTask(s.id, r),
  })),
]

export type FanoutSelection = { selected: string[]; probabilities: Record<string, number> }

/** One independent Jev judgment per catalog entry, research and optimize together. */
export const routeFanout = (request: string): Promise<FanoutSelection> =>
  jevSelect(
    fanoutCatalog(),
    request,
    ({ description }) =>
      loadPrompt("jev/fanout", { worker: description }),
  )

/** Read-only task for one Optimize skill: find and rank, never edit. */
export const optimizeTask = (id: string, request: string): string => {
  const skill = OPTIMIZE_SKILLS.find((s) => s.id === id)
  if (!skill) throw new Error(`Unknown Optimize skill ${id}`)
  return loadPrompt("tasks/optimize", { request, title: skill.title, lens: skill.prompt, report: optimizeStepId(id) })
}
