// Approval state shared by every UI part (decision center, conversation sidebar, prototype layouts, Foldkit host).
// One Effect store: GET /api/approvals is decoded with a Schema into a SubscriptionRef. The store reloads on
// every factory.approval_* feed event and after a feed gap. A newer reload interrupts an older one (switchMap),
// so a slow old response can never overwrite a newer list. A failed reload keeps the last good list.
import { Effect, Fiber, Queue, Schema, Stream, SubscriptionRef } from "effect"
import { onFeed, RESYNC } from "./feed"
import { HttpError, json } from "./http"

const withDefault = <S extends Schema.Top>(value: S["Encoded"]) => Schema.withDecodingDefaultKey<S>(Effect.succeed(value))

export const Shadow = Schema.Struct({
  pick: Schema.NullOr(Schema.String),
  confidence: Schema.Number,
  covered: Schema.Number.pipe(withDefault(0)),
  probabilities: Schema.optionalKey(Schema.Record(Schema.String, Schema.Number)),
})

/** One decision. Older stored rows lack kind, context, allowText and optionDetails: they decode to defaults. */
export const Decision = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["approval", "question"]).pipe(withDefault("approval")),
  threadId: Schema.NullOr(Schema.String).pipe(withDefault(null)),
  title: Schema.String,
  summary: Schema.String.pipe(withDefault("")),
  options: Schema.Array(Schema.String).pipe(withDefault([])),
  optionDetails: Schema.Array(Schema.String).pipe(withDefault([])),
  allowText: Schema.Boolean.pipe(withDefault(false)),
  context: Schema.String.pipe(withDefault("coordinator")),
  status: Schema.Literals(["pending", "answered"]),
  answer: Schema.NullOr(Schema.String).pipe(withDefault(null)),
  note: Schema.NullOr(Schema.String).pipe(withDefault(null)),
  createdAt: Schema.Number,
  reportThreadId: Schema.optionalKey(Schema.String),
  /** What is decided: a plan before implement, review findings, shipping the branch, or anything else. */
  topic: Schema.Literals(["plan", "findings", "ship", "other"]).pipe(withDefault("other")),
  /** Shadow mode: undefined while Jev predicts, null when no prediction is available. */
  shadow: Schema.optionalKey(Schema.NullOr(Shadow)),
})
export type Decision = typeof Decision.Type
/** Decode one row. Exported so a caller with its own "effect" copy (the coordinator) uses this copy's decoder. */
export const decodeDecision = Schema.decodeUnknownExit(Decision)

/** GET /api/approvals/:id also returns the title of the decision's conversation. */
export const DecisionDetail = Schema.Struct({ ...Decision.fields, threadTitle: Schema.NullOr(Schema.String).pipe(withDefault(null)) })
export type DecisionDetail = typeof DecisionDetail.Type

/** Errors of the approvals API are HTTP or decode errors. */
export type ApprovalsError = HttpError
export { HttpError }

export type Approvals = {
  /** Every decision, as the coordinator returns it. */
  readonly all: ReadonlyArray<Decision>
  /** Waiting decisions, oldest first. */
  readonly pending: ReadonlyArray<Decision>
  /** False until the first list arrived. */
  readonly loaded: boolean
}

export const EMPTY: Approvals = { all: [], pending: [], loaded: false }

export const toApprovals = (all: ReadonlyArray<Decision>): Approvals => ({
  all,
  pending: all.filter((d) => d.status === "pending").sort((a, b) => a.createdAt - b.createdAt),
  loaded: true,
})

// ---------- HTTP ----------

export const fetchAll: Effect.Effect<ReadonlyArray<Decision>, ApprovalsError> = json("/api/approvals", Schema.Array(Decision))

export const fetchOne = (id: string): Effect.Effect<DecisionDetail, ApprovalsError> =>
  json(`/api/approvals/${encodeURIComponent(id)}`, DecisionDetail)

/** Send the human's answer. The store drops the decision from pending at once; the feed event confirms it. */
export const answer = (id: string, choice: string, note: string | null): Effect.Effect<void, ApprovalsError> =>
  json(`/api/approvals/${encodeURIComponent(id)}`, Schema.Unknown, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ answer: choice, note }),
  }).pipe(
    Effect.andThen(SubscriptionRef.update(store.ref, (s) => ({ ...s, pending: s.pending.filter((d) => d.id !== id) }))),
  )

// ---------- store ----------

export type Store = {
  readonly ref: SubscriptionRef.SubscriptionRef<Approvals>
  /** Runs forever: one load at start, then one per trigger; a newer load interrupts an older one. */
  readonly run: Effect.Effect<void>
}

/** Build a store from a loader and a stream of reload triggers (tests pass their own). */
export const makeStore = (load: Effect.Effect<ReadonlyArray<Decision>, ApprovalsError>, triggers: Stream.Stream<void>): Store => {
  const ref = Effect.runSync(SubscriptionRef.make(EMPTY))
  const reload = load.pipe(
    Effect.flatMap((all) => SubscriptionRef.set(ref, toApprovals(all))),
    Effect.catch((e: ApprovalsError) => Effect.logWarning(`approvals: reload failed, keeping the last list: ${e.reason}`)),
  )
  const run = Stream.make(undefined).pipe(
    Stream.concat(triggers),
    Stream.switchMap(() => Stream.fromEffect(reload)),
    Stream.runDrain,
  )
  return { ref, run }
}

const isReloadEvent = (type: string) => type === RESYNC || type.startsWith("factory.approval_")

/** Feed events that change approvals (requested, answered, shadowed) and feed gaps. */
const feedTriggers: Stream.Stream<void> = Stream.callback<void>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => onFeed(({ type }) => void (isReloadEvent(type) && Queue.offerUnsafe(queue, undefined)))),
    (off) => Effect.sync(off),
  ),
)

const store = makeStore(fetchAll, feedTriggers)
let running: Fiber.Fiber<void> | null = null
const start = () => void (running ??= Effect.runFork(store.run))

/** Current approvals, then every change. For Effect hosts (Foldkit Subscriptions). */
export const changes: Stream.Stream<Approvals> = Stream.unwrap(Effect.sync(() => (start(), SubscriptionRef.changes(store.ref))))

/** Plain-DOM adapter: calls back with the current approvals and every change. Returns unsubscribe. */
export const subscribeApprovals = (cb: (a: Approvals) => void): (() => void) => {
  const fiber = Effect.runFork(Stream.runForEach(changes, (a) => Effect.sync(() => cb(a))))
  return () => void Effect.runFork(Fiber.interrupt(fiber))
}

/** Run an approvals Effect from plain DOM code. */
export const runApprovals = <A>(effect: Effect.Effect<A, ApprovalsError>): Promise<A> => Effect.runPromise(effect)
