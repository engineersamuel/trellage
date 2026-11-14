// Worker lifecycle: each worker is a separate agent process with its own home. A Claude model runs in the Claude
// Agent SDK; any other model in the Copilot SDK (a runtime over TCP). A step may name its own harness.
import type { Evaluation } from "./evaluate.ts"
import { deskShellFeedback, readOnlyViolation, subShellFeedback } from "./readonly.ts"
import { isolatedLauncher, reapRuntimes, recordRuntime, spawnIsolated } from "./isolate.ts"
import { factoryMcpServer, gateFromPermissions, MCP_SERVER, mcpToolNames } from "./claudetools.ts"
import { imageTool } from "./images.ts"
import { loadPrompt } from "./prompt.ts"
import { claudeMcp, copilotMcp, mcpNote, perplexityBudget, piMcp, stepMcp, type McpServer } from "./mcp.ts"
import type { CodeReview } from "./review.ts"
import type { Sdlc } from "./sdlc.ts"
import { type ChildProcess, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { homedir } from "node:os"
import {
  CopilotClient,
  RuntimeConnection,
  approveAll,
  type CopilotSession,
  type PermissionHandler,
  type SessionConfig,
  type SessionEvent,
  type Tool,
} from "@github/copilot-sdk"
import { Approvals, type ShipGrant } from "./approvals.ts"
import { EventStore } from "./events.ts"
import { freshTurn, type Turn } from "./report.ts"
import { forbiddenCommand } from "./guard.ts"
import type { SecurityReview } from "./security.ts"
import * as S from "./settings.ts"
import { appendCompact } from "../../shared/feed.ts"
import {
  ensureClones,
  harnessPrefix,
  prepareStepSkills,
  SKILL_REPOS,
  stepById,
  stepSetup,
  TOOL_REPOS,
  type HarnessSpec,
  type SkillCheck,
  type Step,
} from "./steps.ts"
import { claudeGate, ClaudeSession, composeClaude, type HarnessEvent } from "./claude.ts"
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk"
import { composePi, piBudgetFile, PiSession, usePiSubagentDir, withProxyModel } from "./pi.ts"
import { configStore, factoryConfig, missingProfiles, userConfigPath, type FactoryConfig } from "./config.ts"
import { decisionsAvailable, setDecisionEngine, systemOne } from "./decide.ts"
import { noul } from "@typesafe-ai/sdk"
import { acquireStateLock, migrateLegacyState, stateDir } from "./statedir.ts"
import { trackSubagent } from "./subagents.ts"

const LOG_CAP = 4000

export type Auth = "native" | "proxy"
export type Harness = "copilot" | "claude" | "pi"

/** What the factory needs from a live session, in every harness. */
export type Session = {
  send(prompt: string): Promise<unknown>
  abort(): Promise<void>
  disconnect(): Promise<void>
  setModel(model: string, options?: { reasoningEffort?: never }): Promise<void>
  /** Replace the tools this client supplies (Copilot SDK setTools; Claude: an MCP server for client tools). */
  setTools?(tools: Tool<Record<string, unknown>>[]): Promise<void>
}

/** How a worker got its model: Jev routing, set by the spawner, or the default (Jev unavailable or not asked). */
export type ModelSource =
  | { kind: "routed"; by: string; confidence: number }
  | { kind: "pinned" }
  | { kind: "fallback" }
  | { kind: "default" }

export type WorkerSummary = {
  id: string
  name: string
  role: string
  status: string
  auth: Auth
  harness: Harness
  model: string
  modelSource: ModelSource
  pid: number | null
  rssKb: number | null
  home: string
  task: string | null
  lastMessage: string | null
  eventCount: number
  contextTokens: number | null
  contextLimit: number | null
  /** Coordinator that started this agent. */
  owner: string
  /** SDLC step this agent runs, if any. */
  step: string | null
  /** Directory the agent works in (a conversation or run worktree); null before its session starts. */
  workdir: string | null
  /** When the factory started this agent (ms); gives the spawn order. */
  startedAt: number
  /** The gate this worker runs in, for the tree only (owner still decides stop, collect and cost). */
  group: GateGroup | null
  /** Subagents this agent started inside its own harness. */
  subagents: SubagentInfo[]
}

/**
 * A gate the factory code runs with several workers (code review, security review, evaluation). The tree shows it as
 * one node: under `after` (the implement worker whose finish started it) when set, else under the owner.
 */
export type GateGroup = { id: string; title: string; after: string | null }

/** A subagent an agent started inside its harness (Copilot task, Claude Agent, Pi subagent); id = the spawning tool call. */
export type SubagentInfo = { id: string; name: string; description: string; status: "running" | "done" | "failed" }

/** One event in the factory feed. `seq` is global so a client can resume. */
export type FeedEvent = {
  seq: number
  workerId: string
  type: string
  agentId: string | null
  timestamp: string
  data: unknown
}

export type SpawnSpec = {
  id?: string
  name: string
  role: string
  auth?: Auth
  model?: string
  task?: string
  system?: string
  tools?: Tool<Record<string, unknown>>[]
  permissions?: PermissionHandler
  /** SDLC step from the catalog; loads its skills and quality-gate tools. */
  step?: string
  /** Run in this harness instead of the step's (default: Copilot SDK). */
  harness?: HarnessSpec
  /** Working directory, e.g. a conversation's worktree. Default: the run worktree or the worker's own workspace. */
  workdir?: string
  /** Coordinator that started this worker; supervisor issues go to it. */
  owner?: string
  /** The gate this worker runs in; the tree groups it there. The owner keeps stop, collect, supervisor and cost. */
  group?: GateGroup
  /** Stable session id: resume this session (its memory) when it exists, else create it. */
  sessionId?: string
  /** Fired once when the worker goes idle after its initial task's work. */
  onDone?: (w: Worker) => void
  /** Open the session on this live worker's runtime instead of starting a new process (General chats). */
  shareRuntimeOf?: string
  /** The one conversation this agent serves; its answers are tagged with it. */
  threadId?: string
  /** Refuses a tool call with a reason (e.g. the Perplexity budget), in every SDK; null allows it. */
  toolGuard?: (toolName: string) => string | null
  /** The Perplexity limits behind toolGuard; Pi shares them with its subagent children through a file. */
  perplexityLimits?: { max: number; maxResearch: number }
}

export type WorkerSpec = {
  step: string | null
  workdir: string
  skills: { name: string; dir: string | null; healed: boolean }[]
  skillDirectories: string[]
  extraPath: string[]
  tools: string[]
  systemPrompt: string | null
  sessionId: string | null
}

/** One factory run: a git worktree of the target repo where every code worker writes. */
export type Run = {
  id: string
  repo: string
  worktree: string
  branch: string
  base: string
  dirty: boolean
}

type Listener<T> = (value: T) => void

/** Minimal broadcast channel: every subscriber gets every value. */
export class Channel<T> {
  private listeners = new Set<Listener<T>>()
  send(value: T) {
    for (const l of this.listeners) l(value)
  }
  subscribe(l: Listener<T>): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }
}

export const now = (): string => String(Date.now())

export class Worker {
  status = "idle"
  model: string
  modelSource: ModelSource = { kind: "default" }
  context: [number, number] | null = null
  lastMessage: string | null = null
  log: FeedEvent[] = []
  /** Handoff from the session this coordinator replaces (another SDK); sent once with the next message. */
  handoff: string | null = null
  /** Supervisor inputs: last event time, consecutive failed tool calls, last error, result read. */
  lastActivity = Date.now()
  readonly startedAt = Date.now()
  failedTools = 0
  /** Tool calls started and not finished (top level): a long build or test run, so the worker is not silent. */
  toolsInFlight = 0
  lastError: string | null = null
  collected = false
  owner = "coordinator"
  group: GateGroup | null = null
  subagents: SubagentInfo[] = []
  /** Pending onDone hook; armed by the first turn so an idle before the task starts does not fire it. */
  onDone: ((w: Worker) => void) | null = null
  private doneArmed = false
  /** Runtime shared with another worker: stop disconnects the session but leaves the process. */
  sharedRuntime = false
  /** The one conversation this agent serves (General chats); its answers are tagged with it. */
  threadId: string | null = null
  /** What the factory started this worker with; the UI's spec view adds what the runtime loaded. */
  spec: WorkerSpec | null = null
  readonly events = new Channel<SessionEvent>()
  session!: Session
  harness: Harness = "copilot"
  /** The session's own tools; AG-UI client tools are added to these for one run. */
  tools: Tool<Record<string, unknown>>[] = []
  /** Names of the client tools the session has now; "" when it has only its own. */
  clientToolKey = ""

  constructor(
    readonly id: string,
    readonly name: string,
    readonly role: string,
    readonly auth: Auth,
    readonly home: string,
    readonly task: string | null,
    readonly client: CopilotClient | ClaudeSession | PiSession,
    model: string,
  ) {
    this.model = model
  }

  /** The SDK owns the runtime child process; read its pid for the panel. */
  get pid(): number | null {
    return (this.client as unknown as { cliProcess?: { pid?: number } }).cliProcess?.pid ?? null
  }

  summary(): WorkerSummary {
    return {
      id: this.id,
      name: this.name,
      role: this.role,
      status: this.status,
      auth: this.auth,
      harness: this.harness,
      model: this.model,
      modelSource: this.modelSource,
      pid: this.pid,
      rssKb: this.pid === null ? null : rssKb(this.pid),
      home: this.home,
      task: this.task,
      lastMessage: this.lastMessage,
      eventCount: this.log.length,
      contextTokens: this.context?.[0] ?? null,
      contextLimit: this.context?.[1] ?? null,
      owner: this.owner,
      step: this.spec?.step ?? null,
      workdir: this.spec?.workdir ?? null,
      startedAt: this.startedAt,
      group: this.group,
      subagents: this.subagents,
    }
  }

  /** Mark running before sending so a reader never sees a stale "idle". */
  async send(prompt: string): Promise<void> {
    // The first message after an SDK switch carries the old session's handoff.
    if (this.handoff) {
      prompt = `${this.handoff}\n\n---\n\n${prompt}`
      this.handoff = null
    }
    this.status = "running"
    this.collected = false
    this.lastActivity = Date.now()
    await this.session.send(prompt)
  }

  observe(factory: Factory, ev: SessionEvent): void {
    let data = (ev as { data?: Record<string, unknown> }).data ?? {}
    // The global coordinator serves many conversations: tag each answer with the conversation of its turn.
    const tag = this.threadId ?? (this.id === "coordinator" ? factory.currentThread : null)
    if (ev.type === "assistant.message" && tag) data = { ...data, threadId: tag }
    const agentId = (ev as { agentId?: string }).agentId ?? null
    this.lastActivity = Date.now()
    this.observeToolResult(ev.type, agentId, data)
    const fe = factory.publish(this.id, ev.type, agentId, ev.timestamp, data)
    const subs = trackSubagent(this.subagents, ev.type, agentId, data, this.harness)
    if (subs) this.subagents = subs
    const changed = this.applyEventState(ev.type, agentId, data) || !!subs
    // Model-layer events are large and duplicate assistant.*; keep them out of the log.
    if (!ev.type.startsWith("model.")) this.persistEvent(fe)
    if (changed) factory.publish(this.id, "factory.worker_updated", null, now(), this.summary())
    this.settleDone(ev.type)
  }

  private observeToolResult(type: string, agentId: string | null, data: Record<string, unknown>): void {
    if (agentId !== null) return
    if (type === "tool.execution_start") this.toolsInFlight++
    if (type === "session.idle" || type === "session.error") this.toolsInFlight = 0
    if (type !== "tool.execution_complete") return
    this.toolsInFlight = Math.max(0, this.toolsInFlight - 1)
    this.failedTools = data.success === false ? this.failedTools + 1 : 0
    if (data.success === false)
      this.lastError = String((data.error as { message?: unknown } | null | undefined)?.message ?? "tool failed").slice(
        0,
        300,
      )
  }

  private applyEventState(type: string, agentId: string | null, data: Record<string, unknown>): boolean {
    switch (type) {
      case "assistant.turn_start":
      case "user.message":
        return this.setStatus("running")
      case "session.idle":
        return this.setStatus("idle")
      case "session.error":
        this.lastError = String(data.message ?? "session error").slice(0, 300)
        return this.setStatus("error")
      case "session.usage_info":
        if (typeof data.currentTokens === "number" && typeof data.tokenLimit === "number")
          this.context = [data.currentTokens, data.tokenLimit]
        return true
      case "assistant.message":
        if (data.content && agentId === null) this.lastMessage = data.content as string
        return false
      default:
        return false
    }
  }

  private setStatus(status: string): boolean {
    const changed = this.status !== status
    this.status = status
    return changed
  }

  /** The in-memory log the UI reads; the factory store keeps the durable copy. */
  private persistEvent(event: FeedEvent): void {
    appendCompact(this.log, event, LOG_CAP)
  }

  /** Arm onDone on the task's first turn; fire it once on the next idle. */
  private settleDone(type: string): void {
    if (!this.onDone) return
    if (type === "assistant.turn_start") this.doneArmed = true
    if (type !== "session.idle" || !this.doneArmed) return
    const done = this.onDone
    this.onDone = null
    done(this)
  }

  /** Wait until the worker is idle (or the timeout expires). */
  waitIdle(timeoutMs: number): Promise<boolean> {
    if (this.status !== "running") return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        off()
        resolve(false)
      }, timeoutMs)
      const off = this.events.subscribe((ev) => {
        // A session.error ends the turn too (a dead runtime sends no idle).
        if (ev.type === "session.idle" || (ev.type === "session.error" && this.status !== "running")) {
          clearTimeout(timer)
          off()
          resolve(true)
        }
      })
    })
  }

  /** Switch the live session's model and reasoning effort ("default" = model default). */
  async setModel(model: string, effort: string): Promise<void> {
    await this.session.setModel(model, effort === "default" ? undefined : { reasoningEffort: effort as never })
    this.model = model
  }
}

/** How long a coordinator that changes SDK may take to write its handoff summary. */
const HANDOFF_WAIT_MS = 120_000
const HANDOFF_MAX_CHARS = 16_000

const handoffFile = (root: string, id: string) => path.join(root, id, "handoff.md")

/** A saved handoff for this coordinator, read once (the file is removed). */
const takeHandoff = (root: string, id: string): string | null => {
  const file = handoffFile(root, id)
  if (!existsSync(file)) return null
  const text = readFileSync(file, "utf8")
  rmSync(file, { force: true })
  return text
}

/** The last turns of a coordinator's log as text: user and assistant messages, tool names. At most 16k chars. */
export const handoffTranscript = (log: readonly FeedEvent[], max = HANDOFF_MAX_CHARS): string => {
  const lines = log.flatMap((e) => {
    const d = (e.data ?? {}) as Record<string, unknown>
    if (e.type === "user.message" && typeof d.content === "string") return [`USER: ${d.content}`]
    if (e.type === "assistant.message" && e.agentId === null && typeof d.content === "string" && d.content)
      return [`YOU: ${d.content}`]
    if (e.type === "tool.execution_start" && e.agentId === null) return [`(tool ${String(d.toolName)})`]
    return []
  })
  const out: string[] = []
  let size = 0
  for (const line of lines.reverse()) {
    if (size + line.length > max) break
    out.unshift(line)
    size += line.length + 1
  }
  return out.join("\n")
}

/** How long a coordinator that changes SDK may finish its turn before it stops anyway. */
const SDK_MOVE_WAIT_MS = 30 * 60_000

const CLAUDE_DEFAULT: HarnessSpec = { kind: "claude", profiles: ["default"] }

/**
 * The harness a worker runs in. `auto`: the step's or the spawn's choice; else a Claude model runs in the Claude
 * Agent SDK, any other model in the Copilot SDK. A forced SDK applies to every worker; a step's own profiles
 * (e.g. council in Claude) are kept when the forced SDK matches.
 * Coordinators (desk, General chats, sub-coordinators) run in Claude with a Claude model, else in the Copilot SDK;
 * a repo sub-coordinator also moves to Claude when Claude is forced.
 */
export const workerHarness = (
  setting: string,
  role: string,
  chosen: HarnessSpec | undefined,
  gated = false,
  subCoordinator = false,
  model?: string,
): HarnessSpec | undefined => {
  const claudeModel = !!model && /^claude/.test(model)
  if (role !== "worker") return claudeModel || (subCoordinator && setting === "claude") ? CLAUDE_DEFAULT : chosen
  // A worker with its own Copilot permission gate (the finish worker's push gate) stays on the Copilot SDK.
  if (gated) return chosen
  if (setting === "auto") return chosen ?? (claudeModel ? CLAUDE_DEFAULT : undefined)
  if (setting === "copilot") return undefined
  const kind = setting as HarnessSpec["kind"]
  return chosen?.kind === kind ? chosen : { kind, profiles: kind === "claude" ? ["default"] : [] }
}

/** The Copilot runtime binary the SDK would start (its bundled runtime for its pinned version), resolved once. */
let runtimeBinary: Promise<string> | null = null
const runtimePath = (): Promise<string> =>
  (runtimeBinary ??= (async () => {
    if (process.env.COPILOT_CLI_PATH) return process.env.COPILOT_CLI_PATH
    // Not exported by the package; the same module the SDK's client uses to find its runtime.
    const dist = path.join(path.dirname(require.resolve("@github/copilot-sdk")), "..")
    const { ensureRuntimeBundle } = await import(path.join(dist, "runtimeArtifacts.js"))
    const { COPILOT_CLI_VERSION } = await import(path.join(dist, "cliVersion.js"))
    return ensureRuntimeBundle(COPILOT_CLI_VERSION)
  })())

/** The factory's stable session name as a Claude session UUID (deterministic, so a restart finds it). */
export const claudeSessionId = (name: string): string => {
  const h = new Bun.CryptoHasher("sha256").update(`sf-claude:${name}`).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Resume the coordinator's Claude session when its transcript exists, else start it under that id. */
export const claudeSessionOption = (configDir: string, name: string): { resume: string } | { sessionId: string } => {
  const id = claudeSessionId(name)
  const projects = path.join(configDir, "projects")
  const found =
    existsSync(projects) && readdirSync(projects).some((d) => existsSync(path.join(projects, d, `${id}.jsonl`)))
  return found ? { resume: id } : { sessionId: id }
}

/** A folder whose .claude/skills/ links the step's skill folders; Claude loads them under their own names. */
export const stepSkillDir = (dir: string, skills: { name: string; dir: string }[]): string => {
  const root = path.join(dir, ".claude", "skills")
  mkdirSync(root, { recursive: true })
  for (const s of skills) {
    const link = path.join(root, s.name)
    rmSync(link, { force: true, recursive: true })
    symlinkSync(s.dir, link)
  }
  return dir
}

export class Factory {
  readonly workers = new Map<string, Worker>()
  readonly feed = new Channel<FeedEvent>()
  private seq: number
  readonly root: string
  /** SQLite event store for every agent's log. */
  readonly store: EventStore
  /** Skill copies a skill-doctor worker fixed; preflight prefers them over the source. */
  readonly healRoot: string
  readonly defaultAuth: Auth
  readonly proxyUrl: string
  /** Worker model when routing gives none: SF_MODEL, else [models] worker in the factory config (read live). */
  get defaultModel(): string {
    return this.env.SF_MODEL ?? factoryConfig().models.worker
  }
  /** Stored settings (settings.json). Coordinator models are not stored here: see `settings`. */
  private stored: S.Settings
  /** The settings document. The coordinator models come from the factory config (one home: models.coordinator,
   *  models.sub_coordinator); a patch to them sets a config runtime override. */
  get settings(): S.Settings {
    const m = factoryConfig().models
    return {
      ...this.stored,
      agent: { ...this.stored.agent, model: m.coordinator },
      subAgent: { ...this.stored.subAgent, model: m.sub_coordinator },
    }
  }
  private readonly settingsFile: string
  /** Latest browser-side extension errors, keyed by "extension@ui". */
  readonly extensionErrors = new Map<string, unknown>()
  run: Run | null = null
  approvals!: Approvals
  /** Thread of the coordinator's current turn; approvals opened in that turn belong to it. */
  currentThread: string | null = null
  /** Latest Jev step decisions, newest last, from the event store, so they survive a restart. */
  get decisions(): unknown[] {
    return this.store.latest("factory.step_decided", 20)
  }
  readonly researchBatches = new Map<string, { workers: { id: string; workflow: string }[]; errors: string[] }>()
  /** Automatic security reviews by id. */
  readonly securityReviews = new Map<string, SecurityReview>()
  /** Code reviews (the codeReview gate) by id. */
  readonly codeReviews = new Map<string, CodeReview>()
  /** Independent acceptance evaluations (src/evaluate.ts) by id. */
  readonly evaluations = new Map<string, Evaluation>()
  /** SDLC state per sub-coordinator id: criteria, risk tier, gates. */
  readonly sdlc = new Map<string, Sdlc>()
  /** Sub-coordinator turns by worker id, for the report_up nudge. */
  readonly turns = new Map<string, Turn>()
  /** Last report sent per sub-coordinator, as "turn start|commit|status", so a repeat in the same turn is dropped. */
  readonly lastReports = new Map<string, string>()

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    this.root = stateDir(env)
    if (!env.SF_STATE_DIR) migrateLegacyState(this.root)
    // Before any file is opened: one coordinator per state folder.
    acquireStateLock(this.root)
    // Runtimes a previous coordinator on this folder left behind. Only this folder's: a test coordinator on a
    // scratch folder must not stop the live factory's runtimes.
    if (env.SF_DISABLE_STARTUP_CHILD_CLEANUP !== "1") reapRuntimes(this.root)
    this.healRoot = path.join(this.root, "skills-healed")
    mkdirSync(this.root, { recursive: true })
    this.store = new EventStore(path.join(this.root, "events.db"))
    this.store.importAll(this.root)
    this.seq = Math.max(Date.now() * 1000, this.store.maxSeq() + 1)
    this.defaultAuth = env.SF_AUTH === "proxy" ? "proxy" : "native"
    this.proxyUrl = env.SF_PROXY_URL ?? "http://localhost:8080/v1"
    this.settingsFile = S.settingsPath(this.root)
    this.stored = this.loadStored()
    setDecisionEngine(this.stored.decisions.engine, this.proxyUrl)
    this.approvals = new Approvals(this.root)
  }

  /** settings.json, once moved: coordinator models it still holds become config runtime overrides, so they keep
   *  applying, and the file stops storing them. */
  private loadStored(): S.Settings {
    const s = S.loadSettings(this.settingsFile)
    const raw = S.readStoredModels(this.settingsFile)
    const store = configStore()
    for (const [key, model] of [
      ["models.coordinator", raw.agent],
      ["models.sub_coordinator", raw.subAgent],
    ] as const) {
      if (!model || model === store.current.models[key === "models.coordinator" ? "coordinator" : "sub_coordinator"])
        continue
      try {
        store.setOverride(key, model)
        console.error(`factory config: moved ${key} = ${model} from settings.json to a runtime override`)
      } catch (e) {
        console.error(`factory config: could not move ${key} from settings.json: ${e}`)
      }
    }
    if (raw.agent !== undefined || raw.subAgent !== undefined) S.saveSettings(this.settingsFile, s)
    return s
  }

  get(id: string): Worker {
    const w = this.workers.get(id)
    if (!w) throw new Error(`unknown worker ${id}`)
    return w
  }

  turn(id: string): Turn {
    const t = this.turns.get(id) ?? freshTurn(Date.now())
    this.turns.set(id, t)
    return t
  }

  summaries(): WorkerSummary[] {
    return [...this.workers.values()]
      .map((w) => w.summary())
      .sort((a, b) => (a.role === "coordinator" ? -1 : b.role === "coordinator" ? 1 : a.name.localeCompare(b.name)))
  }

  publish(workerId: string, type: string, agentId: string | null, timestamp: string, data: unknown): FeedEvent {
    const ev = { seq: this.seq++, workerId, type, agentId, timestamp, data }
    this.store.append(ev)
    this.feed.send(ev)
    return ev
  }

  /** Spawn an isolated runtime process, connect to it, and open one session. */
  async spawn(spec: SpawnSpec): Promise<Worker> {
    const id = spec.id ?? `w-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`
    let auth = spec.auth ?? this.defaultAuth
    const home = path.join(this.root, id)
    const step = spec.step ? stepById(spec.step) : null
    const missing = step ? missingProfiles(step.id, step.harness) : []
    if (missing.length) throw new Error(`refused: ${missing.join("; ")}`)
    const mcp = stepMcp(step?.mcp ?? [])
    const note = mcpNote(mcp)
    if (note && spec.task) spec = { ...spec, task: `${spec.task}\n\n${note}` }
    if (mcp.servers.perplexity) {
      const limits = factoryConfig().mcp
      const [max, maxResearch] = [limits.perplexity_max_calls, limits.perplexity_research_max_calls]
      spec = { ...spec, toolGuard: perplexityBudget(max, maxResearch), perplexityLimits: { max, maxResearch } }
    }
    // Skill preflight runs first, so a worker with an unusable skill fails before any model call.
    const { workdir, setup, skills } = this.prepareSpawn(spec, id, home, step)
    const setting = this.settings.workers.harness
    const chosen = spec.harness ?? step?.harness
    // With no harness chosen, the worker's model (pinned, routed or default) decides the SDK: route it first.
    const routed = spec.role === "worker" && !chosen && setting === "auto" ? await this.spawnModel(spec) : null
    const harness = workerHarness(
      setting,
      spec.role,
      chosen,
      spec.role === "worker" && !!spec.permissions,
      id.startsWith("sub-"),
      routed?.model ?? spec.model,
    )
    if (harness) {
      const pinned = routed ? { ...spec, model: routed.model } : spec
      return this.spawnHarness(pinned, id, home, workdir, harness, skills, routed?.source, mcp.servers)
    }
    const { model, source } = routed ?? (await this.spawnModel(spec))
    // A worker model the native Copilot runtime does not serve goes through copilot-proxy-rs (BYOK).
    if (spec.role === "worker" && auth === "native" && !(await this.nativeServes(model))) auth = "proxy"
    const host = spec.shareRuntimeOf ? this.workers.get(spec.shareRuntimeOf) : undefined
    if (host && !(host.client instanceof CopilotClient))
      throw new Error(`cannot share the runtime of ${host.id}: not a Copilot runtime`)
    const client = host ? (host.client as CopilotClient) : await this.startClient(home, workdir, auth, setup)
    const worker = new Worker(id, spec.name, spec.role, auth, home, spec.task ?? null, client, model)
    worker.modelSource = source
    this.configureWorker(worker, spec)
    worker.spec = {
      step: step?.id ?? null,
      workdir,
      skills: skills.map(({ name, dir, healed }) => ({ name, dir, healed })),
      skillDirectories: setup.skillDirectories,
      extraPath: setup.extraPath,
      tools: (spec.tools ?? []).map((t) => t.name),
      systemPrompt: spec.system ? `${spec.system.length} chars appended` : null,
      sessionId: spec.sessionId ?? null,
    }
    worker.session = await this.openSession(
      client,
      spec,
      this.sessionConfig(spec, worker, model, workdir, setup, auth, mcp.servers),
    )
    const prefix = setup.prefix
    return this.register(worker, spec.task && (prefix ? `${prefix}\n\n${spec.task}` : spec.task))
  }

  /** A Claude Agent SDK or Pi SDK worker with trx-composed profiles; the task runs through the profile's entry command. */
  private async spawnHarness(
    spec: SpawnSpec,
    id: string,
    home: string,
    workdir: string,
    harness: HarnessSpec,
    skills: SkillCheck[] = [],
    source?: ModelSource,
    mcp: Record<string, McpServer> = {},
  ): Promise<Worker> {
    let worker: Worker | undefined
    const emit = (ev: HarnessEvent) => {
      worker?.observe(this, ev as SessionEvent)
      worker?.events.send(ev as SessionEvent)
    }
    const stepSkills = skills.flatMap((s) => (s.dir ? [{ name: s.name, dir: s.dir }] : []))
    const { session, model, loaded } =
      harness.kind === "claude"
        ? await this.claudeSession(
            spec,
            workdir,
            harness,
            emit,
            stepSkills,
            home,
            await this.subagentModel(spec, spec.step ? stepById(spec.step) : null),
            mcp,
          )
        : await this.piSession(spec, workdir, harness, emit, stepSkills, mcp)
    worker = new Worker(
      id,
      spec.name,
      spec.role,
      spec.auth ?? this.defaultAuth,
      home,
      spec.task ?? null,
      session,
      model,
    )
    worker.harness = harness.kind
    if (source) worker.modelSource = source
    else if (spec.model) worker.modelSource = { kind: "pinned" }
    worker.session = session
    this.configureWorker(worker, spec)
    worker.spec = {
      step: spec.step ?? null,
      workdir,
      skills: skills.map(({ name, dir, healed }) => ({ name, dir, healed })),
      skillDirectories: [],
      extraPath: [],
      tools: [],
      systemPrompt: `${harness.kind} ${harness.profiles.join("+")}; ${loaded}`,
      sessionId: null,
    }
    // The step's prefix ("Use the ub-mode skill.") applies in every SDK, not only Copilot.
    const prefix = harnessPrefix(
      skills.map((s) => s.name),
      spec.step ? stepById(spec.step) : null,
    )
    const task = spec.task && (prefix ? `${prefix}\n\n${spec.task}` : spec.task)
    return this.register(worker, task && (harness.entry ? `${harness.entry} ${task}` : task))
  }

  private async claudeSession(
    spec: SpawnSpec,
    workdir: string,
    harness: HarnessSpec,
    emit: (ev: HarnessEvent) => void,
    stepSkills: { name: string; dir: string }[] = [],
    home = workdir,
    subagent: string | null = null,
    mcp: Record<string, McpServer> = {},
  ) {
    const launch = await composeClaude(harness.profiles, workdir)
    // Skills ask for `model: "sonnet"` subagents; the alias resolves to this model.
    if (subagent) launch.env.ANTHROPIC_DEFAULT_SONNET_MODEL = subagent
    const claudeServers = claudeMcp(mcp)
    // The step's skills (ub-mode, security-audit, ...) load under their own names, as in a Copilot worker:
    // a .claude/skills folder in the worker's home, added as a working directory (a plugin would prefix them).
    const skillRoot = stepSkills.length ? stepSkillDir(path.join(home, "step-skills"), stepSkills) : null
    // Claude SDK prefers Anthropic models; an explicit model (reviewers use another family on purpose) wins.
    const model =
      spec.model ??
      launch.model ??
      (/^claude/.test(this.defaultModel) ? this.defaultModel : factoryConfig().models.claude_worker)
    // A coordinator's factory tools, or a worker's generate_image: an in-process MCP server either way.
    const tools = this.sessionTools(spec, workdir)
    const session = new ClaudeSession(
      {
        cwd: workdir,
        env: { ...launch.env, ...claudeServers.env },
        plugins: launch.plugins.map((p) => ({ type: "local" as const, path: p })),
        ...(skillRoot ? { additionalDirectories: [skillRoot] } : {}),
        model,
        ...(launch.effort ? { effort: launch.effort as never } : {}),
        // default mode, so every permission prompt goes through the factory gate; bypassPermissions skips canUseTool.
        permissionMode: "default",
        canUseTool: withToolGuard(
          spec.toolGuard,
          spec.permissions ? gateFromPermissions(spec.permissions) : claudeGate,
        ),
        disallowedTools: ["AskUserQuestion"],
        // Its tools (above) and its role prompt after Claude Code's. A step's MCP servers (src/mcp.ts) join them.
        ...(tools.length || Object.keys(mcp).length
          ? {
              mcpServers: {
                ...claudeServers.config,
                ...(tools.length ? { [MCP_SERVER]: factoryMcpServer(tools) } : {}),
              },
              ...(tools.length ? { allowedTools: mcpToolNames(tools) } : {}),
            }
          : {}),
        ...(spec.system
          ? {
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: spec.system,
              },
            }
          : {}),
        // A coordinator keeps its memory across restarts (Claude session ids are UUIDs).
        ...(spec.sessionId
          ? claudeSessionOption(launch.env.CLAUDE_CONFIG_DIR ?? path.join(homedir(), ".claude"), spec.sessionId)
          : {}),
        // Text and thinking stream to the feed as deltas, like Copilot workers.
        includePartialMessages: true,
        // Own process group, like Copilot runtimes (src/isolate.ts).
        spawnClaudeCodeProcess: spawnIsolated as never,
      },
      emit,
      {
        ownTools: tools.map((t) => t.name),
        // A crashed Claude process ends its workers like a Copilot runtime exit (the desk then restarts the service).
        onExit: (message) => this.runtimeExited(session, `claude process exited (${message})`),
      },
    )
    return {
      session,
      model,
      loaded: `plugins ${launch.plugins.map((p) => path.basename(p)).join(", ")}`,
    }
  }

  private async piSession(
    spec: SpawnSpec,
    workdir: string,
    harness: HarnessSpec,
    emit: (ev: HarnessEvent) => void,
    stepSkills: { name: string; dir: string }[] = [],
    mcp: Record<string, McpServer> = {},
  ) {
    const launch = await composePi(harness.profiles, workdir)
    launch.skills.push(...stepSkills.map((s) => s.dir))
    // A pinned model (e.g. a Gemini reviewer) is added to the proxy provider in this worker's own agent dir.
    const ready = spec.model
      ? withProxyModel(launch, spec.model, path.join(this.root, "pi-agents", crypto.randomUUID().slice(0, 8)))
      : launch
    const servers = piMcp(mcp)
    usePiSubagentDir(ready, servers, path.join(this.root, "pi-subagent-dir"))
    // Pi children run outside this process's guard, so the parent and every child count in one budget file.
    const budget = spec.perplexityLimits
      ? piBudgetFile(
          path.join(this.root, "pi-budgets", `${crypto.randomUUID().slice(0, 8)}.json`),
          spec.perplexityLimits,
        )
      : undefined
    const session = await PiSession.start(ready, workdir, emit, servers, budget)
    return {
      session,
      model: session.model,
      loaded: `skills ${launch.skills.map((p) => path.basename(p)).join(", ")}`,
    }
  }

  private async spawnModel(spec: SpawnSpec): Promise<{ model: string; source: ModelSource }> {
    if (spec.model) return { model: spec.model, source: { kind: "pinned" } }
    if (spec.role !== "worker" || !spec.task) return { model: this.defaultModel, source: { kind: "default" } }
    const { small_model, small_threshold } = factoryConfig().routing
    const low = await this.lowComplexity(spec.task)
    if (low && !low.ui && low.p >= small_threshold) {
      this.publish("coordinator", "factory.model_routed", null, now(), {
        worker: spec.name,
        id: small_model,
        confidence: low.p,
        routedBy: "jev-low-complexity",
        ranked: [small_model],
      })
      return { model: small_model, source: { kind: "routed", by: "jev-low-complexity", confidence: low.p } }
    }
    const routed = await this.routeModel(spec.task)
    if (!routed) return { model: this.defaultModel, source: { kind: "fallback" } }
    this.publish("coordinator", "factory.model_routed", null, now(), {
      worker: spec.name,
      ...routed,
    })
    return {
      model: routed.id,
      source: { kind: "routed", by: routed.routedBy, confidence: routed.confidence },
    }
  }

  /**
   * Jev: how likely the task is low-complexity (prompts/jev/low-complexity.md), and whether it is a UI task (the proxy
   * router sends UI work to Opus, so the small model must not take it). Null when no decision engine answers.
   */
  async lowComplexity(task: string): Promise<{ p: number; ui: boolean } | null> {
    if (!decisionsAvailable()) return null
    try {
      const res = await systemOne({
        state: task.slice(0, 16_000),
        questions: { low: noul(loadPrompt("jev/low-complexity")), ui: noul(loadPrompt("jev/ui-task")) },
      })
      const [p, ui] = [res.answers?.low?.noul, res.answers?.ui?.noul]
      return typeof p === "number" ? { p, ui: typeof ui !== "number" || ui >= 0.5 } : null
    } catch {
      return null
    }
  }

  /** The step's subagent model: Jev's pick for the step's short subagent text (a whole task hides it), or null. */
  async subagentModel(spec: SpawnSpec, step: Step | null): Promise<string | null> {
    if (!step?.subagentRoute) return null
    const routed = await this.routeModel(step.subagentRoute)
    // Claude Code sends `thinking` to subagents; Copilot rejects it for some models (claude-haiku-5.5), so take
    // the first model in Jev's ranking that accepts it.
    for (const id of routed?.ranked.slice(0, 4) ?? []) {
      if (!(await this.acceptsThinking(id))) continue
      this.publish("coordinator", "factory.model_routed", null, now(), {
        worker: spec.name,
        subagents: true,
        ...routed,
        id,
      })
      return id
    }
    return null
  }

  /** One tiny Messages call through the proxy with `thinking` on, as a Claude Code subagent sends it. */
  async acceptsThinking(model: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.proxyUrl}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "factory", "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model,
          max_tokens: 2048,
          thinking: { type: "enabled", budget_tokens: 1024 },
          messages: [{ role: "user", content: "ok" }],
        }),
        signal: AbortSignal.timeout(30_000),
      })
      return res.ok
    } catch {
      return false
    }
  }

  private prepareSpawn(spec: SpawnSpec, id: string, home: string, step: ReturnType<typeof stepById> | null) {
    // Workers write in the run worktree when a target repo is set; the coordinator never does.
    const workdir =
      spec.workdir ??
      (spec.role === "worker" && this.settings.repo ? this.ensureRun().worktree : path.join(home, "workspace"))
    mkdirSync(workdir, { recursive: true })
    const skillRoot = path.join(this.root, "skills")
    const toolRoot = path.join(this.root, "tools")
    const setup = stepSetup(step, skillRoot, toolRoot)
    // Skills shipped with the factory need no clone.
    if (setup.skillDirectories.some((d) => d.startsWith(skillRoot))) ensureClones(skillRoot, SKILL_REPOS)
    if (setup.extraPath.length) ensureClones(toolRoot, TOOL_REPOS)
    if (!step || !setup.skillDirectories.length) return { workdir, setup, skills: [] as SkillCheck[] }
    // Only the step's own skills load: link them into the worker's home, healed copies first.
    const stepDir = path.join(home, "skills")
    const skills = prepareStepSkills(setup.skillDirectories, this.healRoot, stepDir, step)
    return { workdir, setup: { ...setup, skillDirectories: [stepDir] }, skills }
  }

  private async startClient(home: string, workdir: string, auth: Auth, setup: ReturnType<typeof stepSetup>) {
    const client = new CopilotClient({
      // Own process group: a group kill in a worker's tool tree cannot reach the coordinator.
      connection: RuntimeConnection.forTcp({
        port: 0,
        path: isolatedLauncher(path.join(this.root, "bin"), await runtimePath()),
      }),
      baseDirectory: home,
      workingDirectory: workdir,
      ...(auth === "native" ? { gitHubToken: githubToken() } : {}),
      useLoggedInUser: false,
      logLevel: "error",
      ...(setup.extraPath.length
        ? { env: { ...process.env, PATH: [...setup.extraPath, process.env.PATH].join(":") } }
        : {}),
    })
    await client.start()
    const proc = (client as unknown as { cliProcess?: ChildProcess }).cliProcess
    if (proc?.pid) recordRuntime(this.root, proc.pid)
    proc?.once("exit", (code, signal) => this.runtimeExited(client, `runtime exited (${signal ?? `code ${code}`})`))
    return client
  }

  /** Called with the ids of the workers whose runtime exited without a stop. */
  onRuntimeExit: ((ids: string[]) => void) | null = null

  /**
   * A runtime exited that no stop asked for (killed or crashed): every worker on it ends its turn with a
   * session.error, so waiters and the UI stop showing it as running, and it is unregistered so the next message
   * starts it again. A stopped worker is already unregistered, so a normal stop does not come here.
   */
  runtimeExited(client: unknown, message: string): void {
    const dead = [...this.workers.values()].filter((w) => w.client === client)
    for (const w of dead) {
      const ev = {
        type: "session.error",
        timestamp: new Date().toISOString(),
        data: { message },
      } as SessionEvent
      w.observe(this, ev)
      w.events.send(ev)
      this.workers.delete(w.id)
      this.publish(w.id, "factory.worker_stopped", null, now(), { id: w.id, reason: message })
    }
    if (dead.length) this.onRuntimeExit?.(dead.map((w) => w.id))
  }

  private configureWorker(worker: Worker, spec: SpawnSpec): void {
    if (spec.owner) worker.owner = spec.owner
    if (spec.group) worker.group = spec.group
    worker.tools = spec.tools ?? []
    worker.log = this.store.load(worker.id, LOG_CAP, worker.home)
    if (spec.onDone) worker.onDone = spec.onDone
    if (spec.shareRuntimeOf) worker.sharedRuntime = true
    if (spec.threadId) worker.threadId = spec.threadId
  }

  /** A session's own tools: the spec's, plus generate_image for every worker. */
  private sessionTools(spec: SpawnSpec, workdir: string): Tool<Record<string, unknown>>[] {
    const own = (spec.tools ?? []) as Tool<Record<string, unknown>>[]
    return spec.role === "worker" ? [...own, imageTool(this.proxyUrl, workdir)] : own
  }

  private sessionConfig(
    spec: SpawnSpec,
    worker: Worker,
    model: string,
    workdir: string,
    setup: ReturnType<typeof stepSetup>,
    auth: Auth,
    mcp: Record<string, McpServer> = {},
  ): SessionConfig {
    return {
      onPermissionRequest: spec.permissions ?? workerPermissions,
      ...(spec.toolGuard ? { hooks: { onPreToolUse: copilotToolGuard(spec.toolGuard) } } : {}),
      streaming: true,
      model,
      workingDirectory: workdir,
      tools: this.sessionTools(spec, workdir),
      ...(setup.skillDirectories.length ? { skillDirectories: setup.skillDirectories } : {}),
      ...(Object.keys(mcp).length ? { mcpServers: copilotMcp(mcp) } : {}),
      // Registered before session.create so no startup event is lost.
      onEvent: (ev) => {
        worker.observe(this, ev)
        worker.events.send(ev)
      },
      ...(spec.system ? { systemMessage: { mode: "append" as const, content: spec.system } } : {}),
      ...(auth === "proxy"
        ? {
            provider: {
              type: "openai" as const,
              baseUrl: this.proxyUrl,
              apiKey: "copilot-proxy-rs",
            },
          }
        : {}),
    } satisfies SessionConfig
  }

  private async openSession(client: CopilotClient, spec: SpawnSpec, config: SessionConfig): Promise<CopilotSession> {
    // A coordinator keeps its memory across restarts: its session state lives in `home`.
    if (!spec.sessionId) return client.createSession(config)
    return client
      .resumeSession(spec.sessionId, config)
      .catch(() => client.createSession({ ...config, sessionId: spec.sessionId! }))
  }

  /** Register a started worker and send its first prompt. A worker whose prompt fails is stopped, and the error rethrown. */
  async register(worker: Worker, prompt?: string | null): Promise<Worker> {
    if (worker.role === "coordinator") worker.handoff = takeHandoff(this.root, worker.id)
    this.workers.set(worker.id, worker)
    this.publish(worker.id, "factory.worker_started", null, now(), worker.summary())
    if (!prompt) return worker
    try {
      await worker.send(prompt)
    } catch (e) {
      await this.stop(worker.id).catch(() => {})
      throw e
    }
    return worker
  }

  /**
   * Ask copilot-proxy-rs (`POST /v1/models`, Jev) which model fits a task. Returns null when the
   * proxy is down or its pick is not a model this worker's auth can use.
   */
  /** A Copilot client only for the model list, when the desk runs in another SDK. Started on first use. */
  private modelClient: Promise<CopilotClient> | null = null

  /** Models the native Copilot runtime serves: from the desk's runtime, else from a small client of its own. */
  async copilotModels(): Promise<string[]> {
    const desk = this.workers.get("coordinator")?.client
    const client =
      desk instanceof CopilotClient
        ? desk
        : await (this.modelClient ??= (() => {
            const home = path.join(this.root, "model-list")
            mkdirSync(home, { recursive: true })
            const setup = stepSetup(null, path.join(this.root, "skills"), path.join(this.root, "tools"))
            return this.startClient(home, home, "native", setup).catch((e) => {
              this.modelClient = null
              throw e
            })
          })())
    return (await client.listModels()).map((m) => m.id)
  }

  /** Whether the native Copilot runtime serves this model. Unknown (list failed) counts as served. */
  private async nativeServes(model: string): Promise<boolean> {
    try {
      return (await this.copilotModels()).includes(model)
    } catch {
      return true
    }
  }

  async routeModel(
    task: string,
  ): Promise<{ id: string; confidence: number; routedBy: string; ranked: string[] } | null> {
    try {
      const res = await fetch(`${this.proxyUrl}/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Agents need a chat model: copilot-proxy-rs routes only between models of this type (#69).
        body: JSON.stringify({ input: task.slice(0, 16_000), type: "chat" }),
        signal: AbortSignal.timeout(25_000),
      })
      if (!res.ok) return null
      const r = (await res.json()) as {
        recommended?: { id?: string } | null
        ranking?: { id?: string }[] | null
        confidence?: number
        routed_by: string
      }
      // copilot-proxy-rs GET /v1/models is the authoritative list: Jev chose among it, so its pick stands. A model
      // the native Copilot runtime does not serve (e.g. gemini-4-argon) runs over proxy auth (see spawn).
      const ranked = [
        ...new Set([r.recommended?.id, ...(r.ranking ?? []).map((x) => x.id)].filter(Boolean) as string[]),
      ]
      const id = ranked[0]
      return id ? { id, confidence: r.confidence ?? 0, routedBy: r.routed_by, ranked } : null
    } catch {
      return null
    }
  }

  /** Create the run worktree for the target repo once. Idempotent; a new repo starts a new run. */
  ensureRun(): Run {
    const repo = this.settings.repo
    if (this.run?.repo === repo) return this.run
    const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim()
    const top = git("rev-parse", "--show-toplevel")
    const id = `run-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}`
    const worktree = path.join(this.root, "runs", id)
    const branch = `factory/${id}`
    const base = git("rev-parse", "HEAD")
    const dirty = git("status", "--porcelain") !== ""
    execFileSync("git", ["-C", top, "worktree", "add", "-q", "-b", branch, worktree, base])
    this.run = { id, repo: top, worktree, branch, base, dirty }
    this.publish("coordinator", "factory.run_started", null, now(), this.run)
    return this.run
  }

  /** Settings plus what a client needs to render controls for them. */
  async settingsView() {
    let models: string[] = []
    try {
      models = await this.copilotModels()
    } catch {}
    return {
      settings: this.settings,
      css: S.css(this.settings),
      run: this.run,
      options: {
        navbarItems: S.NAVBAR_ITEMS,
        hotkeyActions: S.HOTKEY_ACTIONS,
        efforts: S.EFFORTS,
        toolKinds: S.TOOL_KINDS,
        slots: S.SLOTS,
        models,
      },
    }
  }

  private settingsQueue: Promise<unknown> = Promise.resolve()

  /** Apply a merge patch from the UI or the agent, run side effects, persist, broadcast. Serialized. */
  updateSettings(patch: unknown): Promise<S.Settings> {
    const run = this.settingsQueue.then(() => this.applySettings(patch))
    this.settingsQueue = run.catch(() => {})
    return run
  }

  private async applySettings(patch: unknown): Promise<S.Settings> {
    const prev = this.settings
    const next = S.patched(prev, patch)
    this.validateRepoChange(prev, next)
    await this.applyModelChange(prev, next)
    // Coordinator models live in the factory config: a change is a runtime override there.
    const store = configStore()
    if (next.agent.model !== prev.agent.model) store.setOverride("models.coordinator", next.agent.model)
    if (next.subAgent.model !== prev.subAgent.model) store.setOverride("models.sub_coordinator", next.subAgent.model)
    // Code changed: old error reports no longer apply.
    this.clearChangedExtensionErrors(prev, next)
    this.stored = next
    setDecisionEngine(next.decisions.engine)
    S.saveSettings(this.settingsFile, next)
    this.publishSettings()
    return this.settings
  }

  /** Tell every open UI the settings changed (also after a config change moved a coordinator model). */
  publishSettings(): void {
    const s = this.settings
    this.publish("coordinator", "factory.settings_updated", null, now(), {
      settings: s,
      css: S.css(s),
    })
  }

  private validateRepoChange(prev: S.Settings, next: S.Settings): void {
    if (next.repo === prev.repo || next.repo === "") return
    try {
      execFileSync("git", ["-C", next.repo, "rev-parse", "--git-dir"], { stdio: "ignore" })
    } catch {
      throw new Error(`repo: '${next.repo}' is not a git repository`)
    }
    this.run = null
  }

  /** After any config change: switch live coordinators whose model changed, and tell the UIs. Never throws. */
  async onConfigChanged(): Promise<void> {
    const next = this.settings
    const live = [...this.workers.values()].filter((w) => w.role === "coordinator")
    await Promise.all(
      live.map(async (w) => {
        const c = w.id.startsWith("sub-") ? next.subAgent : next.agent
        if (w.model === c.model) return
        if (this.moveSdk(w, c.model)) return
        try {
          await w.setModel(c.model, c.reasoningEffort)
        } catch (e) {
          console.error(`factory config: ${w.id} kept ${w.model}; ${e instanceof Error ? e.message : e}`)
        }
      }),
    )
    this.publishSettings()
  }

  private async applyModelChange(prev: S.Settings, next: S.Settings): Promise<void> {
    const same = (a: { model: string; reasoningEffort: string }, b: { model: string; reasoningEffort: string }) =>
      a.model === b.model && a.reasoningEffort === b.reasoningEffort
    if (same(next.agent, prev.agent) && same(next.subAgent, prev.subAgent)) return
    try {
      // Global coordinators (desk, General chats) follow `agent`; repo sub-coordinators follow `subAgent`.
      await Promise.all(
        [...this.workers.values()]
          .filter((w) => w.role === "coordinator")
          .map((w) => {
            const c = w.id.startsWith("sub-") ? next.subAgent : next.agent
            return this.moveSdk(w, c.model) ? undefined : w.setModel(c.model, c.reasoningEffort)
          }),
      )
    } catch (e) {
      throw new Error(`model change rejected: ${e instanceof Error ? e.message : e}`, { cause: e })
    }
  }

  /**
   * The handoff of a coordinator that changes SDK: its own summary, else (no answer in time, or a dead session) the
   * last turns from the event log. Saved in its home, so it survives the service restart a desk switch needs.
   */
  private async writeHandoff(w: Worker): Promise<void> {
    const before = w.lastMessage
    let summary: string | null = null
    try {
      await w.send(loadPrompt("handoff-ask"))
      if ((await w.waitIdle(HANDOFF_WAIT_MS)) && w.lastMessage && w.lastMessage !== before) summary = w.lastMessage
    } catch {}
    const body =
      summary ?? `Transcript of the last turns (the old session wrote no summary):\n\n${handoffTranscript(w.log)}`
    try {
      mkdirSync(path.join(this.root, w.id), { recursive: true })
      writeFileSync(handoffFile(this.root, w.id), `${loadPrompt("handoff-start")}\n\n${body}`)
    } catch (e) {
      console.error(`handoff of ${w.id} not saved: ${e instanceof Error ? e.message : e}`)
    }
  }

  /** Resolves when no agent runs (checked every 5 s), or when the timeout expires. */
  private async allIdle(timeoutMs: number): Promise<void> {
    const end = Date.now() + timeoutMs
    while (Date.now() < end && [...this.workers.values()].some((x) => x.status === "running"))
      await new Promise((r) => setTimeout(r, 5_000))
  }

  /** Called when the desk must change SDK: main.ts restarts the service, which starts the desk in the new one. */
  onDeskSdkChange: (() => void) | null = null

  /**
   * A coordinator whose new model needs the other SDK cannot switch in place. After its current turn it stops; a
   * sub-coordinator or General chat starts again in the new SDK on its next message, the desk by a service restart.
   * Each SDK keeps its own transcript, so before it stops it writes a handoff (handoff.md in its home) that the new
   * session gets with its first message. True when it moves.
   */
  private moveSdk(w: Worker, model: string): boolean {
    const kind = workerHarness(
      this.settings.workers.harness,
      "coordinator",
      undefined,
      false,
      w.id.startsWith("sub-"),
      model,
    )?.kind
    if ((kind ?? "copilot") === w.harness) return false
    console.error(`factory config: ${w.id} moves from ${w.harness} to ${kind ?? "copilot"} after its turn (${model})`)
    // The desk restarts the whole service, which stops every worker: it waits until no agent runs.
    const wait = w.id === "coordinator" ? this.allIdle(SDK_MOVE_WAIT_MS) : w.waitIdle(SDK_MOVE_WAIT_MS)
    void wait.then(async () => {
      if (this.workers.get(w.id) !== w) return
      await this.writeHandoff(w)
      if (w.id === "coordinator") return this.onDeskSdkChange?.()
      void this.stop(w.id).catch(() => {})
    })
    return true
  }

  private clearChangedExtensionErrors(prev: S.Settings, next: S.Settings): void {
    const names = new Set([...Object.keys(prev.extensions), ...Object.keys(next.extensions)])
    for (const name of names) {
      if (JSON.stringify(prev.extensions[name]) === JSON.stringify(next.extensions[name])) continue
      for (const key of this.extensionErrors.keys()) if (key.startsWith(`${name}@`)) this.extensionErrors.delete(key)
    }
  }

  /** Wrap a prompt for the coordinator with the user's live agent settings. */
  coordinatorPrompt(prompt: string): string {
    const a = this.settings.agent
    let out = prompt
    if (a.instructions.trim()) out += `\n\n<user-instructions>${a.instructions.trim()}</user-instructions>`
    if (a.disabledTools.length)
      out += `\n\n<disabled-tools>Do not use these built-in tool kinds; they are denied: ${a.disabledTools.join(", ")}.</disabled-tools>`
    return out
  }

  async stop(id: string): Promise<void> {
    const w = this.get(id)
    this.workers.delete(id)
    await w.session.disconnect().catch(() => {})
    if (!w.sharedRuntime) await w.client.stop().catch(() => {})
    this.publish(id, "factory.worker_stopped", null, now(), { id })
  }

  /** Stop a worker so that whoever waits on it sees it end with an error (`reason`), as a dead runtime would. */
  async interrupt(id: string, reason: string): Promise<void> {
    const w = this.workers.get(id)
    if (!w) return
    const ev = { type: "session.error", timestamp: new Date().toISOString(), data: { message: reason } } as SessionEvent
    w.observe(this, ev)
    w.events.send(ev)
    await this.stop(id).catch(() => {})
  }

  async stopAll(): Promise<void> {
    const lister = this.modelClient
    this.modelClient = null
    await Promise.all([
      ...[...this.workers.keys()].map((id) => this.stop(id).catch(() => {})),
      lister?.then((c) => c.stop()).catch(() => {}),
    ])
  }

  /** Coordinator permission gate: denies tool kinds disabled in settings. */
  readonly settingsPermissions: PermissionHandler = (request) => {
    const kind = (request as { kind?: string }).kind ?? ""
    if (touchesFactoryConfig(request))
      return {
        kind: "reject",
        feedback: `${configDir()} is the human's. Use propose_config_change; the human applies it.`,
      }
    if (this.settings.agent.disabledTools.includes(kind))
      return { kind: "reject", feedback: `'${kind}' tools are disabled in factory settings` }
    return { kind: "approve-once" }
  }

  /** Sub-coordinator permission gate: the settings gate, and never merge, push, or delete without the human. */
  readonly subPermissions: PermissionHandler = (request, invocation) => {
    if (request.kind === "shell" && forbiddenCommand(request.fullCommandText))
      return {
        kind: "reject",
        feedback:
          "Sub-coordinators never merge, push, or delete branches or worktrees. To push and open a PR: request_approval with ship=true, then spawn_worker step=finish. Merging and deleting stay with the human.",
      }
    // Coordinate, do not do: no file writes, and only read-only shell commands.
    if (request.kind === "write") return { kind: "reject", feedback: subShellFeedback() }
    const why = request.kind === "shell" ? readOnlyViolation(request.fullCommandText) : null
    if (why) return { kind: "reject", feedback: `Refused (${why}). ${subShellFeedback()}` }
    return this.settingsPermissions(request, invocation)
  }

  /** Global coordinator permission gate: it runs in the projects folder beside the main checkouts, so it only reads.
   *  Never merge, push, or delete; the human does that. Repo changes go through a conversation's worktree. */
  readonly globalPermissions: PermissionHandler = (request, invocation) => {
    if (request.kind === "shell" && forbiddenCommand(request.fullCommandText))
      return {
        kind: "reject",
        feedback:
          "The global coordinator never merges, pushes, or deletes branches or worktrees. Ask the human with request_approval.",
      }
    if (request.kind === "write") return { kind: "reject", feedback: deskShellFeedback() }
    const why = request.kind === "shell" ? readOnlyViolation(request.fullCommandText) : null
    if (why) return { kind: "reject", feedback: `Refused (${why}). ${deskShellFeedback()}` }
    return this.settingsPermissions(request, invocation)
  }
}

/** The human's factory config folder (config.toml, prompts/, INSTRUCTIONS.md). */
const configDir = () => path.dirname(userConfigPath())

/** A coordinator file write, or a shell command, that names the human's factory config folder. Code, not prompt text,
 *  keeps config and prompt changes behind propose_config_change. */
export const touchesFactoryConfig = (request: {
  kind?: string
  fileName?: unknown
  fullCommandText?: unknown
}): boolean => {
  const dir = configDir()
  const named = (text: unknown) =>
    typeof text === "string" &&
    (text.includes(dir) ||
      /~\/\.config\/trellage\/factory|trellage\/factory\/(prompts|config\.toml|INSTRUCTIONS)/.test(text))
  return (
    (request.kind === "write" && named(request.fileName)) ||
    (request.kind === "shell" && named(request.fullCommandText))
  )
}

/** The first push plus this many fix rounds per ship approval; then the human decides. */
export const maxFixRounds = (c: FactoryConfig = factoryConfig()) => c.sdlc.max_fix_rounds

/**
 * Gate for a finish worker: it fixes, commits, and pushes only its approved branch; it never merges or deletes.
 * `--force-with-lease` on that branch is allowed while `forceWithLease()` is true (setting workers.forceWithLease,
 * read at each push so unchecking it applies at once). Plain `--force` never is.
 * Pushes count against the grant, so a new finish worker for the same approval does not reset the limit.
 * `saved` stores the new count after each allowed push.
 */
export const finishPermissions =
  (
    grant: ShipGrant,
    saved: (g: ShipGrant) => void = () => {},
    limit = maxFixRounds(),
    forceWithLease: () => boolean = () => false,
  ): PermissionHandler =>
  (request, invocation) => {
    if (request.kind !== "shell") return approveAll(request, invocation)
    const cmd = request.fullCommandText
    const lease = forceWithLease()
    if (forbiddenCommand(cmd, { branch: grant.branch, forceWithLease: lease }))
      return {
        kind: "reject",
        feedback: `Finish workers push only with \`git push -u origin ${grant.branch}\`${lease ? ` (or \`git push --force-with-lease -u origin ${grant.branch}\` after a rebase; never --force)` : " (no force: the human turned off --force-with-lease)"} and never merge or delete. Report it to the coordinator.`,
      }
    if (!forbiddenCommand(cmd)) return approveAll(request, invocation)
    // An allowed push of the granted branch.
    if (grant.pushes > limit)
      return {
        kind: "reject",
        feedback: `Fix round limit reached (${limit} after the first push). Stop and return what still fails and why.`,
      }
    grant.pushes++
    saved(grant)
    return approveAll(request, invocation)
  }

/** Default gate for Copilot workers: never merge, push, or delete branches or worktrees; approve the rest. */
/** A Claude permission gate with the worker's tool guard in front (it also sees subagent calls). */
const withToolGuard =
  (guard: SpawnSpec["toolGuard"], gate: CanUseTool): CanUseTool =>
  async (toolName, input, options) => {
    const reason = guard?.(toolName)
    return reason ? { behavior: "deny", message: reason } : gate(toolName, input, options)
  }

/** The tool guard as a Copilot pre-tool hook. */
const copilotToolGuard = (guard: NonNullable<SpawnSpec["toolGuard"]>) => (input: { toolName: string }) => {
  const reason = guard(input.toolName)
  return reason ? { permissionDecision: "deny" as const, permissionDecisionReason: reason } : undefined
}

export const workerPermissions: PermissionHandler = (request, invocation) =>
  request.kind === "shell" && forbiddenCommand(request.fullCommandText)
    ? {
        kind: "reject",
        feedback:
          "Workers never merge, push, delete branches or worktrees, change git config, or point git at another repository (GIT_DIR and the like). Report it to the coordinator.",
      }
    : approveAll(request, invocation)

const rssKb = (pid: number): number | null => {
  try {
    const n = Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim())
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

const githubToken = (): string => {
  for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN"]) {
    const v = process.env[key]
    if (v) return v
  }
  const token = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim()
  if (!token) throw new Error("no GitHub token: set COPILOT_GITHUB_TOKEN or run gh auth login")
  return token
}
