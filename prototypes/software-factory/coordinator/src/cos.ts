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

export type RuleId =
  | "r1"
  | "r3"
  | "r6"
  | "r7"
  | "r8"
  | "r11"
  | "r12"
  | "r14"
  | "r15"
  | "r17"
  | "r21"
  | "r24"
  | "r25"
  | "r26"
  | "r27"
  | "r28"
  | "r29"

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
  // Decisions the rules themselves open (R24) are for the human.
  if (a.status !== "pending" || !s || isProposal || a.context.startsWith("Chief of Staff")) return null
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
  if (pr.mergeable === "CONFLICTING")
    out.push(
      "PR has merge conflicts (rule R22: spawn step=finish to rebase on origin/main, resolve them, run the tests and push)",
    )
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

export type MergeResult = { merged: boolean; pr?: string; reason?: string; pull?: string; sha?: string | null }

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
  return {
    merged: true,
    pr: pr.url,
    sha: await mergeCommit(m.worktree, String(pr.number)),
    pull: await pullMain(m.worktree, m.repo),
  }
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

// ---------- R15, R16, R17: CI on main and one merge at a time ----------

/** Per repo: main is red (R15; only its fix conversation may merge), or a merge waits for main CI (R17). */
export type RepoHold = {
  red?: { fixThread: string | null; since: number }
  settling?: { pr: string; sha: string }
  /** Conversations whose merge_pr was held; told to call it again when the hold ends. */
  waiting?: string[]
}

/** Merge holds per repo, saved in cos.db so a restart keeps them (with `root`; in memory without). */
export class RepoGates {
  private readonly holds = new Map<string, RepoHold>()
  private readonly db: Database | null
  constructor(root?: string) {
    this.db = root ? new Database(path.join(root, "cos.db"), { create: true }) : null
    if (!this.db) return
    this.db.run("PRAGMA journal_mode = WAL")
    this.db.run("CREATE TABLE IF NOT EXISTS repo_holds (repo TEXT PRIMARY KEY, data TEXT NOT NULL)")
    const rows = this.db.query("SELECT repo, data FROM repo_holds").all() as { repo: string; data: string }[]
    for (const r of rows) this.holds.set(r.repo, JSON.parse(r.data) as RepoHold)
  }
  get(repo: string): RepoHold {
    return this.holds.get(repo) ?? {}
  }
  set(repo: string, h: RepoHold): void {
    if (!h.red && !h.settling && !h.waiting?.length) {
      this.holds.delete(repo)
      this.db?.run("DELETE FROM repo_holds WHERE repo = ?", [repo])
    } else {
      this.holds.set(repo, h)
      this.db?.run("INSERT OR REPLACE INTO repo_holds (repo, data) VALUES (?, ?)", [repo, JSON.stringify(h)])
    }
  }
  /** Remember a conversation whose merge was held. */
  wait(repo: string, threadId: string): void {
    const h = this.get(repo)
    if (!h.waiting?.includes(threadId)) this.set(repo, { ...h, waiting: [...(h.waiting ?? []), threadId] })
  }
  all(): [string, RepoHold][] {
    return [...this.holds]
  }
}

/** Why merge_pr must wait in this repo, or null. The fix conversation of a red main may merge (R15). */
export const mergeHold = (h: RepoHold, threadId: string | null): string | null => {
  if (h.red && h.red.fixThread !== threadId)
    return "CI on main is red (rule R15); only its fix conversation merges until main is green. The factory tells you when to call merge_pr again; report nothing until then."
  if (h.settling)
    return `PR ${h.settling.pr} was just merged; one merge at a time (rule R17). The factory tells you when CI on main is green; then call merge_pr again.`
  return null
}

/** The check state of the newest commit on main, or null when gh cannot tell (no GitHub remote). */
export const mainChecks = async (repo: string): Promise<{ sha: string; state: string } | null> => {
  const sha = await run("git", ["-C", repo, "ls-remote", "origin", "refs/heads/main"], repo, 30_000)
  const head = sha.ok ? sha.out.split(/\s/)[0] : ""
  if (!head) return null
  const runs = await run(
    "gh",
    [
      "api",
      `repos/{owner}/{repo}/commits/${head}/check-runs`,
      "--jq",
      '[.check_runs[] | {status: (.status|ascii_upcase), conclusion: ((.conclusion // "")|ascii_upcase)}]',
    ],
    repo,
    30_000,
  )
  return runs.ok ? { sha: head, state: checksState(JSON.parse(runs.out) as Check[]) } : null
}

/** The merge commit of a merged PR, for R17's wait on main CI. */
export const mergeCommit = async (worktree: string, pr: string): Promise<string | null> => {
  const r = await run("gh", ["pr", "view", pr, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"], worktree)
  return r.ok && r.out ? r.out : null
}

/** Open PR branches of a repo (R21 tells them to rebase after a merge). */
export const openPrBranches = async (repo: string): Promise<string[]> => {
  const r = await run(
    "gh",
    ["pr", "list", "--state", "open", "--limit", "100", "--json", "headRefName", "--jq", ".[].headRefName"],
    repo,
  )
  return r.ok ? r.out.split("\n").filter(Boolean) : []
}

// ---------- R24: same blocker twice ----------

/** A blocked report as a comparable key: gaps (else summary), lower case, without numbers, hashes and spacing. */
export const blockerKey = (gaps: readonly string[], summary: string): string =>
  (gaps.length ? gaps.join(" | ") : summary)
    .toLowerCase()
    .replace(/\b[0-9a-f]{7,40}\b/g, "")
    .replace(/\d+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400)

// ---------- R26: duplicate task ----------

export const taskKey = (task: string): string => task.toLowerCase().replace(/\s+/g, " ").trim()

// ---------- R28: model errors across workers ----------

const MODEL_ERROR =
  /\b(401|403|429|unauthori[sz]ed|forbidden|rate.?limit|too many requests|quota|auth(entication)? (failed|error|required)|token expired)\b/i
export const isModelError = (message: string): boolean => MODEL_ERROR.test(message)

/** Workers with a model error in the window; R28 holds new workers at `min` or more. */
export const modelErrorWorkers = (
  errors: readonly { worker: string; at: number }[],
  now: number,
  windowMs: number,
): string[] => [...new Set(errors.filter((e) => now - e.at <= windowMs).map((e) => e.worker))]

// ---------- R25: idle and not reported ----------

export type IdleState = {
  /** The sub-coordinator is idle, with no running worker of its own. */
  idle: boolean
  quietMs: number
  /** The PR of its branch is merged (or, with no PR, its last report was done). */
  done: boolean
  /** It reported after its last turn started. */
  reported: boolean
}

export const r25Action = (s: IdleState, quietMs: number): "archive" | "report" | null =>
  !s.idle || s.quietMs < quietMs ? null : s.done ? "archive" : s.reported ? null : "report"

// ---------- R6, R7, R8: worker issues the rules handle in code ----------

export type IssueKind = "error" | "stalled" | "failing-tools" | "off-track" | "uncollected"
export type IssueAction = "nudge" | "stop" | "to-owner" | "to-human" | "warn-owner" | null

/**
 * What the rules do with one supervisor issue, given how often this worker had it before.
 * R6 stalled: nudge once, then stop. R7 failing tools: errors to the owner, again to the human. R8 off-track: tell
 * the owner (never stops the worker; offTrackStreak decides when the issue exists).
 * Other kinds (error, uncollected) go to their owner as before (null).
 */
export const issueAction = (kind: IssueKind, seenBefore: number, on: (r: RuleId) => boolean): IssueAction => {
  if (kind === "stalled" && on("r6")) return seenBefore === 0 ? "nudge" : "stop"
  if (kind === "failing-tools" && on("r7")) return seenBefore === 0 ? "to-owner" : "to-human"
  if (kind === "off-track" && on("r8")) return "warn-owner"
  return null
}

/** Steps R8 never scores: their workers run long checks whose output reads like no progress. */
const R8_EXEMPT_STEPS = new Set(["verify", "evaluate", "security", "review"])

/** R8 scores a worker only when it is not a gate or check worker and no tool call is running. */
export const r8Scores = (w: { step: string | null; toolsInFlight: number }, isGateWorker: boolean): boolean =>
  !isGateWorker && w.toolsInFlight === 0 && !R8_EXEMPT_STEPS.has(w.step ?? "")

/** R8 low-score streaks: the issue exists on the second low score in a row, once per streak. */
export class OffTrack {
  private readonly streak = new Map<string, number>()
  /** Record one score; true when this score starts an R8 issue (exactly the second low score in a row). */
  score(worker: string, p: number, below = 0.3): boolean {
    const n = p < below ? (this.streak.get(worker) ?? 0) + 1 : 0
    this.streak.set(worker, n)
    return n === 2
  }
  forget(live: (id: string) => boolean): void {
    for (const id of this.streak.keys()) if (!live(id)) this.streak.delete(id)
  }
}

// ---------- R11: two conversations change the same files or PR ----------

export type Changes = { threadId: string; repo: string; createdAt: number; files: string[]; pr: number | null }

/** Pairs of open conversations in one repo with a shared file or the same PR; `newer` is the one R11 holds. */
export const overlaps = (all: readonly Changes[]): { older: string; newer: string; files: string[] }[] => {
  const out: { older: string; newer: string; files: string[] }[] = []
  const sorted = [...all].sort((a, b) => a.createdAt - b.createdAt)
  for (let i = 0; i < sorted.length; i++)
    for (let j = i + 1; j < sorted.length; j++) {
      const [a, b] = [sorted[i]!, sorted[j]!]
      if (a.repo !== b.repo) continue
      const set = new Set(a.files)
      const files = b.files.filter((f) => set.has(f))
      if (files.length || (a.pr !== null && a.pr === b.pr)) out.push({ older: a.threadId, newer: b.threadId, files })
    }
  return out
}

/** R11's answer that code acts on: stop the newer conversation. */
export const R11_STOP = "Stop the newer one"

/**
 * Files a conversation changes: tracked changes since its merge base with origin/<target> (so a rebase on main does
 * not count main's changes as its own), plus new untracked files. `.factory/` is left out.
 */
export const changedFiles = async (worktree: string, target = "main"): Promise<string[]> => {
  const mb = await run("git", ["-C", worktree, "merge-base", "HEAD", `origin/${target}`], worktree)
  if (!mb.ok) return []
  const [tracked, untracked] = await Promise.all([
    run("git", ["-C", worktree, "diff", "--name-only", mb.out], worktree),
    run("git", ["-C", worktree, "ls-files", "--others", "--exclude-standard"], worktree),
  ])
  const files = [tracked, untracked].flatMap((r) => (r.ok ? r.out.split("\n") : []))
  return [...new Set(files.filter((f) => f && !f.startsWith(".factory/")))]
}

// ---------- R12: goal cost alert ----------

/** R12: alert once when a goal's spend reaches `share` of its limit (100% is the existing goal pause). */
export const costAlert = (spent: number, limit: number, share: number, alerted: boolean): boolean =>
  !alerted && limit > 0 && spent >= limit * share && spent < limit

// ---------- Typed PR events ----------

export type PrState = "green" | "red" | "pending" | "merged" | "closed"

export const prState = (state: string, checks: string): PrState =>
  state === "MERGED"
    ? "merged"
    : state !== "OPEN"
      ? "closed"
      : checks === "SUCCESS" || checks === "NONE"
        ? "green"
        : checks === "FAILURE"
          ? "red"
          : "pending"

/** The typed event for a change of PR state, or null when nothing worth an event changed. */
export const prEvent = (before: PrState | undefined, now: PrState): "pr-green" | "pr-red" | "merged" | null =>
  before === now ? null : now === "green" ? "pr-green" : now === "red" ? "pr-red" : now === "merged" ? "merged" : null
