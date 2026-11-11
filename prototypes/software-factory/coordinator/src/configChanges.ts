// Agent proposals to change the factory config or a prompt. The agent never applies them: each one opens a decision,
// and only the human's "Apply" answer writes it (a config key as a runtime override, a prompt as a user prompt file).
// Pending proposals live in the state dir, so an answer after a restart still applies.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Approval } from "./approvals.ts"
import { configStore, type Scalar } from "./config.ts"
import {
  checkTemplate,
  declaredInputs,
  defaultPromptsDir,
  parsePromptFile,
  promptFile,
  userCopy,
  userPromptsDir,
} from "./prompt.ts"
import { describeEvaluation, type Evaluation } from "./promptEval.ts"

export const APPLY = "Apply"
export const REJECT = "Reject"

export type Proposal =
  | { kind: "config"; key: string; value: Scalar; reason: string }
  | { kind: "prompt"; name: string; text: string; reason: string }

const file = (root: string) => path.join(root, "config-proposals.json")
const readAll = (root: string): Record<string, Proposal> => {
  try {
    return existsSync(file(root)) ? (JSON.parse(readFileSync(file(root), "utf8")) as Record<string, Proposal>) : {}
  } catch {
    return {}
  }
}
const writeAll = (root: string, all: Record<string, Proposal>) =>
  writeFileSync(file(root), JSON.stringify(all, null, 2))

/** A prompt name the factory ships: letters, digits, dashes, at most one folder level. */
const PROMPT_NAME = /^([a-z0-9-]+\/)?[a-z0-9-]+$/

/** Check a proposal before it reaches the human. Throws a message the agent can act on. */
export const checkProposal = (p: Proposal): void => {
  if (!p.reason.trim()) throw new Error("reason is empty")
  if (p.kind === "config") {
    const known = configStore()
      .values()
      .find((v) => v.key === p.key)
    if (!known) throw new Error(`unknown config key ${p.key}; see get_factory_config`)
    if (typeof known.value !== typeof p.value || Array.isArray(known.value) !== Array.isArray(p.value))
      throw new Error(`${p.key} takes a ${Array.isArray(known.value) ? "list of strings" : typeof known.value}`)
    return
  }
  if (!PROMPT_NAME.test(p.name) || !existsSync(path.join(defaultPromptsDir, `${p.name}.md`)))
    throw new Error(`unknown prompt ${p.name}; see get_factory_config`)
  if (!p.text.trim()) throw new Error("prompt text is empty")
  // The new text may use only the inputs the shipped prompt declares, and config keys.
  const shipped = parsePromptFile(readFileSync(path.join(defaultPromptsDir, `${p.name}.md`), "utf8"))
  checkTemplate(p.text, declaredInputs(shipped))
}

/** The decision text the human reads. A prompt proposal shows its replay test result. */
export const describe = (p: Proposal, evaluation?: Evaluation): { title: string; summary: string } =>
  p.kind === "config"
    ? {
        title: `Change factory config ${p.key}`,
        summary: `${p.key}: ${JSON.stringify(
          configStore()
            .values()
            .find((v) => v.key === p.key)?.value,
        )} → ${JSON.stringify(p.value)}\n\nWhy: ${p.reason}\n\nApply sets a runtime override; promote it to your config file in Settings to keep it.`,
      }
    : {
        title: `Change prompt ${p.name}`,
        summary: `Why: ${p.reason}\n\n${evaluation ? `${describeEvaluation(evaluation)}\n\n` : ""}Apply writes ${path.join(userPromptsDir(), `${p.name}.md`)} (overrides the shipped prompt; new delivery runs use it).\n\nNew text:\n\`\`\`\n${p.text}\n\`\`\`\n\nCurrent text:\n\`\`\`\n${promptFile(p.name).body}\n\`\`\``,
      }

export const saveProposal = (root: string, approvalId: string, p: Proposal) =>
  writeAll(root, { ...readAll(root), [approvalId]: p })

/** Apply or drop the proposal an answered decision belongs to. Returns what happened, or null when it is not one. */
export const settleProposal = (root: string, a: Pick<Approval, "id" | "answer">): string | null => {
  const all = readAll(root)
  const p = all[a.id]
  if (!p) return null
  delete all[a.id]
  writeAll(root, all)
  if (a.answer !== APPLY) return `rejected: ${p.kind === "config" ? p.key : p.name}`
  if (p.kind === "config") {
    configStore().setOverride(p.key, p.value)
    return `applied: ${p.key} = ${JSON.stringify(p.value)}`
  }
  const out = path.join(userPromptsDir(), `${p.name}.md`)
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, userCopy(p.name, p.text))
  return `applied: ${out}`
}
