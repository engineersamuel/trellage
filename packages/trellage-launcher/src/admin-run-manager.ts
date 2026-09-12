/**
 * Per-profile async doctor/diagnostic run orchestration, built entirely on
 * top of the existing `CommandRunner` abstraction from `guide-launch.ts`
 * (no new subprocess-spawning code is introduced here). Guarantees at most
 * one in-flight run per profile, real cancellation via `AbortController`
 * (the underlying runner already escalates SIGTERM -> SIGKILL on abort),
 * and a bounded, in-memory, session-scoped run history per profile.
 */
import type { CommandRunner, CommandRunnerError } from "./guide-launch.ts"

export type AdminRunTerminalState = "success" | "failure" | "cancelled" | "timed-out"
export type AdminRunState = "idle" | "running" | AdminRunTerminalState

export interface AdminRunRecord {
  readonly state: AdminRunTerminalState
  readonly stdout: string
  readonly stderr: string
  readonly startedAt: number
  readonly endedAt: number
}

export interface AdminRunStatus {
  readonly ref: string
  readonly state: AdminRunState
  readonly latest?: AdminRunRecord
  /** Bounded, session-scoped only — never persisted to disk. Oldest entries are evicted past the cap. */
  readonly history: ReadonlyArray<AdminRunRecord>
}

export interface AdminRunManagerOptions {
  readonly runner: CommandRunner
  readonly timeoutMs?: number
  readonly historyCap?: number
  readonly now?: () => number
}

interface InFlightRun {
  readonly controller: AbortController
  readonly promise: Promise<void>
}

const defaultHistoryCap = 5
const defaultTimeoutMs = 30_000

const isCommandRunnerError = (error: unknown): error is CommandRunnerError =>
  error instanceof Error && error.name === "CommandRunnerError"

/**
 * Manages doctor/diagnostic runs for any number of profiles. Each profile is
 * tracked independently by `ref` — a failure or cancellation for one profile
 * never affects another profile's state.
 */
export class AdminRunManager {
  private readonly runner: CommandRunner
  private readonly timeoutMs: number
  private readonly historyCap: number
  private readonly now: () => number
  private readonly inFlight = new Map<string, InFlightRun>()
  private readonly history = new Map<string, Array<AdminRunRecord>>()
  private readonly states = new Map<string, AdminRunState>()

  constructor(options: AdminRunManagerOptions) {
    this.runner = options.runner
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs
    this.historyCap = options.historyCap ?? defaultHistoryCap
    this.now = options.now ?? (() => Date.now())
  }

  status(ref: string): AdminRunStatus {
    const history = this.history.get(ref) ?? []
    return {
      ref,
      state: this.states.get(ref) ?? "idle",
      ...(history.length > 0 ? { latest: history[history.length - 1] } : {}),
      history,
    }
  }

  /** Triggers a run for the profile. If one is already in flight, this attaches to it instead of spawning a second process. */
  trigger(ref: string, executable: string, args: ReadonlyArray<string>, options?: { readonly timeoutMs?: number }): Promise<void> {
    const existing = this.inFlight.get(ref)
    if (existing !== undefined) return existing.promise
    return this.startRun(ref, executable, args, options?.timeoutMs)
  }

  /** Re-issues a fresh, independent run for the profile, regardless of its previous terminal state. */
  retry(ref: string, executable: string, args: ReadonlyArray<string>, options?: { readonly timeoutMs?: number }): Promise<void> {
    if (this.inFlight.has(ref)) return this.inFlight.get(ref)!.promise
    return this.startRun(ref, executable, args, options?.timeoutMs)
  }

  /** Cancels the in-flight run for the profile, if any. No-ops when nothing is running. */
  cancel(ref: string): void {
    this.inFlight.get(ref)?.controller.abort()
  }

  /** Waits for the current run before a caller needs a new observation after a mutation. */
  waitForIdle(ref: string): Promise<void> {
    return this.inFlight.get(ref)?.promise ?? Promise.resolve()
  }

  private startRun(ref: string, executable: string, args: ReadonlyArray<string>, timeoutMsOverride?: number): Promise<void> {
    const controller = new AbortController()
    const startedAt = this.now()
    this.states.set(ref, "running")
    const promise = this.runner
      .run(executable, args, { timeoutMs: timeoutMsOverride ?? this.timeoutMs, signal: controller.signal })
      .then((result) => {
        this.record(ref, { state: "success", stdout: result.stdout, stderr: result.stderr, startedAt, endedAt: this.now() })
      })
      .catch((error: unknown) => {
        const terminal = this.classifyFailure(error, controller.signal.aborted)
        const stdout = isCommandRunnerError(error) ? error.stdout : ""
        const stderr = isCommandRunnerError(error) ? error.stderr : String(error)
        this.record(ref, { state: terminal, stdout, stderr, startedAt, endedAt: this.now() })
      })
      .finally(() => {
        this.inFlight.delete(ref)
      })
    this.inFlight.set(ref, { controller, promise })
    return promise
  }

  private classifyFailure(error: unknown, aborted: boolean): AdminRunTerminalState {
    if (aborted || (isCommandRunnerError(error) && error.kind === "aborted")) return "cancelled"
    if (isCommandRunnerError(error) && error.kind === "timed-out") return "timed-out"
    return "failure"
  }

  private record(ref: string, entry: AdminRunRecord): void {
    this.states.set(ref, entry.state)
    const existing = this.history.get(ref) ?? []
    const next = [...existing, entry]
    this.history.set(ref, next.length > this.historyCap ? next.slice(next.length - this.historyCap) : next)
  }
}
