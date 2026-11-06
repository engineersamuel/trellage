// Pi harness: a worker that runs in the Pi SDK with a trx-composed profile.
// Its events are mapped to the Copilot event names the factory, feed and UIs already use.
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent"
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

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? b.text : "")).join("") : ""

/** One Pi session event as factory events. Calls made by another tool carry their parent as agentId. */
export const piEvents = (e: AgentSessionEvent, at = new Date().toISOString()): HarnessEvent[] => {
  const parent = (e as { parentToolCallId?: string }).parentToolCallId
  const ev = (type: string, data: any): HarnessEvent => ({ type, timestamp: at, ...(parent ? { agentId: parent } : {}), data })
  // One id per content block, the same in the deltas and the final message, so the feed drops the deltas.
  const blockId = (m: any, i: number) => `${m.timestamp ?? m.responseId}:${i}`
  switch (e.type) {
    case "message_update": {
      const m: any = e.message
      const a: any = e.assistantMessageEvent
      if (m.role !== "assistant" || !a.delta) return []
      if (a.type === "text_delta") return [ev("assistant.message_delta", { messageId: blockId(m, a.contentIndex), deltaContent: a.delta })]
      if (a.type === "thinking_delta") return [ev("assistant.reasoning_delta", { reasoningId: blockId(m, a.contentIndex), deltaContent: a.delta })]
      return []
    }
    case "message_end": {
      const m: any = e.message
      if (m.role !== "assistant") return []
      return [
        ...m.content.flatMap((b: any, i: number) =>
          b.type === "text" && b.text
            ? [ev("assistant.message", { messageId: blockId(m, i), content: b.text })]
            : b.type === "thinking" && b.thinking
              ? [ev("assistant.reasoning", { reasoningId: blockId(m, i), content: b.thinking })]
              : [],
        ),
        ...(m.stopReason === "error" ? [ev("session.error", { message: m.errorMessage ?? "model error" })] : []),
      ]
    }
    case "tool_execution_start":
      return [ev("tool.execution_start", { toolCallId: e.toolCallId, toolName: e.toolName, arguments: e.args })]
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

/** A live Pi SDK session. It is both the worker's session and its client. */
export class PiSession {
  private constructor(
    private readonly s: AgentSession,
    private readonly emit: (ev: HarnessEvent) => void,
  ) {
    s.subscribe((e) => {
      for (const ev of piEvents(e)) emit(ev)
    })
  }

  static async start(launch: PiLaunch, cwd: string, emit: (ev: HarnessEvent) => void): Promise<PiSession> {
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: launch.agentDir,
      noSkills: true,
      additionalSkillPaths: launch.skills,
      noExtensions: true,
      additionalExtensionPaths: launch.extensions,
      noPromptTemplates: true,
      // The factory gate: never merge, push, or delete branches or worktrees.
      extensionFactories: [
        (pi) => {
          pi.on("tool_call", (e) =>
            e.toolName === "bash" && forbiddenCommand(String((e.input as { command?: unknown }).command ?? ""))
              ? { block: true, reason: "Workers never merge, push, or delete branches or worktrees. Report it to the coordinator." }
              : undefined,
          )
        },
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
    return new PiSession(session, emit)
  }

  get model(): string {
    return this.s.model?.id ?? ""
  }

  /** Runs in the background; a busy session queues the prompt as a follow-up. */
  async send(prompt: string): Promise<void> {
    const at = new Date().toISOString()
    this.emit({ type: "user.message", timestamp: at, data: { content: prompt } })
    this.emit({ type: "assistant.turn_start", timestamp: at, data: {} })
    const run = this.s.isStreaming ? this.s.followUp(prompt) : this.s.prompt(prompt)
    void Promise.resolve(run).catch((e) => {
      const t = new Date().toISOString()
      this.emit({ type: "session.error", timestamp: t, data: { message: e instanceof Error ? e.message : String(e) } })
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
