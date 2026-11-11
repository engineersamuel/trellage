// Prompt evaluation: before the human applies a prompt proposal, replay recorded decisions with the current and the
// proposed text and show the difference on the decision card. It informs; it never blocks (the human decides).
//
// Test set: answered decisions with a shadow prediction (`approvals.db`). Their label is the human's real answer, so
// shadow prompts (jev/shadow-pick, jev/shadow-covered) get an agreement score. Every other Jev prompt is scored by how
// often the new text changes the answer on recorded states ($SF_STATE_DIR/decision-cases.jsonl, written from now on).
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { choice, noul } from "@typesafe-ai/sdk"
import type { Approval } from "./approvals.ts"
import { decisionsAvailable, systemOne } from "./decide.ts"
import { render, configVars } from "./prompt.ts"
import { factoryConfig } from "./config.ts"
import { instructionsPath, readInstructions } from "./shadow.ts"
import { stateDir } from "./statedir.ts"

/** At most this many recorded cases per evaluation: a bounded number of decision calls per proposal. */
export const MAX_CASES = 20

export type Evaluation =
  | { kind: "skipped"; reason: string }
  | { kind: "agreement"; cases: number; current: number; proposed: number }
  | { kind: "stability"; cases: number; changed: number }

/** One recorded Jev question: the prompt it used, its vars, the state Jev saw, and the answer it gave. */
export type DecisionCase = { prompt: string; vars: Record<string, string>; state: string; answer: number | string }

const casesFile = (root: string) => path.join(root, "decision-cases.jsonl")

/** Record a decision for later replays. Best effort: a failed write never affects the decision. */
export const recordCase = (c: DecisionCase, root = stateDir()): void => {
  try {
    appendFileSync(casesFile(root), `${JSON.stringify(c)}\n`)
  } catch {}
}

const readCases = (root: string, prompt: string): DecisionCase[] =>
  existsSync(casesFile(root))
    ? readFileSync(casesFile(root), "utf8")
        .split("\n")
        .flatMap((l) => {
          try {
            const c = JSON.parse(l) as DecisionCase
            return c.prompt === prompt ? [c] : []
          } catch {
            return []
          }
        })
        .slice(-MAX_CASES)
    : []

const fill = (text: string, vars: Record<string, string>) => render(text, { ...configVars(factoryConfig()), ...vars })

const shadowState = (a: Approval) =>
  JSON.stringify({
    humanInstructions: readInstructions(instructionsPath()).slice(0, 12_000),
    decision: {
      kind: a.kind,
      title: a.title,
      context: a.context,
      summary: a.summary.slice(0, 4000),
      options: a.options,
      optionDetails: a.optionDetails,
    },
  })

/** Answered decisions with options: the human's answer is the label. */
const labelled = (approvals: Approval[]) =>
  approvals.filter((a) => a.status === "answered" && a.answer !== null && a.options.length > 1).slice(-MAX_CASES)

/** Agreement of the shadow pick with the human's real answer, for the current and the proposed jev/shadow-pick. */
const shadowPick = async (approvals: Approval[], current: string, proposed: string): Promise<Evaluation> => {
  const cases = labelled(approvals)
  if (!cases.length) return { kind: "skipped", reason: "no answered decisions to compare with yet" }
  let cur = 0
  let next = 0
  for (const a of cases) {
    const options = Object.fromEntries(
      a.options.map((o, i) => [`o${i}`, `${o}${a.optionDetails[i] ? `: ${a.optionDetails[i]}` : ""}`]),
    )
    const res = await systemOne({
      timeoutMs: 15_000,
      state: shadowState(a),
      questions: { cur: choice(fill(current, {}), options), next: choice(fill(proposed, {}), options) },
    })
    const pick = (k: string) => a.options[Number(String(res.answers[k]?.choice).slice(1))]
    if (pick("cur") === a.answer) cur++
    if (pick("next") === a.answer) next++
  }
  return { kind: "agreement", cases: cases.length, current: cur, proposed: next }
}

/** How often the proposed text changes Jev's answer on recorded states of the same prompt. */
const stability = async (root: string, name: string, current: string, proposed: string): Promise<Evaluation> => {
  const cases = readCases(root, name)
  if (!cases.length) return { kind: "skipped", reason: `no recorded ${name} decisions yet` }
  let changed = 0
  for (const c of cases) {
    const res = await systemOne({
      state: c.state,
      questions: { a: noul(fill(current, c.vars)), b: noul(fill(proposed, c.vars)) },
    })
    const a = res.answers.a?.noul
    const b = res.answers.b?.noul
    if (typeof a === "number" && typeof b === "number" && a >= 0.5 !== b >= 0.5) changed++
  }
  return { kind: "stability", cases: cases.length, changed }
}

/** Evaluate a prompt proposal. Never throws: a failure is a skipped evaluation with the reason. */
export const evaluatePrompt = async (
  root: string,
  approvals: Approval[],
  name: string,
  current: string,
  proposed: string,
): Promise<Evaluation> => {
  if (!name.startsWith("jev/") && !name.startsWith("gates/"))
    return { kind: "skipped", reason: "only decision prompts (jev/, gates/) have a replay test" }
  if (!decisionsAvailable()) return { kind: "skipped", reason: "no decision engine available" }
  try {
    return name === "jev/shadow-pick"
      ? await shadowPick(approvals, current, proposed)
      : await stability(root, name, current, proposed)
  } catch (e) {
    return { kind: "skipped", reason: `replay failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** One line for the decision card. */
export const describeEvaluation = (e: Evaluation): string =>
  e.kind === "skipped"
    ? `Replay test: not run (${e.reason}).`
    : e.kind === "agreement"
      ? `Replay test on ${e.cases} answered decisions: current text matched your answer ${e.current} times, proposed text ${e.proposed} times.${e.proposed < e.current ? " ⚠ The proposal scores worse." : ""}`
      : `Replay test on ${e.cases} recorded decisions: the proposal flips the yes/no answer in ${e.changed}.`
