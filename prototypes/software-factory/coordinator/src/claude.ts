// Claude harness: a worker that runs in the Claude Agent SDK with a trx-composed profile.
// Its messages are mapped to the Copilot event names the factory, feed and UIs already use.
import path from "node:path"
import { query, type CanUseTool, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { forbiddenCommand } from "./guard.ts"
import { prepareRun } from "../../../../packages/trellage-runtime/src/native-run/run.ts"

export type HarnessEvent = { type: string; timestamp: string; agentId?: string; data: any }

export type ClaudeLaunch = { plugins: string[]; env: Record<string, string>; model: string | undefined; effort: string | undefined }

/** Compose trx profiles for Claude (plugins, skills, CLAUDE_CONFIG_DIR, proxy env) without starting the CLI. */
export const composeClaude = async (profiles: string[], cwd: string): Promise<ClaudeLaunch> => {
  const p = await prepareRun(
    { harness: "claude", profiles, dryRun: true, allowUnprovenIsolation: true, forwardedArgs: [] },
    { cwd },
  )
  // A null launch value removes the variable from the child environment.
  const env = Object.fromEntries(
    Object.entries({ ...process.env, ...p.launch.env }).filter((e): e is [string, string] => typeof e[1] === "string"),
  )
  return {
    plugins: p.plan.plugins.map((x) => path.join(p.layout.generationPath, "plugins", x.name)),
    env,
    model: p.selection.model ?? p.defaults.model,
    effort: p.selection.effort ?? p.defaults.effort,
  }
}

/** Permission gate for Claude workers: never merge, push, or delete branches or worktrees; the human does that. */
export const claudeGate: CanUseTool = async (toolName, input) =>
  toolName === "Bash" && typeof input.command === "string" && forbiddenCommand(input.command)
    ? { behavior: "deny", message: "Workers never merge, push, or delete branches or worktrees. Report it to the coordinator." }
    : { behavior: "allow", updatedInput: input }

/** Prompts for the SDK's streaming input; `end` closes the session. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private ended = false
  push(text: string) {
    this.queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null })
    this.wake?.()
  }
  end() {
    this.ended = true
    this.wake?.()
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.queue.length) yield this.queue.shift()!
      if (this.ended) return
      await new Promise<void>((r) => (this.wake = r))
      this.wake = null
    }
  }
}

const textOf = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b: any) => (b?.type === "text" ? b.text : "")).join("") : ""

/** One SDK message as factory events. Subagent messages carry their parent tool call as agentId. */
export const toEvents = (m: SDKMessage, at = new Date().toISOString()): HarnessEvent[] => {
  const agentId = "parent_tool_use_id" in m && m.parent_tool_use_id ? { agentId: m.parent_tool_use_id } : {}
  const ev = (type: string, data: any): HarnessEvent => ({ type, timestamp: at, ...agentId, data })
  switch (m.type) {
    case "assistant":
      return m.message.content.flatMap((b: any, i: number) =>
        b.type === "text"
          ? [ev("assistant.message", { messageId: `${m.uuid}:${i}`, content: b.text })]
          : b.type === "thinking"
            ? [ev("assistant.reasoning", { content: b.thinking })]
            : b.type === "tool_use"
              ? [ev("tool.execution_start", { toolCallId: b.id, toolName: b.name, arguments: b.input })]
              : [],
      )
    case "user":
      return Array.isArray(m.message.content)
        ? m.message.content.flatMap((b: any) =>
            b.type === "tool_result"
              ? [ev("tool.execution_complete", { toolCallId: b.tool_use_id, success: !b.is_error, result: { content: textOf(b.content) } })]
              : [],
          )
        : []
    case "system":
      // The init message lists what the Claude session loaded; map it to the Copilot runtime's events for the spec view.
      if (m.subtype !== "init") return []
      return [
        ev("session.start", { context: { cwd: m.cwd } }),
        ev("session.skills_loaded", { skills: m.skills.map((name: string) => ({ name, source: "claude", enabled: true })) }),
        ev("session.mcp_servers_loaded", { servers: m.mcp_servers.map((x: any) => ({ name: x.name, status: x.status, source: x.source ?? null })) }),
        ev("session.plugins_loaded", { plugins: (m.plugins ?? []).map((x: any) => x.name) }),
      ]
    case "result":
      return [
        ...(m.subtype === "success" ? [] : [ev("session.error", { message: m.errors.join("; ") || m.subtype })]),
        ev("session.idle", {}),
      ]
    default:
      return []
  }
}

type Block = { kind: "text" | "thinking"; id: string; text: string; message: string }

/**
 * Streams Claude text and thinking as deltas (SDK option includePartialMessages). The full assistant message
 * then reuses each block's delta id, so the feed drops the deltas and transcripts show the text once.
 */
export class ClaudeStream {
  private message = ""
  private open = new Map<number, Block>()
  /** Streamed blocks whose full assistant message has not arrived yet. */
  private finished: Block[] = []

  map(m: SDKMessage, at = new Date().toISOString()): HarnessEvent[] {
    if (m.type !== "stream_event") return m.type === "assistant" ? this.reuseIds(m, toEvents(m, at)) : toEvents(m, at)
    const agentId = m.parent_tool_use_id ? { agentId: m.parent_tool_use_id } : {}
    const ev = (type: string, data: any): HarnessEvent => ({ type, timestamp: at, ...agentId, data })
    const e: any = m.event
    switch (e.type) {
      case "message_start":
        this.message = String(e.message?.id ?? m.uuid)
        this.open.clear()
        return []
      case "content_block_start": {
        const kind = e.content_block?.type
        if (kind === "text" || kind === "thinking") this.open.set(e.index, { kind, id: `${this.message}:${e.index}`, text: "", message: this.message })
        return []
      }
      case "content_block_delta": {
        const b = this.open.get(e.index)
        if (!b) return []
        if (e.delta?.type === "text_delta" && e.delta.text) {
          b.text += e.delta.text
          return [ev("assistant.message_delta", { messageId: b.id, deltaContent: e.delta.text })]
        }
        if (e.delta?.type === "thinking_delta" && e.delta.thinking) {
          b.text += e.delta.thinking
          return [ev("assistant.reasoning_delta", { reasoningId: b.id, deltaContent: e.delta.thinking })]
        }
        return []
      }
      case "content_block_stop": {
        const b = this.open.get(e.index)
        if (b) (this.open.delete(e.index), this.finished.push(b))
        return []
      }
      default:
        return []
    }
  }

  /** Give each full text or thinking block the id its deltas used. */
  private reuseIds(m: Extract<SDKMessage, { type: "assistant" }>, events: HarnessEvent[]): HarnessEvent[] {
    const take = (kind: Block["kind"], text: string) => {
      const i = this.finished.findIndex((b) => b.kind === kind && b.message === m.message.id && b.text === text)
      return i < 0 ? undefined : this.finished.splice(i, 1)[0]!.id
    }
    for (const ev of events) {
      if (ev.type === "assistant.message") ev.data.messageId = take("text", ev.data.content) ?? ev.data.messageId
      if (ev.type === "assistant.reasoning") {
        const id = take("thinking", ev.data.content)
        if (id) ev.data.reasoningId = id
      }
    }
    // Blocks of older messages that never matched are dropped, so the list stays small.
    this.finished = this.finished.filter((b) => b.message === this.message)
    return events
  }
}

/**
 * Turn state across SDK messages. A Claude session can end a turn while background subagents
 * (the Agent tool, run in the background) still run, then resume by itself when they finish.
 * The factory must see that as one busy stretch: no idle while tasks run, and a turn start on resume.
 */
export class TurnTracker {
  private readonly tasks = new Set<string>()
  busy = false

  /** Map one SDK message; `events` are its plain toEvents mapping. */
  map(m: SDKMessage, events: HarnessEvent[], at = new Date().toISOString()): HarnessEvent[] {
    const sys = m.type === "system" ? (m as { subtype?: string; task_id?: string }) : null
    if (sys?.subtype === "task_started" && sys.task_id) this.tasks.add(sys.task_id)
    if (sys?.subtype === "task_notification" && sys.task_id) this.tasks.delete(sys.task_id)
    const out: HarnessEvent[] = []
    for (const ev of events) {
      if (ev.type === "session.idle") {
        if (this.tasks.size) {
          out.push({ type: "session.info", timestamp: at, data: { infoType: "background", message: `waiting for ${this.tasks.size} background task(s)` } })
          continue
        }
        this.busy = false
      } else if (!this.busy && !ev.agentId && /^(assistant\.|tool\.execution_start)/.test(ev.type)) {
        // The session resumed on its own (a background task finished): start a turn so status is running again.
        out.push({ type: "assistant.turn_start", timestamp: at, data: {} })
        this.busy = true
      }
      out.push(ev)
    }
    return out
  }
}

/** A live Claude Agent SDK session. It is both the worker's session and its client. */
export class ClaudeSession {
  private readonly inbox = new Inbox()
  private readonly q: Query
  private readonly turns = new TurnTracker()
  private readonly stream = new ClaudeStream()

  constructor(
    options: Options,
    private readonly emit: (ev: HarnessEvent) => void,
  ) {
    const q = query({ prompt: this.inbox, options })
    this.q = q
    void (async () => {
      try {
        for await (const m of q) for (const ev of this.turns.map(m, this.stream.map(m))) this.emit(ev)
      } catch (e) {
        const at = new Date().toISOString()
        this.emit({ type: "session.error", timestamp: at, data: { message: e instanceof Error ? e.message : String(e) } })
        this.emit({ type: "session.idle", timestamp: at, data: {} })
      }
    })()
  }

  /** The SDK does not echo input; emit the turn start so status and onDone work as for Copilot. */
  async send(prompt: string): Promise<void> {
    const at = new Date().toISOString()
    this.emit({ type: "user.message", timestamp: at, data: { content: prompt } })
    this.emit({ type: "assistant.turn_start", timestamp: at, data: {} })
    this.turns.busy = true
    this.inbox.push(prompt)
  }
  async abort(): Promise<void> {
    await this.q.interrupt()
  }
  async setModel(model: string): Promise<void> {
    await this.q.setModel(model)
  }
  async disconnect(): Promise<void> {
    this.inbox.end()
    this.q.close()
  }
  stop = (): Promise<void> => this.disconnect()
}
