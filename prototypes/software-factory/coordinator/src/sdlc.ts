// SDLC gates: the smallest correct process per change. Jev decides which optional gates a change needs (one
// probability per gate against its threshold); code holds the floors no answer can skip, and blocks shipping
// until every chosen gate is done. Artifacts live in the worktree's `.factory/` (git-excluded, never committed).
import { execFile, execFileSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { noul } from "@typesafe-ai/sdk"
import { decisionLabel, decisionsAvailable, systemOne } from "./decide.ts"
import { loadPrompt } from "./prompt.ts"
import { factoryConfig, type FactoryConfig } from "./config.ts"
import { recordCase } from "./promptEval.ts"
import type { Verdict } from "../../shared/goal.ts"

// ---------- Artifacts ----------

export const FACTORY_DIR = ".factory"
export const artifact = (workdir: string, name: string) => path.join(workdir, FACTORY_DIR, name)

/** Create `.factory/` and keep it out of git (the repo's shared info/exclude). */
export const ensureFactoryDir = (workdir: string): void => {
  mkdirSync(path.join(workdir, FACTORY_DIR), { recursive: true })
  try {
    const exclude = execFileSync(
      "git",
      ["-C", workdir, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude"],
      { encoding: "utf8" },
    ).trim()
    const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : ""
    if (!text.split("\n").includes(`/${FACTORY_DIR}/`)) {
      mkdirSync(path.dirname(exclude), { recursive: true })
      appendFileSync(exclude, `${text && !text.endsWith("\n") ? "\n" : ""}/${FACTORY_DIR}/\n`)
    }
  } catch {}
}

const readOr = (file: string): string | null => (existsSync(file) ? readFileSync(file, "utf8") : null)

/** `AC-1: text` lines; ids are renumbered from the list order. */
export const criteriaMarkdown = (criteria: string[]): string =>
  `# Acceptance criteria\n\n${criteria.map((c, i) => `AC-${i + 1}: ${c.trim()}`).join("\n")}\n`
export const parseCriteria = (md: string): string[] => [...md.matchAll(/^AC-(\d+):\s*(.+)$/gm)].map((m) => m[2]!.trim())

/** Each criterion's verdict from evidence.md lines (`AC-n: PASS|FAIL — command — output`).
 *  Any FAIL takes precedence over PASS; neither means missing. */
export const criteriaResults = (criteria: string[], evidence: string | null): Record<string, Verdict> => {
  const lines = (word: string) =>
    new Set([...(evidence ?? "").matchAll(new RegExp(`^AC-(\\d+):\\s*${word}\\b`, "gim"))].map((m) => Number(m[1])))
  const [passed, failed] = [lines("PASS"), lines("FAIL")]
  return Object.fromEntries(
    criteria.map((_, i) => [`AC-${i + 1}`, failed.has(i + 1) ? "fail" : passed.has(i + 1) ? "pass" : "missing"]),
  )
}

/** Criteria without a PASS line in evidence.md. */
export const unprovenCriteria = (criteria: string[], evidence: string | null): string[] =>
  Object.entries(criteriaResults(criteria, evidence)).flatMap(([id, v]) => (v === "pass" ? [] : [id]))

// ---------- Repo checks (the same commands CI runs) ----------

const CHECK_WORDS = /\b(test|lint|check|fmt|format|clippy|typecheck|vet|build)\b/i

/** One-line `run:` commands of the repo's GitHub workflows, and backticked check commands from AGENTS.md / CLAUDE.md. */
export const repoChecks = (workdir: string): string[] => {
  const out: string[] = []
  const wf = path.join(workdir, ".github", "workflows")
  if (existsSync(wf))
    for (const f of readdirSync(wf).filter((n) => /\.ya?ml$/.test(n))) {
      const lines = readFileSync(path.join(wf, f), "utf8").split("\n")
      lines.forEach((l, i) => {
        const m = l.match(/^\s*(?:-\s*)?run:\s*(.*)$/)
        if (!m) return
        const inline = m[1]!.trim()
        if (inline && !/^[|>]/.test(inline)) out.push(inline)
        else {
          const indent = (lines[i + 1] ?? "").search(/\S/)
          if (indent > 0)
            for (let j = i + 1; j < lines.length && lines[j]!.search(/\S/) >= indent; j++)
              if (lines[j]!.trim()) out.push(lines[j]!.trim())
        }
      })
    }
  for (const doc of ["AGENTS.md", "CLAUDE.md"]) {
    const text = readOr(path.join(workdir, doc)) ?? ""
    for (const m of text.matchAll(/`([^`\n]{3,120})`/g))
      if (CHECK_WORDS.test(m[1]!) && /^[a-z]/.test(m[1]!) && m[1]!.includes(" ")) out.push(m[1]!)
  }
  return [...new Set(out.filter((c) => CHECK_WORDS.test(c) && !/^(echo|cd|export|if|fi|for|done)\b/.test(c)))].slice(
    0,
    12,
  )
}

// ---------- Risk tier ----------

export type Tier = "T0" | "T1" | "T2"
export type DiffFile = { path: string; added: number; removed: number }

const DOC = /(^|\/)(docs?\/|README|CHANGELOG|CONTRIBUTING|LICENSE)|\.(md|mdx|txt|rst)$/i
const SENSITIVE =
  /(auth|secret|token|password|credential|crypto|session|permission|cors|bind|listen|\.github\/|Dockerfile|compose\.ya?ml|(^|\/)scripts\/|\.sh$|mise\.toml|process-compose)/i
const DEPS =
  /(^|\/)(package(-lock)?\.json|bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|Cargo\.(toml|lock)|go\.(mod|sum)|requirements.*\.txt|pyproject\.toml|poetry\.lock|uv\.lock|Gemfile(\.lock)?)$/

export const parseNumstat = (text: string): DiffFile[] =>
  text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [a, r, ...p] = l.split("\t")
      return { path: p.join("\t"), added: Number(a) || 0, removed: Number(r) || 0 }
    })

export type Risk = {
  tier: Tier
  lines: number
  files: number
  reasons: string[]
  docsOnly: boolean
  touchesDeps: boolean
  touchesDocs: boolean
}

/** Tier from the diff alone: T0 docs-only and small, T2 large, sensitive paths or new dependencies, else T1. */
export const classify = (files: DiffFile[]): Risk => {
  const lines = files.reduce((n, f) => n + f.added + f.removed, 0)
  const docsOnly = files.length > 0 && files.every((f) => DOC.test(f.path))
  const touchesDeps = files.some((f) => DEPS.test(f.path))
  const sensitive = files.filter((f) => SENSITIVE.test(f.path)).map((f) => f.path)
  const reasons = [
    ...(lines > 400 ? [`${lines} changed lines (> 400)`] : []),
    ...(touchesDeps ? ["dependency manifest or lockfile changed"] : []),
    ...(sensitive.length ? [`sensitive paths: ${sensitive.slice(0, 5).join(", ")}`] : []),
  ]
  const tier: Tier = reasons.length ? "T2" : docsOnly && lines <= 20 ? "T0" : "T1"
  return {
    tier,
    lines,
    files: files.length,
    reasons,
    docsOnly,
    touchesDeps,
    touchesDocs: files.some((f) => DOC.test(f.path)),
  }
}

export const diffFiles = (workdir: string, base: string): DiffFile[] => {
  try {
    return parseNumstat(
      execFileSync("git", ["-C", workdir, "diff", "--numstat", base], { encoding: "utf8", maxBuffer: 8 << 20 }),
    )
  } catch {
    return []
  }
}

// ---------- Gates ----------

export type GateId = "design" | "testFirst" | "codeReview" | "supplyChain" | "docs" | "postMerge"
export type Phase = "plan" | "diff"
type GateDef = { id: GateId; phase: Phase; threshold: number; question: string }

/** Phase of each gate: code decides when a gate runs. [gates] in the config holds its threshold; prompts/gates/<id>.md
 *  its Jev question. */
const PHASES: Record<GateId, Phase> = {
  design: "plan",
  testFirst: "plan",
  codeReview: "diff",
  supplyChain: "diff",
  docs: "diff",
  postMerge: "diff",
}

/** Jev answers each question with a probability; at or above the threshold the gate runs. */
export const gateDefs = (c: FactoryConfig = factoryConfig()): GateDef[] =>
  (Object.keys(PHASES) as GateId[]).map((id) => ({
    id,
    phase: PHASES[id],
    threshold: c.gates[id],
    question: loadPrompt(`gates/${id}`),
  }))

export type GateStatus = "skipped" | "pending" | "running" | "done" | "failed"
export type Gate = {
  id: GateId
  chosen: boolean
  probability: number | null
  threshold: number
  reason: string
  status: GateStatus
  detail?: string
}

/** Floor: gates code turns on whatever Jev says. */
export const floorReason = (id: GateId, risk: Risk | null): string | null =>
  id === "codeReview" && risk?.tier === "T2"
    ? `floor: tier T2 (${risk.reasons.join("; ")})`
    : id === "supplyChain" && risk?.touchesDeps
      ? "floor: dependency change"
      : null

/** Turn Jev probabilities (or none, when Jev is unavailable) into gate decisions. No answer runs the gate (complete over fast). */
export const decide = (
  phase: Phase,
  probabilities: Record<string, number> | null,
  risk: Risk | null,
  jevError?: string,
  c: FactoryConfig = factoryConfig(),
): Gate[] =>
  gateDefs(c)
    .filter((g) => g.phase === phase)
    .map((g) => {
      const p = probabilities?.[g.id]
      const floor = floorReason(g.id, risk)
      const byJev = p !== undefined && p >= g.threshold
      const chosen = !!floor || byJev || p === undefined
      const reason =
        floor ??
        (p === undefined
          ? `${decisionLabel()} unavailable${jevError ? ` (${jevError})` : ""}; run (fail safe)`
          : `${decisionLabel()} ${p.toFixed(2)} ${byJev ? ">=" : "<"} ${g.threshold}`)
      return {
        id: g.id,
        chosen,
        probability: p ?? null,
        threshold: g.threshold,
        reason,
        status: chosen ? "pending" : "skipped",
      }
    })

/** One Jev call: a probability per gate of the phase. */
export const askGates = async (
  phase: Phase,
  state: Record<string, unknown>,
  c: FactoryConfig = factoryConfig(),
): Promise<{ probabilities: Record<string, number> | null; error?: string }> => {
  if (!decisionsAvailable()) return { probabilities: null, error: "no TYPESAFE_API_KEY" }
  try {
    const gates = gateDefs(c).filter((g) => g.phase === phase)
    const res = await systemOne({
      state: JSON.stringify(state),
      questions: Object.fromEntries(gates.map((g) => [g.id, noul(g.question)])),
    })
    const probabilities = Object.fromEntries(
      gates.flatMap((g) => {
        const p = res.answers?.[g.id]?.noul
        return typeof p === "number" ? [[g.id, p] as const] : []
      }),
    )
    for (const [id, p] of Object.entries(probabilities))
      recordCase({ prompt: `gates/${id}`, vars: {}, state: JSON.stringify(state), answer: p })
    return { probabilities }
  } catch (e) {
    return { probabilities: null, error: e instanceof Error ? e.message : String(e) }
  }
}

// ---------- Per-conversation state ----------

export type Sdlc = {
  scopeId: string
  threadId: string | null
  /** The user's request, as given to sdlc_plan. */
  request: string
  criteria: string[]
  checks: string[]
  risk: Risk | null
  gates: Gate[]
  /** Time the last implement worker finished, and the last verify worker after it. */
  implementDoneAt: number | null
  verifyDoneAt: number | null
  startedAt: number
  /** Metrics of the delivery. */
  workers: number
  findings: { kept: number; dropped: number }
  /** Commit the last code review covered; later implements re-review only what changed since, when it is large. */
  reviewedCommit: string | null
  /** Code review rounds run so far. */
  reviewRounds: number
  /** Model of the last implement worker; reviewers use the other family. */
  implementerModel: string | null
  /** Changed lines after the first implement; the scope check compares later diffs against it. */
  firstLines: number | null
  /** Set when the diff grew past twice the first implement and Jev judged the growth not needed. */
  scopeWarning: string | null
  /** Snapshot id of the factory config this delivery run pinned at sdlc_plan; later config edits apply to new runs. */
  configId?: string
  /** Snapshot id of the prompt files this run pinned at sdlc_plan ($SF_STATE_DIR/prompt-snapshots/). */
  promptsId?: string
}

export const newSdlc = (scopeId: string, threadId: string | null): Sdlc => ({
  scopeId,
  threadId,
  request: "",
  criteria: [],
  checks: [],
  risk: null,
  gates: [],
  implementDoneAt: null,
  verifyDoneAt: null,
  startedAt: Date.now(),
  workers: 0,
  findings: { kept: 0, dropped: 0 },
  reviewedCommit: null,
  reviewRounds: 0,
  implementerModel: null,
  firstLines: null,
  scopeWarning: null,
})

/** Lines changed since the last reviewed commit at or above this re-run the code review on those lines only. */
export const rereviewLines = (c: FactoryConfig = factoryConfig()) => c.review.rereview_lines
/** At most this many code review rounds per conversation; later changes get verify only. */
export const maxReviewRounds = (c: FactoryConfig = factoryConfig()) => c.review.max_rounds

/** Gate statuses a ship check settles: on-diff gates done when not blocked, postMerge waits for the merge. */
export const settleGates = (s: Sdlc, blockers: string[]): Sdlc => ({
  ...s,
  gates: s.gates.map((g) => {
    if (!g.chosen || g.status === "done" || g.status === "failed" || g.status === "running") return g
    if (g.id === "postMerge") return { ...g, status: "pending", detail: "runs after the human merges" }
    const blocked = blockers.some((b) => b.startsWith(`${g.id === "testFirst" ? "test-first" : g.id} gate`))
    return blocked ? g : { ...g, status: "done" }
  }),
})

/** Replace the gates of one phase; keep the others. */
export const withGates = (s: Sdlc, gates: Gate[]): Sdlc => ({
  ...s,
  gates: [...s.gates.filter((g) => !gates.some((n) => n.id === g.id)), ...gates],
})
export const gate = (s: Sdlc, id: GateId): Gate | undefined => s.gates.find((g) => g.id === id)
export const isOn = (s: Sdlc, id: GateId) => !!gate(s, id)?.chosen

/** Commits in base..HEAD, oldest first, with the files each changed. */
const commits = (workdir: string, base: string): { files: string[] }[] => {
  try {
    const out = execFileSync(
      "git",
      ["-C", workdir, "log", "--reverse", "--format=@@%H", "--name-only", `${base}..HEAD`],
      { encoding: "utf8", maxBuffer: 8 << 20 },
    )
    return out
      .split("@@")
      .filter((c) => c.trim())
      .map((c) => ({ files: c.split("\n").slice(1).filter(Boolean) }))
  } catch {
    return []
  }
}

const TEST = /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|_test\.(go|rs|py)$/i
export const isTestPath = (p: string): boolean => TEST.test(p)

/** Test-first: a commit that changes only tests comes before the first commit that changes other code. */
export const testsCameFirst = (history: { files: string[] }[]): boolean => {
  const code = (f: string) => !TEST.test(f) && !DOC.test(f)
  const firstCode = history.findIndex((c) => c.files.some(code))
  const firstTest = history.findIndex((c) => c.files.length > 0 && c.files.every((f) => TEST.test(f)))
  return firstTest !== -1 && (firstCode === -1 || firstTest < firstCode)
}

/**
 * Why the branch may not ship yet. Floors: criteria exist and each has PASS evidence; a verify ran after the last
 * implement; the security review is done. Chosen gates: design note, tests first, code review, supply chain, docs.
 */
export const shipBlockers = (
  s: Sdlc | undefined,
  workdir: string,
  base: string | undefined,
  securityDone: boolean,
  codeReviewDone: boolean,
): string[] => {
  if (!s) return ["no SDLC plan: call sdlc_plan with the acceptance criteria first"]
  const out: string[] = []
  const evidence = readOr(artifact(workdir, "evidence.md"))
  if (!s.criteria.length) out.push("no acceptance criteria (sdlc_plan)")
  const unproven = unprovenCriteria(s.criteria, evidence)
  if (unproven.length) out.push(`no PASS evidence in .factory/evidence.md for ${unproven.join(", ")}`)
  if (s.implementDoneAt === null) out.push("no implement step finished")
  else if (s.verifyDoneAt === null || s.verifyDoneAt < s.implementDoneAt)
    out.push("no verify step after the last implement")
  if (!securityDone) out.push("security review not done (it runs last, when everything else is ready)")
  if (isOn(s, "design") && !existsSync(artifact(workdir, "design.md")))
    out.push("design gate: .factory/design.md missing")
  if (isOn(s, "testFirst") && base && !testsCameFirst(commits(workdir, base)))
    out.push("test-first gate: no tests-only commit before the first code commit")
  if (isOn(s, "codeReview") && !codeReviewDone) out.push("code review gate not done")
  const sc = gate(s, "supplyChain")
  if (sc?.chosen && sc.status !== "done") out.push(`supply-chain gate ${sc.status}${sc.detail ? `: ${sc.detail}` : ""}`)
  if (isOn(s, "docs") && base && !diffFiles(workdir, base).some((f) => DOC.test(f.path)))
    out.push("docs gate: the diff changes no README, docs or CHANGELOG")
  return out
}

// ---------- Task additions (code appends them, so a prompt cannot forget them) ----------

export const implementAddendum = (s: Sdlc): string =>
  `\n\n${loadPrompt("tasks/implement-rules", {
    criteria: s.criteria.map((c, i) => `AC-${i + 1}: ${c}`).join("\n"),
    design: isOn(s, "design"),
    testFirst: isOn(s, "testFirst"),
    docs: isOn(s, "docs"),
    scopeWarning: s.scopeWarning ?? "",
  })}`

export const verifyAddendum = (s: Sdlc): string =>
  `\n\n${loadPrompt("tasks/verify-rules", {
    checks: s.checks.map((c) => `- \`${c}\``).join("\n"),
    criteria: s.criteria.map((c, i) => `AC-${i + 1}: ${c}`).join("\n"),
  })}`

/** PR body from the artifacts: criteria with ✓, tier, gates, evidence, rollback, how to try it. */
export const prBody = (s: Sdlc, workdir: string, summary: string): string => {
  const evidence = readOr(artifact(workdir, "evidence.md")) ?? ""
  const design = readOr(artifact(workdir, "design.md"))
  const unproven = new Set(unprovenCriteria(s.criteria, evidence))
  const rollback =
    design?.match(/#+\s*Rollback\s*\n([\s\S]*?)(\n#|$)/i)?.[1]?.trim() ?? "Revert this PR's merge commit."
  return [
    `## Summary\n${summary.trim()}`,
    `## Acceptance criteria\n${s.criteria.map((c, i) => `- [${unproven.has(`AC-${i + 1}`) ? " " : "x"}] AC-${i + 1}: ${c}`).join("\n")}`,
    `## Risk\nTier ${s.risk?.tier ?? "?"}${s.risk?.reasons.length ? `: ${s.risk.reasons.join("; ")}` : ""}`,
    `## Gates\n${s.gates.map((g) => `- ${g.id}: ${g.chosen ? g.status : "skipped"} (${g.reason})`).join("\n")}`,
    `## Evidence\n\`\`\`\n${evidence.trim().slice(0, 6000)}\n\`\`\``,
    `## Rollback\n${rollback}`,
    `## How to try it\nSee the evidence commands above.`,
  ].join("\n\n")
}

// ---------- Supply chain (no model: tools only) ----------

const LICENSES = [
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "0BSD",
  "Unlicense",
  "MPL-2.0",
  "Zlib",
  "CC0-1.0",
  "BSL-1.0",
  "Unicode-3.0",
  "Unicode-DFS-2016",
]

/** The checkout whose mise.toml pins the scanners (this repository). */
const TOOLS_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "../../../..")

/** Run a scanner pinned by this repository's mise.toml, in `cwd`. Exit 127: mise or the tool is missing. */
const run = (cmd: string, args: string[], cwd: string): Promise<{ code: number; out: string; stdout: string }> =>
  new Promise((resolve) =>
    execFile(
      "mise",
      ["-C", TOOLS_ROOT, "x", "--", cmd, ...args],
      { cwd, timeout: 300_000, maxBuffer: 32 << 20 },
      (err, stdout, stderr) =>
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 127) : 0,
          out: `${stdout}${stderr}`,
          stdout,
        }),
    ),
  )

/** Secrets in the branch's new commits (betterleaks), vulnerable or non-allowlisted-license packages in changed lockfiles (osv-scanner). */
export const supplyChainScan = async (workdir: string, base: string): Promise<{ ok: boolean; detail: string }> => {
  const problems: string[] = []
  const leaks = await run(
    "betterleaks",
    ["git", workdir, "--log-opts", `${base}..HEAD`, "--redact", "--no-banner", "--exit-code", "3"],
    workdir,
  )
  if (leaks.code === 127) return { ok: false, detail: "betterleaks not on PATH" }
  if (leaks.code === 3) problems.push("secret found in the new commits (betterleaks)")
  const lockfiles = diffFiles(workdir, base)
    .filter((f) => DEPS.test(f.path) && /lock|sum$/i.test(f.path))
    .map((f) => f.path)
  const preexisting: string[] = []
  for (const lf of lockfiles) {
    const head = await osvFlags(path.join(workdir, lf), workdir)
    if ("error" in head) {
      if (head.error === "not on PATH") return { ok: false, detail: "osv-scanner not on PATH" }
      problems.push(`${lf}: osv-scanner failed (${head.error})`)
      continue
    }
    // Only flags this branch adds fail the gate; flags already in the base's lockfile are listed, not blocking.
    const baseFile = baseLockfile(workdir, base, lf)
    const before = baseFile ? await osvFlags(baseFile, workdir) : { flags: new Set<string>() }
    const known = "flags" in before ? before.flags : new Set<string>()
    const added = [...head.flags].filter((x) => !known.has(x))
    preexisting.push(...[...head.flags].filter((x) => known.has(x)))
    if (added.length) problems.push(`${lf}: new flags (osv-scanner): ${added.join(", ")}`)
  }
  const note = preexisting.length
    ? `; ${preexisting.length} flag(s) already on ${base}, not blocking: ${preexisting.slice(0, 20).join(", ")}`
    : ""
  return problems.length
    ? { ok: false, detail: problems.join("; ") + note }
    : { ok: true, detail: `betterleaks clean; ${lockfiles.length} changed lockfile(s) scanned, no new flags${note}` }
}

type OsvReport = {
  results?: {
    packages?: {
      package?: { name?: string; version?: string }
      vulnerabilities?: { id: string }[]
      license_violations?: string[]
    }[]
  }[]
}

/** osv-scanner flags for one lockfile: `name@version: ID` per advisory, `name@version: license X` per license outside the allowlist. */
export const osvFlagsFrom = (report: OsvReport | null | undefined): Set<string> => {
  const flags = new Set<string>()
  for (const r of report?.results ?? [])
    for (const p of r.packages ?? []) {
      const id = `${p.package?.name}@${p.package?.version}`
      for (const v of p.vulnerabilities ?? []) flags.add(`${id}: ${v.id}`)
      for (const l of p.license_violations ?? []) flags.add(`${id}: license ${l}`)
    }
  return flags
}

const osvFlags = async (file: string, cwd: string): Promise<{ flags: Set<string> } | { error: string }> => {
  const osv = await run(
    "osv-scanner",
    ["scan", "source", "-L", file, `--licenses=${LICENSES.join(",")}`, "--format", "json"],
    cwd,
  )
  if (osv.code === 127) return { error: "not on PATH" }
  if (osv.code > 1) return { error: String(osv.code) }
  try {
    return { flags: osvFlagsFrom(JSON.parse(osv.stdout)) }
  } catch {
    return { error: "unreadable JSON" }
  }
}

/** The base's copy of a lockfile in a temp dir (same file name, so osv-scanner knows its type); null if the base has none. */
const baseLockfile = (workdir: string, base: string, lf: string): string | null => {
  try {
    const text = execFileSync("git", ["-C", workdir, "show", `${base}:${lf}`], {
      encoding: "utf8",
      maxBuffer: 64 << 20,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const dir = mkdtempSync(path.join(tmpdir(), "sf-base-lock-"))
    const file = path.join(dir, path.basename(lf))
    writeFileSync(file, text)
    return file
  } catch {
    return null
  }
}

// ---------- Lessons per repo folder ----------

export const lessonsFile = (root: string, folderId: string) => path.join(root, "lessons", `${folderId}.md`)
export const readLessons = (root: string, folderId: string): string[] =>
  (readOr(lessonsFile(root, folderId)) ?? "")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .map((l) => l.slice(2))

/** Add lessons (deduplicated), keep the newest 20. */
export const addLessons = (root: string, folderId: string, lessons: string[]): string[] => {
  const all = [...readLessons(root, folderId), ...lessons.map((l) => l.trim()).filter(Boolean)]
  const kept = [...new Set(all.reverse())].reverse().slice(-20)
  mkdirSync(path.dirname(lessonsFile(root, folderId)), { recursive: true })
  writeFileSync(lessonsFile(root, folderId), `${kept.map((l) => `- ${l}`).join("\n")}\n`)
  return kept
}
