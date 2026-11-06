// The zustand store that holds the one Model, and the Effect programs that feed it.
// Components read with `useApp(selector)` and change state only through `dispatch` or the `actions` below.
import { Effect, Fiber, Queue, Schema, Stream } from "effect"
// zustand 5 under an alias: the root "zustand" stays 4.x because OpenUI declares it as a peer (^4.5.5).
import { create } from "zustand5"
import { changes as approvalChanges } from "../../../shared/approvals"
import { onFeed, RESYNC, type FeedEvent } from "../../../shared/feed"
import { json, send, type HttpError } from "../../../shared/http"
import { currentProto, onProto } from "../../../shared/protos"
import { SettingsDocument, Steps, StoredEvent, Threads, Worker, type Thread } from "../../../shared/schemas"
import { Action, feedActions, initial, reduce, type Model } from "./model"

type Store = Model & { readonly dispatch: (a: Action) => void }

// The page layout is read when the store starts (startStore), so importing this module touches no DOM.
export const useApp = create<Store>()((set) => ({
  ...initial(crypto.randomUUID(), 0),
  dispatch: (a) => set((s) => reduce(s, a)),
}))

export const dispatch = (a: Action): void => useApp.getState().dispatch(a)

/** Run an HTTP Effect; a failure is logged and the state stays as it was. */
const load = <A>(effect: Effect.Effect<A, HttpError>, toAction: (a: A) => Action): Effect.Effect<void> =>
  effect.pipe(
    Effect.map((a) => dispatch(toAction(a))),
    Effect.catch((e: HttpError) => Effect.logWarning(`${e.url}: ${e.reason}`)),
  )

export const loadWorkers = load(json("/api/workers", Schema.Array(Worker)), (workers) => Action.WorkersLoaded({ workers }))
/** Settings gate the whole shell, so a failure is stored (the shell shows it with a retry), not only logged. */
export const loadSettings: Effect.Effect<void> = json("/api/settings", SettingsDocument).pipe(
  Effect.map((document) => dispatch(Action.SettingsLoaded({ document }))),
  Effect.catch((e: HttpError) => Effect.sync(() => dispatch(Action.SettingsLoadFailed({ error: e.reason })))),
)
/** Security reviews and Jev step decisions (both from /api/steps). */
export const loadReviews = load(json("/api/steps", Steps), (d) => Action.StepsLoaded({ reviews: d.securityReviews, decisions: d.decisions }))
export const loadThreads = load(json("/api/threads/get", Threads), (d) => Action.ThreadsLoaded({ threads: d.threads }))
/** The agent that runs a thread's chat (same rule as the coordinator: sub- for repo threads, gen- for general). */
export const agentOfThread = (t: Thread | undefined): string =>
  !t || t.desk ? "coordinator" : t.worktree ? `sub-${t.id.slice(0, 8)}` : `gen-${t.id.slice(0, 8)}`

/** Start and end times of one agent's recent tool calls, so a reopened chat shows durations. Live calls come from the feed. */
export const loadToolTimes = (agentId: string): Effect.Effect<void> =>
  json(
    `/api/events?workers=${encodeURIComponent(agentId)}&types=tool.execution_start,tool.execution_complete&perWorker=1000`,
    Schema.Array(StoredEvent),
  ).pipe(
    Effect.map((events) => events.flatMap(feedActions).forEach(dispatch)),
    Effect.catch((e: HttpError) => Effect.logWarning(`${e.url}: ${e.reason}`)),
  )

export const retrySettings = (): void => void Effect.runPromise(loadSettings)

const reloadAll = Effect.all([loadWorkers, loadSettings, loadReviews, loadThreads], { concurrency: "unbounded", discard: true })

/** The factory feed as a Stream (one shared EventSource, see shared/feed.ts). */
export const feed: Stream.Stream<FeedEvent> = Stream.callback<FeedEvent>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => onFeed((ev) => void Queue.offerUnsafe(queue, ev))),
    (off) => Effect.sync(off),
  ),
)

/** Feed events that need a refetch rather than a patch. */
const reloadFor = (type: string): Effect.Effect<void> | null =>
  type === RESYNC ? reloadAll : type === "factory.security_review" || type === "factory.step_decided" ? loadReviews : type === "factory.thread_updated" ? loadThreads : null

/** One program: initial load, then every feed event becomes actions or a reload. */
export const bridge: Effect.Effect<void> = Effect.gen(function* () {
  yield* reloadAll
  yield* Effect.forkChild(loadToolTimes("coordinator"))
  // Decisions come from the shared approvals store (one feed-driven Effect store for both UIs).
  yield* Effect.forkChild(Stream.runForEach(approvalChanges, (a) => Effect.sync(() => dispatch(Action.DecisionsChanged({ decisions: a.all })))))
  yield* feed.pipe(
    Stream.runForEach((ev) => {
      for (const a of feedActions(ev)) dispatch(a)
      return reloadFor(ev.type) ?? Effect.void
    }),
  )
})

/** Start the bridge once per page, plus the layout switcher listener. Returns a stop function. */
export const startStore = (): (() => void) => {
  dispatch(Action.ProtoChanged({ proto: currentProto() }))
  const fiber = Effect.runFork(bridge)
  const offProto = onProto((proto) => dispatch(Action.ProtoChanged({ proto })))
  return () => (offProto(), void Effect.runFork(Fiber.interrupt(fiber)))
}

/** Settings PATCH (RFC 7386 merge). The new settings arrive through the feed; only the error is stored. */
export const patchSettings = (patch: unknown): void =>
  void Effect.runPromise(
    send("/api/settings", "PATCH", patch).pipe(
      Effect.as(null),
      Effect.catch((e: HttpError) => Effect.succeed(e.reason)),
      Effect.map((error) => dispatch(Action.SettingsPatchFinished({ error }))),
    ),
  )

/** The name the panel shows for a worker; its id when it is not in the list. */
const nameOf = (id: string): string => useApp.getState().workers[id]?.name ?? id

/** Run a worker command. A failure goes to the store (the panel shows it); resolves true on success. */
const fire = (failure: (name: string) => string, id: string, effect: Effect.Effect<void, HttpError>): Promise<boolean> =>
  Effect.runPromise(
    effect.pipe(
      Effect.as(true),
      Effect.catch((e: HttpError) => Effect.sync(() => (dispatch(Action.WorkerCommandFailed({ error: `${failure(nameOf(id))}: ${e.reason}` })), false))),
    ),
  )

/** Worker commands. Results come back through the feed; failures through the store. */
export const workerApi = {
  stop: (id: string) => fire((name) => `Could not remove ${name}`, id, send(`/api/workers/${encodeURIComponent(id)}`, "DELETE")),
  message: (id: string, prompt: string) => fire((name) => `Could not send to ${name}`, id, send(`/api/workers/${encodeURIComponent(id)}/message`, "POST", { prompt })),
  abort: (id: string) => fire((name) => `Could not cancel the run of ${name}`, id, send(`/api/workers/${encodeURIComponent(id)}/abort`, "POST")),
}
