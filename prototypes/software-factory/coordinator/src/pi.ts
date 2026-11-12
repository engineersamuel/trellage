// Pi harness: a worker that runs in the Pi SDK with a trx-composed profile.
// Its events are mapped to the Copilot event names the factory, feed and UIs already use.
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  type McpServerEntry,
  parseSkillBlock,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent"
import path from "node:path"
import * as fs from "node:fs"
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { registerRequiredChildExtensions } from "pi-subagents/required-child-extensions"
import { takeFromFile } from "./pi-budget.ts"
import { prepareRun } from "../../../../packages/trellage-runtime/src/native-run/run.ts"
import type { HarnessEvent } from "./claude.ts"
import { forbiddenCommand } from "./guard.ts"

export type PiLaunch = {
  agentDir: string
  skills: string[]
  extensions: string[]
  provider: string
  model: string
  thinking: string
}

/**
 * pi-subagents (pinned in package.json): gives every Pi worker a `subagent` tool, as Claude (Task) and Copilot (task)
 * have built in. Its entry is the package's `pi.extensions` manifest.
 */
export const piSubagentsExtension = (): string => {
  const root = path.dirname(require.resolve("pi-subagents/package.json"))
  const entry = (JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { pi: { extensions: string[] } })
    .pi.extensions[0]!
  return path.join(root, entry)
}

const PI_ANGLE_AGENT = path.join(import.meta.dir, "..", "skills", "deep-research", "pi-agents", "research-angle.md")

/**
 * Pi's MCP extension and pi-subagents find mcp.json and agents through the process-wide agent dir
 * (PI_CODING_AGENT_DIR), not the session's. So the factory owns one: a copy of the composed Pi agent dir (provider,
 * models) plus the step's servers in mcp.json (0600) and the deep-research angle agent. Subagent children, in this
 * process or in pi-subagents' detached runner, load them from there. Parent sessions keep their explicit agent dir.
 */
export const usePiSubagentDir = (launch: PiLaunch, servers: McpServerEntry[], dest: string): void => {
  if (!servers.length) return
  mkdirSync(dest, { recursive: true, mode: 0o700 })
  cpSync(launch.agentDir, dest, { recursive: true, dereference: false })
  const file = path.join(dest, "mcp.json")
  writeFileSync(
    file,
    JSON.stringify({ mcpServers: Object.fromEntries(servers.map((s) => [s.name, s.config])) }, null, 2),
    {
      mode: 0o600,
    },
  )
  chmodSync(file, 0o600)
  mkdirSync(path.join(dest, "agents"), { recursive: true })
  cpSync(PI_ANGLE_AGENT, path.join(dest, "agents", path.basename(PI_ANGLE_AGENT)))
  process.env.PI_CODING_AGENT_DIR = dest
}

const PI_BUDGET_EXTENSION = path.join(import.meta.dir, "pi-budget-ext.ts")

/** A worker's Perplexity budget file, fresh. Children find it through SF_PERPLEXITY_BUDGET_FILE. */
export const piBudgetFile = (file: string, limits: { max: number; maxResearch: number }): string => {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ ...limits, calls: 0, research: 0 }))
  process.env.SF_PERPLEXITY_BUDGET_FILE = file
  return file
}

/** Values of each repeated `--flag value` in a trx launch command. */
const flagValues = (args: ReadonlyArray<string>, flag: string): string[] =>
  args.flatMap((a, i) => (a === flag && args[i + 1] !== undefined ? [args[i + 1]!] : []))

/** Compose trx profiles for Pi (skills, extensions, provider, PI_CODING_AGENT_DIR) without starting the CLI. */
export const composePi = async (profiles: string[], cwd: string): Promise<PiLaunch> => {
  const p = await prepareRun(
    { harness: "pi", profiles, dryRun: true, allowUnprovenIsolation: true, forwardedArgs: [] },
    { cwd },
  )
  const one = (flag: string) => flagValues(p.launch.args, flag)[0] ?? ""
  return {
    agentDir: String(p.launch.env.PI_CODING_AGENT_DIR),
    skills: flagValues(p.launch.args, "--skill"),
    extensions: flagValues(p.launch.args, "--extension"),
    provider: one("--provider"),
    model: one("--model"),
    thinking: one("--thinking"),
  }
}

/**
 * An agent dir whose provider also lists `model`. The trx profile registers one model on the copilot-proxy-rs
 * provider; the proxy serves every family (Claude, GPT, Gemini), so other ids get a copy of that entry. The copy is
 * the worker's own (the composed dir is shared): `dest` is a folder in the worker's home.
 */
export const withProxyModel = (launch: PiLaunch, model: string, dest: string): PiLaunch => {
  const file = path.join(launch.agentDir, "models.json")
  if (!existsSync(file)) return { ...launch, model }
  const doc = JSON.parse(readFileSync(file, "utf8"))
  const provider = doc.providers?.[launch.provider]
  if (!provider?.models?.length || provider.models.some((m: { id?: unknown }) => m.id === model))
    return { ...launch, model }
  provider.models.push({ ...provider.models[0], id: model, name: model })
  mkdirSync(dest, { recursive: true })
  cpSync(launch.agentDir, dest, { recursive: true, dereference: false })
  writeFileSync(path.join(dest, "models.json"), JSON.stringify(doc, null, 2))
  return { ...launch, agentDir: dest, model }
}

const textOf = (c: unknown): string =>
  typeof c === "string"
    ? c
    : Array.isArray(c)
      ? c.map((b: { type?: unknown; text?: unknown } | null) => (b?.type === "text" ? String(b.text) : "")).join("")
      : ""

/** A skill the session loaded: Pi has no skill tool, the model reads `filePath` to use it. */
export type PiSkill = { name: string; filePath: string }

/**
 * One Pi session event as factory events. Calls made by another tool carry their parent as agentId.
 * A read of a loaded skill's SKILL.md, or a `/skill:name` prompt, is also `skill.invoked`, as Claude's Skill tool is.
 */
export const piEvents = (
  e: AgentSessionEvent,
  at = new Date().toISOString(),
  skills: PiSkill[] = [],
  cwd = process.cwd(),
): HarnessEvent[] => {
  const parent = (e as { parentToolCallId?: string }).parentToolCallId
  const ev = (type: string, data: Record<string, unknown>): HarnessEvent => ({
    type,
    timestamp: at,
    ...(parent ? { agentId: parent } : {}),
    data,
  })
  // One id per content block, the same in the deltas and the final message, so the feed drops the deltas.
  const blockId = (m: { timestamp?: unknown; responseId?: unknown }, i: number) => `${m.timestamp ?? m.responseId}:${i}`
  switch (e.type) {
    case "message_update": {
      const m = e.message
      const a = e.assistantMessageEvent
      if (m.role !== "assistant" || !("delta" in a) || !a.delta) return []
      if (a.type === "text_delta")
        return [ev("assistant.message_delta", { messageId: blockId(m, a.contentIndex), deltaContent: a.delta })]
      if (a.type === "thinking_delta")
        return [ev("assistant.reasoning_delta", { reasoningId: blockId(m, a.contentIndex), deltaContent: a.delta })]
      return []
    }
    case "message_end": {
      const m = e.message
      if (m.role === "user") {
        const block = parseSkillBlock(textOf(m.content))
        return block ? [ev("skill.invoked", { name: block.name })] : []
      }
      if (m.role !== "assistant") return []
      return [
        ...m.content.flatMap((b, i) =>
          b.type === "text" && b.text
            ? [ev("assistant.message", { messageId: blockId(m, i), content: b.text })]
            : b.type === "thinking" && b.thinking
              ? [ev("assistant.reasoning", { reasoningId: blockId(m, i), content: b.thinking })]
              : [],
        ),
        ...(m.stopReason === "error" ? [ev("session.error", { message: m.errorMessage ?? "model error" })] : []),
        // One model call. Copilot's shape: inputTokens includes the cached tokens. No AIC; costs.ts estimates it.
        ...(m.usage
          ? [
              ev("assistant.usage", {
                model: String(m.model ?? "unknown"),
                inputTokens: (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0),
                outputTokens: m.usage.output ?? 0,
                cacheReadTokens: m.usage.cacheRead ?? 0,
                cacheWriteTokens: m.usage.cacheWrite ?? 0,
                reasoningTokens: m.usage.reasoning ?? 0,
                aiCreditsStatus: "unavailable",
              }),
            ]
          : []),
      ]
    }
    case "tool_execution_start": {
      const file = e.toolName === "read" && typeof e.args?.path === "string" ? path.resolve(cwd, e.args.path) : null
      const skill = file && skills.find((s) => path.resolve(s.filePath) === file)
      return [
        ev("tool.execution_start", {
          toolCallId: e.toolCallId,
          toolName: e.toolName,
          arguments: e.args,
        }),
        ...(skill ? [ev("skill.invoked", { name: skill.name })] : []),
      ]
    }
    case "tool_execution_end":
      return [
        ev("tool.execution_complete", {
          toolCallId: e.toolCallId,
          success: !e.isError,
          result: { content: textOf(e.result?.content) },
        }),
      ]
    case "agent_settled":
      return [ev("session.idle", {})]
    default:
      return []
  }
}

/** Context fill after each model call, as the Copilot runtime's `session.usage_info`. */
export const piContext = (
  e: AgentSessionEvent,
  usage: () => { tokens: number | null; contextWindow: number } | undefined,
  at = new Date().toISOString(),
): HarnessEvent[] => {
  const u = e.type === "message_end" && e.message.role === "assistant" ? usage() : undefined
  return u && u.tokens !== null
    ? [{ type: "session.usage_info", timestamp: at, data: { currentTokens: u.tokens, tokenLimit: u.contextWindow } }]
    : []
}

/** A live Pi SDK session. It is both the worker's session and its client. */
export class PiSession {
  private readonly skills: PiSkill[]
  private announced = false

  private constructor(
    private readonly s: AgentSession,
    private readonly emit: (ev: HarnessEvent) => void,
    cwd: string,
    private readonly mcp: McpServerEntry[] = [],
  ) {
    this.skills = s.resourceLoader.getSkills().skills.map(({ name, filePath }) => ({ name, filePath }))
    s.subscribe((e) => {
      for (const ev of piEvents(e, undefined, this.skills, cwd)) emit(ev)
      for (const ev of piContext(e, () => s.getContextUsage())) emit(ev)
    })
  }

  /** `mcp`: the step's servers. Pi's MCP extension loads only these, never an mcp.json from the agent dir or repo. */
  static async start(
    launch: PiLaunch,
    cwd: string,
    emit: (ev: HarnessEvent) => void,
    mcp: McpServerEntry[] = [],
    budget?: string,
  ): Promise<PiSession> {
    const toolGuard = budget ? (name: string) => takeFromFile(budget, name, fs) : undefined
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: launch.agentDir,
      noSkills: true,
      additionalSkillPaths: launch.skills,
      noExtensions: true,
      additionalExtensionPaths: [
        ...launch.extensions.filter((e) => e !== "builtin:mcp"),
        ...(mcp.length ? ["builtin:mcp"] : []),
        piSubagentsExtension(),
      ],
      noPromptTemplates: true,
      // The factory gate: never merge, push, or delete branches or worktrees.
      extensionFactories: [
        (pi) => {
          pi.on("tool_call", (e) => {
            if (e.toolName === "bash" && forbiddenCommand(String((e.input as { command?: unknown }).command ?? "")))
              return {
                block: true,
                reason:
                  "Workers never merge, push, delete branches or worktrees, change git config, or point git at another repository (GIT_DIR and the like). Report it to the coordinator.",
              }
            const reason = toolGuard?.(e.toolName)
            return reason ? { block: true, reason } : undefined
          })
        },
        // Reads mcp.json from the factory-owned agent dir (usePiSubagentDir): pi-subagents hands only servers
        // configured there to its children.
        // As the pi CLI registers it: pi-subagents only hands built-in MCP tools to children from `builtin:mcp`.
        ...(mcp.length
          ? [{ name: "mcp", builtin: true as const, replaceable: true, factory: createMcpExtension() }]
          : []),
      ],
    })
    await resourceLoader.reload()
    const { session } = await createAgentSession({
      cwd,
      agentDir: launch.agentDir,
      resourceLoader,
      sessionManager: SessionManager.inMemory(),
      thinkingLevel: launch.thinking as never,
    })
    const model = session.modelRuntime.getModel(launch.provider, launch.model)
    if (!model) throw new Error(`Pi model ${launch.provider}/${launch.model} not found`)
    await session.setModel(model)
    // The MCP extension connects its servers on session_start, which only bindExtensions sends (as the pi CLI does).
    // Only for steps with MCP servers: other Pi workers keep today's behaviour.
    if (mcp.length) await session.bindExtensions({ mode: "print" })
    // Every pi-subagents child of this session loads the budget extension and counts in the same file.
    if (budget)
      registerRequiredChildExtensions({
        sessionId: session.sessionId,
        extensions: [{ id: "sf-perplexity-budget", path: PI_BUDGET_EXTENSION }],
      })
    return new PiSession(session, emit, cwd, mcp)
  }

  get model(): string {
    return this.s.model?.id ?? ""
  }

  /** Runs in the background; a busy session queues the prompt as a follow-up. */
  async send(prompt: string): Promise<void> {
    const at = new Date().toISOString()
    // Sent with the first prompt: events emitted while the session starts have no worker to reach yet.
    if (!this.announced) {
      this.announced = true
      this.emit({
        type: "session.skills_loaded",
        timestamp: at,
        data: { skills: this.skills.map((s) => ({ name: s.name, source: "pi", enabled: true, path: s.filePath })) },
      })
      // Pi sends no such event; Copilot and Claude do. Pi connects in the background, so "configured", not "connected".
      if (this.mcp.length)
        this.emit({
          type: "session.mcp_servers_loaded",
          timestamp: at,
          data: {
            servers: this.mcp.map((m) => ({
              name: m.name,
              status: "configured",
              source: "factory",
            })),
          },
        })
    }
    this.emit({ type: "user.message", timestamp: at, data: { content: prompt } })
    this.emit({ type: "assistant.turn_start", timestamp: at, data: {} })
    const run = this.s.isStreaming ? this.s.followUp(prompt) : this.s.prompt(prompt)
    void Promise.resolve(run).catch((e) => {
      const t = new Date().toISOString()
      this.emit({
        type: "session.error",
        timestamp: t,
        data: { message: e instanceof Error ? e.message : String(e) },
      })
      this.emit({ type: "session.idle", timestamp: t, data: {} })
    })
  }
  async abort(): Promise<void> {
    await this.s.abort()
  }
  async setModel(model: string): Promise<void> {
    const m = this.s.model && this.s.modelRuntime.getModel(this.s.model.provider, model)
    if (!m) throw new Error(`Pi model ${model} not found`)
    await this.s.setModel(m)
  }
  async disconnect(): Promise<void> {
    this.s.dispose()
  }
  stop = (): Promise<void> => this.disconnect()
}
