// Worker lifecycle: each worker is a separate agent process with its own home. Copilot SDK is the
// default harness (a runtime over TCP); a step may name the Claude Agent SDK harness instead.
import { execFileSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
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
import { Approvals } from "./approvals.ts"
import { EventStore } from "./events.ts"
import { freshTurn, type Turn } from "./report.ts"
import { forbiddenCommand } from "./guard.ts"
import type { SecurityReview } from "./security.ts"
import * as S from "./settings.ts"
import { appendCompact } from "../../shared/feed.ts"
import { ensureClones, prepareStepSkills, SKILL_REPOS, stepById, stepSetup, TOOL_REPOS, type HarnessSpec, type SkillCheck } from "./steps.ts"
import { claudeGate, ClaudeSession, composeClaude, type HarnessEvent } from "./claude.ts"
import { composePi, PiSession } from "./pi.ts"

const LOG_CAP = 4000

export type Auth = "native" | "proxy"
export type Harness = "copilot" | "claude" | "pi"

/** What the factory needs from a live session, in every harness. */
export type Session = {
  send(prompt: string): Promise<unknown>
  abort(): Promise<void>
  disconnect(): Promise<void>
  setModel(model: string, options?: { reasoningEffort?: never }): Promise<void>
}

export type WorkerSummary = {
  id: string
  name: string
  role: string
  status: string
  auth: Auth
  harness: Harness
  model: string
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
}

/** One event in the factory feed. `seq` is global so a client can resume. */
export type FeedEvent = {
  seq: number
  workerId: string
  type: string
  agentId: string | null
  timestamp: string
  data: any
}

export type SpawnSpec = {
  id?: string
  name: string
  role: string
  auth?: Auth
  model?: string
  task?: string
  system?: string
  tools?: Tool<any>[]
  permissions?: PermissionHandler
  /** SDLC step from the catalog; loads its skills and quality-gate tools. */
  step?: string
  /** Run in this harness instead of the step's (default: Copilot SDK). */
  harness?: HarnessSpec
  /** Working directory, e.g. a conversation's worktree. Default: the run worktree or the worker's own workspace. */
  workdir?: string
  /** Coordinator that started this worker; supervisor issues go to it. */
  owner?: string
  /** Stable session id: resume this session (its memory) when it exists, else create it. */
  sessionId?: string
  /** Fired once when the worker goes idle after its initial task's work. */
  onDone?: (w: Worker) => void
  /** Open the session on this live worker's runtime instead of starting a new process (General chats). */
  shareRuntimeOf?: string
  /** The one conversation this agent serves; its answers are tagged with it. */
  threadId?: string
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
export type Run = { id: string; repo: string; worktree: string; branch: string; base: string; dirty: boolean }

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
  context: [number, number] | null = null
  lastMessage: string | null = null
  log: FeedEvent[] = []
  /** Supervisor inputs: last event time, consecutive failed tool calls, last error, result read. */
  lastActivity = Date.now()
  failedTools = 0
  lastError: string | null = null
  collected = false
  owner = "coordinator"
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
      pid: this.pid,
      rssKb: this.pid === null ? null : rssKb(this.pid),
      home: this.home,
      task: this.task,
      lastMessage: this.lastMessage,
      eventCount: this.log.length,
      contextTokens: this.context?.[0] ?? null,
      contextLimit: this.context?.[1] ?? null,
      owner: this.owner,
    }
  }

  /** Mark running before sending so a reader never sees a stale "idle". */
  async send(prompt: string): Promise<void> {
    this.status = "running"
    this.collected = false
    this.lastActivity = Date.now()
    await this.session.send(prompt)
  }

  observe(factory: Factory, ev: SessionEvent): void {
    let data = (ev as { data?: any }).data ?? {}
    // The global coordinator serves many conversations: tag each answer with the conversation of its turn.
    const tag = this.threadId ?? (this.id === "coordinator" ? factory.currentThread : null)
    if (ev.type === "assistant.message" && tag) data = { ...data, threadId: tag }
    const agentId = (ev as { agentId?: string }).agentId ?? null
    this.lastActivity = Date.now()
    this.observeToolResult(ev.type, agentId, data)
    const fe = factory.publish(this.id, ev.type, agentId, ev.timestamp, data)
    const changed = this.applyEventState(ev.type, agentId, data)
    // Model-layer events are large and duplicate assistant.*; keep them out of the log.
    if (!ev.type.startsWith("model.")) this.persistEvent(fe)
    if (changed) factory.publish(this.id, "factory.worker_updated", null, now(), this.summary())
    this.settleDone(ev.type)
  }

  private observeToolResult(type: string, agentId: string | null, data: any): void {
    if (type !== "tool.execution_complete" || agentId !== null) return
    this.failedTools = data.success === false ? this.failedTools + 1 : 0
    if (data.success === false) this.lastError = String(data.error?.message ?? "tool failed").slice(0, 300)
  }

  private applyEventState(type: string, agentId: string | null, data: any): boolean {
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
        if (data.content && agentId === null) this.lastMessage = data.content
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
        if (ev.type === "session.idle") {
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
  readonly defaultModel: string
  settings: S.Settings
  private readonly settingsFile: string
  /** Latest browser-side extension errors, keyed by "extension@ui". */
  readonly extensionErrors = new Map<string, unknown>()
  run: Run | null = null
  approvals!: Approvals
  /** Ship approvals by approval id: the conversation and branch a finish worker may push once the human picks option 1. */
  readonly shipRequests = new Map<string, ShipGrant>()
  /** Thread of the coordinator's current turn; approvals opened in that turn belong to it. */
  currentThread: string | null = null
  /** Latest Jev step decisions, newest last, from the event store, so they survive a restart. */
  get decisions(): unknown[] {
    return this.store.latest("factory.step_decided", 20)
  }
  readonly researchBatches = new Map<string, { workers: { id: string; workflow: string }[]; errors: string[] }>()
  /** Automatic security reviews by id. */
  readonly securityReviews = new Map<string, SecurityReview>()
  /** Sub-coordinator turns by worker id, for the report_up nudge. */
  readonly turns = new Map<string, Turn>()
  /** Last report sent per sub-coordinator, as "turn start|commit|status", so a repeat in the same turn is dropped. */
  readonly lastReports = new Map<string, string>()

  constructor(env = process.env) {
    this.root = env.SF_STATE_DIR ?? path.join(tmpdir(), "software-factory")
    this.healRoot = path.join(this.root, "skills-healed")
    mkdirSync(this.root, { recursive: true })
    this.store = new EventStore(path.join(this.root, "events.db"))
    this.store.importAll(this.root)
    this.seq = Math.max(Date.now() * 1000, this.store.maxSeq() + 1)
    this.defaultAuth = env.SF_AUTH === "proxy" ? "proxy" : "native"
    this.defaultModel = env.SF_MODEL ?? "claude-sonnet-5.5"
    this.proxyUrl = env.SF_PROXY_URL ?? "http://localhost:8080/v1"
    this.settingsFile = S.settingsPath(this.root)
    this.settings = S.loadSettings(this.settingsFile)
    this.approvals = new Approvals(this.root)
    if (this.settings.agent.model === "" || env.SF_MODEL !== undefined)
      this.settings = { ...this.settings, agent: { ...this.settings.agent, model: this.defaultModel } }
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
    const auth = spec.auth ?? this.defaultAuth
    const home = path.join(this.root, id)
    const step = spec.step ? stepById(spec.step) : null
    // Skill preflight runs first, so a worker with an unusable skill fails before any model call.
    const { workdir, setup, skills } = this.prepareSpawn(spec, id, home, step)
    const harness = spec.harness ?? step?.harness
    if (harness) return this.spawnHarness(spec, id, home, workdir, harness)
    const model = await this.spawnModel(spec, auth)
    const host = spec.shareRuntimeOf ? this.workers.get(spec.shareRuntimeOf) : undefined
    if (host && !(host.client instanceof CopilotClient)) throw new Error(`cannot share the runtime of ${host.id}: not a Copilot runtime`)
    const client = host ? (host.client as CopilotClient) : await this.startClient(home, workdir, auth, setup)
    const worker = new Worker(id, spec.name, spec.role, auth, home, spec.task ?? null, client, model)
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
    worker.session = await this.openSession(client, spec, this.sessionConfig(spec, worker, model, workdir, setup, auth))
    const prefix = setup.prefix
    return this.register(worker, spec.task && (prefix ? `${prefix}\n\n${spec.task}` : spec.task))
  }

  /** A Claude Agent SDK or Pi SDK worker with trx-composed profiles; the task runs through the profile's entry command. */
  private async spawnHarness(spec: SpawnSpec, id: string, home: string, workdir: string, harness: HarnessSpec): Promise<Worker> {
    let worker: Worker | undefined
    const emit = (ev: HarnessEvent) => {
      worker?.observe(this, ev as SessionEvent)
      worker?.events.send(ev as SessionEvent)
    }
    const { session, model, loaded } = harness.kind === "claude" ? await this.claudeSession(spec, workdir, harness, emit) : await this.piSession(spec, workdir, harness, emit)
    worker = new Worker(id, spec.name, spec.role, spec.auth ?? this.defaultAuth, home, spec.task ?? null, session, model)
    worker.harness = harness.kind
    worker.session = session
    this.configureWorker(worker, spec)
    worker.spec = {
      step: spec.step ?? null,
      workdir,
      skills: [],
      skillDirectories: [],
      extraPath: [],
      tools: [],
      systemPrompt: `${harness.kind} ${harness.profiles.join("+")}; ${loaded}`,
      sessionId: null,
    }
    return this.register(worker, spec.task && (harness.entry ? `${harness.entry} ${spec.task}` : spec.task))
  }

  private async claudeSession(spec: SpawnSpec, workdir: string, harness: HarnessSpec, emit: (ev: HarnessEvent) => void) {
    const launch = await composeClaude(harness.profiles, workdir)
    const model = spec.model ?? launch.model ?? this.defaultModel
    const session = new ClaudeSession(
      {
        cwd: workdir,
        env: launch.env,
        plugins: launch.plugins.map((p) => ({ type: "local" as const, path: p })),
        model,
        ...(launch.effort ? { effort: launch.effort as never } : {}),
        // default mode, so every permission prompt goes through the factory gate; bypassPermissions skips canUseTool.
        permissionMode: "default",
        canUseTool: claudeGate,
        disallowedTools: ["AskUserQuestion"],
      },
      emit,
    )
    return { session, model, loaded: `plugins ${launch.plugins.map((p) => path.basename(p)).join(", ")}` }
  }

  private async piSession(spec: SpawnSpec, workdir: string, harness: HarnessSpec, emit: (ev: HarnessEvent) => void) {
    const launch = await composePi(harness.profiles, workdir)
    if (spec.model) launch.model = spec.model
    const session = await PiSession.start(launch, workdir, emit)
    return { session, model: session.model, loaded: `skills ${launch.skills.map((p) => path.basename(p)).join(", ")}` }
  }

  private async spawnModel(spec: SpawnSpec, auth: Auth): Promise<string> {
    const model = spec.model ?? this.defaultModel
    if (spec.model || spec.role !== "worker" || !spec.task) return model
    const routed = await this.routeModel(spec.task, auth)
    if (!routed) return model
    this.publish("coordinator", "factory.model_routed", null, now(), { worker: spec.name, ...routed })
    return routed.id
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
    if (setup.skillDirectories.length) ensureClones(skillRoot, SKILL_REPOS)
    if (setup.extraPath.length) ensureClones(toolRoot, TOOL_REPOS)
    if (!step || !setup.skillDirectories.length) return { workdir, setup, skills: [] as SkillCheck[] }
    // Only the step's own skills load: link them into the worker's home, healed copies first.
    const stepDir = path.join(home, "skills")
    const skills = prepareStepSkills(setup.skillDirectories, this.healRoot, stepDir, step)
    return { workdir, setup: { ...setup, skillDirectories: [stepDir] }, skills }
  }

  private async startClient(home: string, workdir: string, auth: Auth, setup: ReturnType<typeof stepSetup>) {
    const client = new CopilotClient({
      connection: RuntimeConnection.forTcp({ port: 0 }),
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
    return client
  }

  private configureWorker(worker: Worker, spec: SpawnSpec): void {
    if (spec.owner) worker.owner = spec.owner
    worker.log = this.store.load(worker.id, LOG_CAP, worker.home)
    if (spec.onDone) worker.onDone = spec.onDone
    if (spec.shareRuntimeOf) worker.sharedRuntime = true
    if (spec.threadId) worker.threadId = spec.threadId
  }

  private sessionConfig(
    spec: SpawnSpec,
    worker: Worker,
    model: string,
    workdir: string,
    setup: ReturnType<typeof stepSetup>,
    auth: Auth,
  ): SessionConfig {
    return {
      onPermissionRequest: spec.permissions ?? workerPermissions,
      streaming: true,
      model,
      workingDirectory: workdir,
      tools: spec.tools ?? [],
      ...(setup.skillDirectories.length ? { skillDirectories: setup.skillDirectories } : {}),
      // Registered before session.create so no startup event is lost.
      onEvent: (ev) => {
        worker.observe(this, ev)
        worker.events.send(ev)
      },
      ...(spec.system ? { systemMessage: { mode: "append" as const, content: spec.system } } : {}),
      ...(auth === "proxy"
        ? { provider: { type: "openai" as const, baseUrl: this.proxyUrl, apiKey: "copilot-proxy-rs" } }
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
  async routeModel(task: string, auth: Auth): Promise<{ id: string; confidence: number; routedBy: string } | null> {
    try {
      const res = await fetch(`${this.proxyUrl}/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ input: task.slice(0, 16_000) }),
        signal: AbortSignal.timeout(25_000),
      })
      if (!res.ok) return null
      const r: any = await res.json()
      const ranked: string[] = [r.recommended?.id, ...(r.ranking ?? []).map((x: any) => x.id)].filter(Boolean)
      const available = auth === "proxy" ? ranked : (await (this.get("coordinator").client as CopilotClient).listModels()).map((m) => m.id)
      const id = ranked.find((m) => available.includes(m))
      return id
        ? { id, confidence: r.confidence ?? 0, routedBy: id === r.recommended?.id ? r.routed_by : "jev-ranking" }
        : null
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
      models = (await (this.get("coordinator").client as CopilotClient).listModels()).map((m) => m.id)
    } catch {}
    return {
      settings: this.settings,
      css: S.css(this.settings),
      run: this.run,
      options: {
        navbarItems: S.NAVBAR_ITEMS,
        panelPositions: S.PANEL_POSITIONS,
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
    // Code changed: old error reports no longer apply.
    this.clearChangedExtensionErrors(prev, next)
    this.settings = next
    S.saveSettings(this.settingsFile, next)
    this.publish("coordinator", "factory.settings_updated", null, now(), { settings: next, css: S.css(next) })
    return next
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

  private async applyModelChange(prev: S.Settings, next: S.Settings): Promise<void> {
    if (next.agent.model === prev.agent.model && next.agent.reasoningEffort === prev.agent.reasoningEffort) return
    try {
      // Every coordinator (desk, General chats, sub-coordinators) follows the coordinator model setting.
      await Promise.all([...this.workers.values()].filter((w) => w.role === "coordinator").map((w) => w.setModel(next.agent.model, next.agent.reasoningEffort)))
    } catch (e) {
      throw new Error(`model change rejected: ${e instanceof Error ? e.message : e}`)
    }
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

  async stopAll(): Promise<void> {
    await Promise.all([...this.workers.keys()].map((id) => this.stop(id).catch(() => {})))
  }

  /** Coordinator permission gate: denies tool kinds disabled in settings. */
  readonly settingsPermissions: PermissionHandler = (request) => {
    const kind = (request as { kind?: string }).kind ?? ""
    if (this.settings.agent.disabledTools.includes(kind))
      return { kind: "reject", feedback: `'${kind}' tools are disabled in factory settings` }
    return { kind: "approve-once" }
  }

  /** Sub-coordinator permission gate: the settings gate, and never merge, push, or delete without the human. */
  readonly subPermissions: PermissionHandler = (request, invocation) =>
    request.kind === "shell" && forbiddenCommand(request.fullCommandText)
      ? {
          kind: "reject",
          feedback:
            "Sub-coordinators never merge, push, or delete branches or worktrees. To push and open a PR: request_approval with ship=true, then spawn_worker step=finish. Merging and deleting stay with the human.",
        }
      : this.settingsPermissions(request, invocation)

  /** Global coordinator permission gate: the settings gate, and never merge, push, or delete; the human does that. */
  readonly globalPermissions: PermissionHandler = (request, invocation) =>
    request.kind === "shell" && forbiddenCommand(request.fullCommandText)
      ? {
          kind: "reject",
          feedback:
            "The global coordinator never merges, pushes, or deletes branches or worktrees. Ask the human with request_approval.",
        }
      : this.settingsPermissions(request, invocation)
}

/** An accepted ship approval: the branch a finish worker may push, and the pushes made under it so far. */
export type ShipGrant = { scopeId: string; branch: string; pushes: number }

/** The first push plus this many fix rounds per ship approval; then the human decides. */
export const MAX_FIX_ROUNDS = 5

/**
 * Gate for a finish worker: it fixes, commits, and pushes only its approved branch (no force); it never merges or deletes.
 * Pushes count against the grant, so a new finish worker for the same approval does not reset the limit.
 */
export const finishPermissions =
  (grant: ShipGrant): PermissionHandler =>
  (request, invocation) => {
    if (request.kind !== "shell") return approveAll(request, invocation)
    const cmd = request.fullCommandText
    if (forbiddenCommand(cmd, grant.branch))
      return {
        kind: "reject",
        feedback: `Finish workers push only with \`git push -u origin ${grant.branch}\` (no force) and never merge or delete. Report it to the coordinator.`,
      }
    if (!forbiddenCommand(cmd)) return approveAll(request, invocation)
    // An allowed push of the granted branch.
    if (grant.pushes > MAX_FIX_ROUNDS)
      return {
        kind: "reject",
        feedback: `Fix round limit reached (${MAX_FIX_ROUNDS} after the first push). Stop and return what still fails and why.`,
      }
    grant.pushes++
    return approveAll(request, invocation)
  }

/** Default gate for Copilot workers: never merge, push, or delete branches or worktrees; approve the rest. */
export const workerPermissions: PermissionHandler = (request, invocation) =>
  request.kind === "shell" && forbiddenCommand(request.fullCommandText)
    ? { kind: "reject", feedback: "Workers never merge, push, or delete branches or worktrees. Report it to the coordinator." }
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
