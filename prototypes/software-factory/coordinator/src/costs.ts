// Cost of the factory's model calls: tokens, GitHub AI Credits (AIC) and US dollars, per agent, rolled up the
// agent tree (worker → sub-coordinator run → global).
// AIC follows Copilot: each call's `assistant.usage` carries `copilotUsage.totalNanoAiu`; 1e9 nano-AIU = 1 AIC.
// A call without it (Claude and Pi harness workers, a few Copilot calls) is priced from Copilot's own per-token
// rates for that model (`copilotUsage.tokenDetails` of the newest reported call), and marked estimated.

/** Copilot per-token rates of one model, nano-AIU per token, by token type (input, output, cache_read, cache_write). */
export type Rates = Record<string, number>

/** Token sums of one agent and model, split by whether Copilot reported their AIC. */
export type UsageRow = {
  worker: string
  model: string
  /** True: `nanoAiu` is Copilot's charge for these calls. False: no charge was reported; estimate it. */
  reported: boolean
  calls: number
  /** Copilot convention: includes the cached tokens. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  nanoAiu: number
}

export type Totals = {
  calls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalTokens: number
  /** AI Credits Copilot reported. */
  aicReported: number
  /** AI Credits estimated from tokens × Copilot's rates, for calls Copilot did not price. */
  aicEstimated: number
  aic: number
  usd: number
  /** Calls with no AIC and no known rate for their model: left out of `aic` and `usd`. */
  unpricedCalls: number
}

export type AgentInfo = {
  id: string
  name: string
  role: string
  owner: string
  step?: string | null
  harness?: string
}

export type AgentCost = AgentInfo & {
  /** This agent's own calls. */
  own: Totals
  /** This agent and every agent it started, directly or through others. */
  total: Totals
  byModel: Record<string, Totals>
  children: string[]
}

const NANO_PER_AIC = 1e9

/** Agent id under which direct model calls of the Goal page are stored; it hangs under the root (global only). */
export const GOAL_PAGE_AGENT = "goal-page"

export const zero = (): Totals => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  aicReported: 0,
  aicEstimated: 0,
  aic: 0,
  usd: 0,
  unpricedCalls: 0,
})

export const add = (a: Totals, b: Totals): Totals => {
  const out = zero()
  for (const k of Object.keys(out) as (keyof Totals)[]) out[k] = a[k] + b[k]
  return out
}

/** Copilot's charge for `r`'s tokens at `rates`, in nano-AIU; null when a needed rate is missing. */
export const estimateNano = (
  r: Omit<UsageRow, "worker" | "model" | "reported" | "calls" | "nanoAiu">,
  rates: Rates | undefined,
): number | null => {
  if (!rates) return null
  const parts: [string, number][] = [
    ["input", Math.max(0, r.inputTokens - r.cacheReadTokens - r.cacheWriteTokens)],
    ["cache_read", r.cacheReadTokens],
    ["cache_write", r.cacheWriteTokens],
    ["output", r.outputTokens],
  ]
  let nano = 0
  for (const [type, n] of parts) {
    if (!n) continue
    const rate = rates[type]
    if (rate === undefined) return null
    nano += n * rate
  }
  return nano
}

/** One usage row as totals: Copilot's AIC when reported, else the estimate. */
export const totalsOf = (r: UsageRow, rates: Rates | undefined, usdPerAic: number): Totals => {
  const t = zero()
  t.calls = r.calls
  t.inputTokens = r.inputTokens
  t.outputTokens = r.outputTokens
  t.cacheReadTokens = r.cacheReadTokens
  t.cacheWriteTokens = r.cacheWriteTokens
  t.totalTokens = r.inputTokens + r.outputTokens
  const est = r.reported ? null : estimateNano(r, rates)
  if (r.reported) t.aicReported = r.nanoAiu / NANO_PER_AIC
  else if (est === null) t.unpricedCalls = r.calls
  else t.aicEstimated = est / NANO_PER_AIC
  t.aic = t.aicReported + t.aicEstimated
  t.usd = t.aic * usdPerAic
  return t
}

/**
 * Per-agent cost with subtree roll-ups. `agents` gives names and owners; an agent with usage but no entry (or an
 * owner that is not an agent) hangs under `root`. Cycles in owners are cut.
 */
export const rollUp = (
  rows: UsageRow[],
  agents: AgentInfo[],
  rates: Record<string, Rates>,
  usdPerAic: number,
  root = "coordinator",
): Map<string, AgentCost> => {
  const out = new Map<string, AgentCost>()
  const node = (a: AgentInfo): AgentCost => ({
    ...a,
    own: zero(),
    total: zero(),
    byModel: {},
    children: [],
  })
  for (const a of agents) out.set(a.id, node(a))
  if (!out.has(root)) out.set(root, node({ id: root, name: root, role: "coordinator", owner: "" }))
  for (const r of rows) {
    const n =
      out.get(r.worker) ??
      out.set(r.worker, node({ id: r.worker, name: r.worker, role: "unknown", owner: root })).get(r.worker)!
    const t = totalsOf(r, rates[r.model], usdPerAic)
    n.own = add(n.own, t)
    n.byModel[r.model] = add(n.byModel[r.model] ?? zero(), t)
  }
  for (const n of out.values()) {
    if (n.id === root) continue
    const parent = out.get(n.owner) ? n.owner : root
    n.owner = parent
    out.get(parent)!.children.push(n.id)
  }
  const done = new Set<string>()
  const sum = (id: string, path: Set<string>): Totals => {
    const n = out.get(id)!
    if (done.has(id)) return n.total
    let t = n.own
    path.add(id)
    for (const c of n.children) if (!path.has(c)) t = add(t, sum(c, path))
    path.delete(id)
    n.total = t
    done.add(id)
    return t
  }
  sum(root, new Set())
  // Agents cut off by an owner cycle still get their own subtree sum.
  for (const id of out.keys()) if (!done.has(id)) sum(id, new Set())
  return out
}

/** Every agent under `id` (it included), in tree order. */
export const subtree = (costs: Map<string, AgentCost>, id: string): AgentCost[] => {
  const out: AgentCost[] = []
  const seen = new Set<string>()
  const walk = (x: string) => {
    const n = costs.get(x)
    if (!n || seen.has(x)) return
    seen.add(x)
    out.push(n)
    n.children.forEach(walk)
  }
  walk(id)
  return out
}

/** One sub-coordinator run: a repo conversation, its sub-coordinator and every agent under it. */
export type RunCost = {
  threadId: string
  title: string
  createdAt: number
  /** The sub-coordinator's agent id. */
  agent: string
  total: Totals
  /** Every agent of the run, sub-coordinator first; only in the one-run report. */
  agents?: Omit<AgentCost, "children">[]
}

export type CostReport = {
  usdPerAic: number
  global: Totals
  /** Direct model calls of the Goal page (in global, in no run). */
  goalPage: Totals
  runs: RunCost[]
}

type RunThread = { id: string; title: string; createdAt: number; worktree?: string }

const slim = (a: AgentCost): Omit<AgentCost, "children"> => {
  const { children, ...rest } = a
  void children
  return rest
}

/** One run's cost; `agents` lists every agent of it. Null when the thread is not a repo conversation. */
export const runCost = (
  costs: Map<string, AgentCost>,
  t: RunThread,
  agentOf: (threadId: string) => string,
  withAgents: boolean,
): RunCost | null => {
  if (!t.worktree) return null
  const agent = agentOf(t.id)
  const tree = subtree(costs, agent)
  return {
    threadId: t.id,
    title: t.title,
    createdAt: t.createdAt,
    agent,
    total: costs.get(agent)?.total ?? zero(),
    ...(withAgents ? { agents: tree.map(slim) } : {}),
  }
}

/** Global total and every sub-coordinator run, newest first. */
export const costReport = (
  costs: Map<string, AgentCost>,
  threads: RunThread[],
  agentOf: (threadId: string) => string,
  usdPerAic: number,
  root = "coordinator",
): CostReport => ({
  usdPerAic,
  global: costs.get(root)?.total ?? zero(),
  goalPage: costs.get(GOAL_PAGE_AGENT)?.total ?? zero(),
  runs: threads.flatMap((t) => runCost(costs, t, agentOf, false) ?? []).sort((a, b) => b.createdAt - a.createdAt),
})

const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)}k` : String(n))
/** `aic` with a `~` when part of it is an estimate, a `+?` when some calls could not be priced. */
const aicText = (t: Totals) => `${t.aicEstimated > 0 ? "~" : ""}${t.aic.toFixed(1)}${t.unpricedCalls ? "+?" : ""}`
const line = (label: string, t: Totals) =>
  `${label.padEnd(44).slice(0, 44)} ${`$${t.usd.toFixed(2)}`.padStart(9)} ${aicText(t).padStart(10)} ${tok(t.totalTokens).padStart(7)} ${tok(t.outputTokens).padStart(6)} ${String(t.calls).padStart(6)}`
const HEAD = `${"".padEnd(44)} ${"USD".padStart(9)} ${"AIC".padStart(10)} ${"tokens".padStart(7)} ${"out".padStart(6)} ${"calls".padStart(6)}`
const NOTE = "~ = includes AIC estimated from tokens at Copilot's rates; +? = calls with no known rate, left out"

/** The cost report as a text table: global, then one line per run. */
export const reportText = (r: CostReport): string =>
  [
    HEAD,
    line("GLOBAL (all agents)", r.global),
    line("Goal page", r.goalPage),
    ...r.runs.map((x) => line(`${x.threadId.slice(0, 8)} ${x.title}`, x.total)),
    NOTE,
  ].join("\n")

/** One run as a text table: the run, then each agent (own calls), indented by depth. */
export const runText = (r: RunCost): string => {
  const depth = new Map<string, number>([[r.agent, 0]])
  const rows = (r.agents ?? []).map((a) => {
    const d = a.id === r.agent ? 0 : (depth.get(a.owner) ?? 0) + 1
    depth.set(a.id, d)
    return line(`${"  ".repeat(d)}${a.name}${a.step ? ` [${a.step}]` : ""}`, a.own)
  })
  return [HEAD, line(`RUN ${r.title}`, r.total), ...rows, NOTE].join("\n")
}

type ChatUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
  completion_tokens_details?: { reasoning_tokens?: number }
}

/**
 * An OpenAI chat completion's usage as `assistant.usage` data (Copilot's shape). Copilot's own charge
 * (`copilot_usage.total_nano_aiu`) is kept when the reply carries it; otherwise costs.ts estimates it. Null: no usage.
 */
export const chatUsage = (
  model: string,
  reply: { usage?: ChatUsage; copilot_usage?: { total_nano_aiu?: number } },
): Record<string, unknown> | null => {
  const u = reply.usage
  if (!u) return null
  const nano = reply.copilot_usage?.total_nano_aiu
  return {
    model,
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: u.prompt_tokens_details?.cache_write_tokens ?? 0,
    reasoningTokens: u.completion_tokens_details?.reasoning_tokens ?? 0,
    ...(typeof nano === "number"
      ? { copilotUsage: { totalNanoAiu: nano }, aiCreditsStatus: "complete" }
      : { aiCreditsStatus: "unavailable" }),
  }
}
