// Chief of Staff rules (ADR 0008). Each rule is code: a pure check plus the action the service takes.
// Every action the rules take is written to the ledger (cos.db), the Chief of Staff's memory.
import { Database } from "bun:sqlite"
import { execFile } from "node:child_process"
import { realpathSync } from "node:fs"
import path from "node:path"
import type { Approval } from "./approvals.ts"
import { factoryConfig } from "./config.ts"
import type { Evaluation } from "./evaluate.ts"
import { checksState, type Check } from "./run.ts"

export type RuleId = "r1" | "r3" | "r14" | "r27"

export const ruleOn = (id: RuleId): boolean => factoryConfig().cos.rules[id]

// ---------- Ledger ----------

export type LedgerEntry = {
  seq: number
  at: number
  rule: string
  threadId: string | null
  action: string
  result: "done" | "refused" | "failed"
  detail: string
}

const ledgers = new Map<string, Ledger>()

/** Append-only log of every action a rule took or refused. */
export class Ledger {
  private readonly db: Database
  constructor(root: string) {
    this.db = new Database(path.join(root, "cos.db"), { create: true })
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run(
      "CREATE TABLE IF NOT EXISTS ledger (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, rule TEXT NOT NULL, thread_id TEXT, action TEXT NOT NULL, result TEXT NOT NULL, detail TEXT NOT NULL)",
    )
  }
  add(e: Omit<LedgerEntry, "seq" | "at">): LedgerEntry {
    const at = Date.now()
    const r = this.db.run(
      "INSERT INTO ledger (at, rule, thread_id, action, result, detail) VALUES (?, ?, ?, ?, ?, ?)",
      [at, e.rule, e.threadId, e.action, e.result, e.detail],
    )
    return { ...e, seq: Number(r.lastInsertRowid), at }
  }
  list(limit = 200, threadId?: string): LedgerEntry[] {
    const sql = `SELECT seq, at, rule, thread_id AS threadId, action, result, detail FROM ledger${threadId ? " WHERE thread_id = ?" : ""} ORDER BY seq DESC LIMIT ?`
    return this.db.query(sql).all(...(threadId ? [threadId, limit] : [limit])) as LedgerEntry[]
  }
}

export const ledgerOf = (root: string): Ledger => {
  let l = ledgers.get(root)
  if (!l) ledgers.set(root, (l = new Ledger(root)))
  return l
}

// ---------- R1: Jev answers a decision ----------

/** Topics R1 never answers: ship (R14 only), cost, goal runner decisions. */
const R1_EXCLUDED_TOPICS = new Set<string>(["ship", "budget", "goal"])
/** Wording R1 never answers: merge and delete stay with the rules that own them, or the human. */
const R1_EXCLUDED_WORDS = /\b(merge|merging|delete|deleting|remove the branch)\b/i

/** The option R1 picks for the human, or null when the human decides. Config proposals (Apply/Reject) stay with the human. */
export const r1Pick = (a: Approval, threshold: number, isProposal: boolean): string | null => {
  const s = a.shadow
  if (a.status !== "pending" || !s || isProposal) return null
  if (R1_EXCLUDED_TOPICS.has(a.topic ?? "other")) return null
  if (R1_EXCLUDED_WORDS.test([a.title, ...a.options].join(" "))) return null
  if (s.pick === null || s.confidence < threshold || !a.options.includes(s.pick)) return null
  return s.pick
}

// ---------- R14: the Chief of Staff grants a ship ----------

/**
 * Why R14 does not grant this ship, or null when it does. The ship request itself was refused unless verify, the
 * security review and every SDLC gate were done (request_approval); R14 adds: the independent evaluator finished and
 * passed every acceptance criterion.
 */
export const r14Blocker = (ev: Evaluation | undefined): string | null => {
  if (!ev) return "no independent evaluation"
  if (ev.status !== "done") return `independent evaluation is ${ev.status}`
  if (!ev.verdicts.length) return "independent evaluation has no verdicts"
  const failed = ev.verdicts.filter((v) => v.verdict !== "pass").map((v) => v.id)
  return failed.length ? `acceptance criteria failed: ${failed.join(", ")}` : null
}

// ---------- R3: merge, then pull the main checkout ----------

export type PrView = {
  number: number
  url: string
  state: string
  isDraft: boolean
  headRefName: string
  reviewDecision: string | null
  mergeable: string
  statusCheckRollup: Check[] | null
}

/** Why R3 does not merge this PR, or [] when it may. A repo with no checks counts as green (ADR 0007). */
export const r3Blockers = (pr: PrView, branch: string): string[] => {
  const out: string[] = []
  if (pr.headRefName !== branch) out.push(`PR #${pr.number} is for ${pr.headRefName}, not ${branch}`)
  if (pr.state !== "OPEN") out.push(`PR #${pr.number} is ${pr.state}`)
  if (pr.isDraft) out.push("PR is a draft")
  if (pr.reviewDecision === "CHANGES_REQUESTED") out.push("a reviewer requested changes")
  if (pr.mergeable === "CONFLICTING") out.push("PR has merge conflicts")
  const checks = checksState(pr.statusCheckRollup ?? [])
  if (checks !== "SUCCESS" && checks !== "NONE") out.push(`checks are ${checks}`)
  return out
}

const run = (cmd: string, args: string[], cwd: string, timeout = 60_000): Promise<{ ok: boolean; out: string }> =>
  new Promise((resolve) =>
    execFile(cmd, args, { cwd, timeout, maxBuffer: 8 << 20 }, (err, stdout, stderr) =>
      resolve({ ok: !err, out: (err ? `${stderr || err.message}` : stdout).trim() }),
    ),
  )

const real = (p: string): string => {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * The repo's main checkout, found from the conversation's worktree (any path, also nested): the parent of git's
 * common dir. It must be the folder the factory registered for the repo.
 */
export const mainCheckout = async (worktree: string, registered: string): Promise<string | { error: string }> => {
  const r = await run("git", ["-C", worktree, "rev-parse", "--path-format=absolute", "--git-common-dir"], worktree)
  if (!r.ok) return { error: `git rev-parse failed: ${r.out}` }
  const checkout = path.dirname(r.out)
  return real(checkout) === real(registered)
    ? checkout
    : { error: `main checkout ${checkout} is not the registered repo folder ${registered}` }
}

/** R3a: why the main checkout is not pulled (not clean, not on main), or null. Never stashes. */
export const r3aBlocker = async (checkout: string): Promise<string | null> => {
  const branch = await run("git", ["-C", checkout, "rev-parse", "--abbrev-ref", "HEAD"], checkout)
  if (!branch.ok) return `git failed in ${checkout}: ${branch.out}`
  if (branch.out !== "main") return `${checkout} is on ${branch.out}, not main`
  const status = await run("git", ["-C", checkout, "status", "--porcelain"], checkout)
  if (!status.ok) return `git status failed in ${checkout}: ${status.out}`
  return status.out ? `${checkout} has uncommitted changes` : null
}

export type MergeInput = {
  worktree: string
  repo: string
  branch: string
  /** The branch has a ship grant (the human's or R14's). */
  shipGranted: boolean
}

export type MergeResult = { merged: boolean; pr?: string; reason?: string; pull?: string }

/** R3: squash-merge the conversation's PR when every condition holds, then pull the main checkout (R3a). */
export const mergePr = async (m: MergeInput): Promise<MergeResult> => {
  if (!ruleOn("r3")) return { merged: false, reason: "rule R3 (automatic merge) is off; the human merges" }
  if (!m.branch.startsWith("factory/"))
    return { merged: false, reason: `only factory/* branches merge; on ${m.branch}` }
  if (!m.shipGranted) return { merged: false, reason: `no accepted ship approval for ${m.branch}` }
  const fields = "number,url,state,isDraft,headRefName,reviewDecision,mergeable,statusCheckRollup"
  const view = await run("gh", ["pr", "view", m.branch, "--json", fields], m.worktree)
  if (!view.ok) return { merged: false, reason: `gh pr view failed: ${view.out.split("\n")[0]}` }
  const pr = JSON.parse(view.out) as PrView
  const blockers = r3Blockers(pr, m.branch)
  if (blockers.length) return { merged: false, pr: pr.url, reason: blockers.join("; ") }
  const merged = await run("gh", ["pr", "merge", String(pr.number), "--squash"], m.worktree, 120_000)
  if (!merged.ok) return { merged: false, pr: pr.url, reason: `gh pr merge failed: ${merged.out.split("\n")[0]}` }
  return { merged: true, pr: pr.url, pull: await pullMain(m.worktree, m.repo) }
}

/** After a merge: `git pull --rebase origin main` in the main checkout, or why it was not pulled. */
export const pullMain = async (worktree: string, repo: string): Promise<string> => {
  const checkout = await mainCheckout(worktree, repo)
  if (typeof checkout !== "string") return `not pulled: ${checkout.error}`
  const blocked = await r3aBlocker(checkout)
  if (blocked) return `not pulled: ${blocked}`
  const pull = await run("git", ["-C", checkout, "pull", "--rebase", "origin", "main"], checkout, 120_000)
  return pull.ok ? `pulled ${checkout}` : `pull failed in ${checkout}: ${pull.out.split("\n")[0]}`
}

// ---------- R27: code relays the human's answer ----------

/** The text a reporting conversation gets when its decision is answered; no global coordinator turn. */
export const relayText = (a: Approval): string =>
  `[decision ${a.id} answered${a.answeredBy ? ` by ${a.answeredBy}` : ""}] "${a.title}": ${a.answer}${a.note ? `\nNote: ${a.note}` : ""}\nContinue accordingly.`
