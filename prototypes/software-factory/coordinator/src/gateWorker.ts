// Gate workers (code review, security review, evaluator): wait for each without an artificial short limit, and
// replace one that is stuck. The goal's cost limit bounds spending; this only catches a worker that will not finish.
import type { FactoryConfig } from "./config.ts"
import type { Worker } from "./factory.ts"

/** What a stuck check reads from a worker. */
export type Health = Pick<Worker, "status" | "lastActivity" | "failedTools" | "toolsInFlight" | "lastError">

/**
 * Why a worker is stuck, or null while it works. Signals, not a clock: it ended in error, its tool calls keep
 * failing, or it has been silent (no model or tool event) for `quiet_minutes` while no tool call is running. A long
 * build or test run is a running tool call, so it is never "silent".
 */
export const stuckReason = (w: Health, nowMs: number, c: FactoryConfig): string | null => {
  if (w.status === "error") return `failed: ${w.lastError ?? "session error"}`
  if (w.failedTools >= c.workers.stuck_failed_tools) return `${w.failedTools} tool calls failed in a row`
  const quiet = nowMs - w.lastActivity
  if (w.status === "running" && w.toolsInFlight === 0 && quiet >= c.workers.stuck_quiet_minutes * 60_000)
    return `silent for ${Math.round(quiet / 60_000)} min with no tool running`
  return null
}

/** The backstop wait per gate worker: `SF_SECURITY_TIMEOUT_MS` (tests), else `[workers] wait_minutes`. */
export const gateWaitMs = (c: FactoryConfig, env = process.env): number =>
  Number(env.SF_SECURITY_TIMEOUT_MS) || c.workers.wait_minutes * 60_000

const POLL_MS = 30_000

/**
 * Start a gate worker and wait until it is idle. A stuck worker, or one past the backstop, is stopped and a fresh
 * one starts with the same task, at most `[workers] retries` times; then the gate fails with the reason.
 */
export const awaitGateWorker = async (
  start: () => Promise<Worker>,
  what: string,
  stop: (id: string) => Promise<void>,
  c: FactoryConfig,
  poll = POLL_MS,
): Promise<Worker> => {
  let why = ""
  for (let attempt = 0; attempt <= c.workers.retries; attempt++) {
    const w = await start()
    const deadline = Date.now() + gateWaitMs(c)
    for (;;) {
      const idle = await w.waitIdle(Math.min(poll, Math.max(1, deadline - Date.now())))
      const stuck = stuckReason(w, Date.now(), c)
      if (idle && !stuck) return w
      if (stuck || Date.now() >= deadline) {
        why = stuck ?? `still running after ${Math.round(gateWaitMs(c) / 60_000)} min`
        break
      }
    }
    console.error(
      `[gate] ${what} worker ${w.id} ${why}; ${attempt < c.workers.retries ? "starting a fresh one" : "giving up"}`,
    )
    await stop(w.id).catch(() => {})
  }
  throw new Error(`${what} worker ${why} (after ${c.workers.retries + 1} tries)`)
}
