import path from "node:path"
import {
  AccountabilityDb,
  accountabilityDbPath,
  accountabilityDimensions,
  backfillAccountability,
  workerBudgets,
} from "./src/accountability.ts"
import { factoryConfig } from "./src/config.ts"
import { totalsOf } from "./src/costs.ts"
import { EventStore } from "./src/events.ts"
import { stateDir } from "./src/statedir.ts"
import { Threads } from "./src/threads.ts"
import { CONTROLS } from "../shared/accountability.ts"

const integer = (args: readonly string[], name: string, fallback: number): number => {
  const index = args.indexOf(name)
  if (index < 0) return fallback
  const raw = args[index + 1]
  const value = Number(raw)
  if (raw === undefined || !Number.isInteger(value) || value < 1) throw new Error(`${name} requires a positive integer`)
  return value
}

const sinceAt = (args: readonly string[]): number | undefined => {
  const index = args.indexOf("--since")
  if (index < 0) return undefined
  const raw = args[index + 1]
  if (raw === undefined) throw new Error("--since requires a timestamp or ISO date")
  const value = Number.isFinite(Number(raw)) ? Number(raw) : Date.parse(raw)
  if (!Number.isFinite(value)) throw new Error("--since requires a timestamp or ISO date")
  return value
}

const options = (args: readonly string[], allowed: readonly string[]): void => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (allowed.includes(arg)) {
      i++
      if (args[i] === undefined) throw new Error(`${arg} requires a value`)
    } else throw new Error(`unknown option ${arg}`)
  }
}

const workerStarts = (store: EventStore) =>
  (
    store.latestTimed("factory.worker_started", 100_000) as {
      ts: number
      data: { id?: unknown; role?: unknown; step?: unknown }
    }[]
  )
    .filter((row) => typeof row.data.id === "string")
    .map((row) => ({
      worker: String(row.data.id),
      role: String(row.data.role ?? ""),
      step: typeof row.data.step === "string" ? row.data.step : null,
      timestamp: new Date(row.ts).toISOString(),
    }))

const workerStops = (store: EventStore) =>
  (store.latestTimed("factory.worker_stopped", 100_000) as { ts: number; data: { id?: unknown } }[])
    .filter((row) => typeof row.data.id === "string")
    .map((row) => ({ worker: String(row.data.id), timestamp: new Date(row.ts).toISOString() }))

const workerCosts = (store: EventStore, usdPerAiCredit: number) => {
  const rates = store.rates()
  const costs = new Map<string, number>()
  for (const row of store.usageRows()) {
    const cost = totalsOf(row, rates[row.model], usdPerAiCredit)
    costs.set(row.worker, (costs.get(row.worker) ?? 0) + cost.usd)
  }
  return [...costs].map(([worker, costUsd]) => ({ worker, costUsd }))
}

const publish = (store: EventStore, worker: string, type: string, data: unknown): void => {
  store.append({
    seq: store.maxSeq() + 1,
    workerId: worker,
    type,
    agentId: null,
    timestamp: String(Date.now()),
    data,
  })
}

const label = (db: AccountabilityDb, args: readonly string[]) => {
  if (args.length !== 3) throw new Error("usage: sf accountability label WORKER CONTROL pass|fail")
  const control = CONTROLS.find((item) => item.id === args[1])?.id
  const value = args[2]
  if (!control) throw new Error(`unknown control ${args[1]}`)
  if (value !== "pass" && value !== "fail") throw new Error("label must be pass or fail")
  const at = Date.now()
  db.label(args[0]!, control, value, at)
  return { worker: args[0]!, control, label: value, at }
}

/** Run accountability operations directly against the state databases, without starting an agent conversation. */
export const accountabilityCommand = async (args: readonly string[]): Promise<unknown> => {
  const [command, ...rest] = args
  const root = stateDir()
  if (!command)
    throw new Error(
      "usage: sf accountability [backfill [--since DATE] [--limit N]|label WORKER CONTROL pass|fail|budgets]",
    )
  const store = new EventStore(path.join(root, "events.db"))
  const db = new AccountabilityDb(accountabilityDbPath(root))
  try {
    switch (command) {
      case "backfill": {
        options(rest, ["--since", "--limit"])
        if (!factoryConfig().accountability.enabled) throw new Error("accountability is disabled")
        return await backfillAccountability({
          store,
          db,
          config: factoryConfig(),
          dimensions: accountabilityDimensions(new Threads(root)),
          publish: (worker, type, data) => publish(store, worker, type, data),
          since: sinceAt(rest),
          limit: integer(rest, "--limit", Number.MAX_SAFE_INTEGER),
        })
      }
      case "label":
        return label(db, rest)
      case "budgets":
        if (rest.length) throw new Error("usage: sf accountability budgets")
        return workerBudgets(
          workerCosts(store, factoryConfig().costs.usd_per_ai_credit),
          workerStarts(store),
          workerStops(store),
        )
      default:
        throw new Error(`unknown accountability command ${command}`)
    }
  } finally {
    db.close()
    store.close()
  }
}
