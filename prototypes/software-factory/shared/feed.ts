// One live connection to the factory feed per page, shared by every subscriber.
// Browsers allow only 6 HTTP/1.1 connections per server across all tabs, so one EventSource
// per widget starves a second tab (requests hang). Subscribers filter events themselves.

export type FeedEvent = { seq: number; workerId: string; type: string; agentId: string | null; timestamp: string; data: any }

const subs = new Set<(ev: FeedEvent) => void>()
let es: EventSource | null = null
let lastData = Date.now()
/** Set once the server's data heartbeat is seen; older servers only send invisible comments. */
let heartbeat = false
/** Server sends a data heartbeat on connect and every 5 s; silence longer than this means a dead connection. */
const STALE_MS = 12_000
export const RESYNC = "factory.feed_reconnected"

const emitResync = () => {
  for (const s of subs) s({ seq: -1, workerId: "", type: RESYNC, agentId: null, timestamp: String(Date.now()), data: null })
}

/** Highest event seq seen; after a gap the server replays what came later. */
let lastSeq = 0

// After any gap (coordinator restart, dev proxy error, sleep, a silently dead connection) we reconnect
// with ?since=lastSeq. The server replays the stored events, then sends factory.feed_replay. Only when
// it could not replay everything (or we have no seq yet) do subscribers reload their state.
const connect = (afterGap: boolean) => {
  es?.close()
  const resume = () => (lastSeq > 0 ? `?since=${lastSeq}` : "")
  const me = new EventSource(`/api/feed${afterGap ? resume() : ""}`)
  es = me
  let gap = afterGap
  /** Waiting for the server's replay marker; it decides whether a reload is needed. */
  let replaying = afterGap && lastSeq > 0
  /** The browser resends the last SSE id when it reconnects by itself; then the server replays too. */
  let sawId = replaying
  me.onopen = () => {
    lastData = Date.now()
    if (gap && !replaying) (gap = false), emitResync()
  }
  me.onerror = () => {
    gap = true
    replaying = sawId
    // CLOSED: the browser gave up (e.g. a 5xx from the dev proxy). Retry ourselves.
    if (me.readyState === EventSource.CLOSED && es === me) (es = null), setTimeout(() => subs.size && !es && connect(true), 2000)
  }
  me.onmessage = (m) => {
    lastData = Date.now()
    if (m.lastEventId) sawId = true
    const ev = JSON.parse(m.data) as FeedEvent
    if (ev.type === "factory.ping") return void (heartbeat = true)
    if (ev.type === "factory.feed_replay") {
      replaying = gap = false
      if (!ev.data?.complete) emitResync()
      return
    }
    if (ev.seq > lastSeq) lastSeq = ev.seq
    for (const s of subs) s(ev)
  }
}

let watching = false
const watch = () => {
  if (watching) return
  watching = true
  setInterval(() => heartbeat && subs.size && Date.now() - lastData > STALE_MS && connect(true), 3_000)
  // Laptop sleep or a background tab can miss events without an error: resync when the tab shows again.
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && heartbeat && subs.size && Date.now() - lastData > STALE_MS && connect(true))
}

/** Subscribe to every factory feed event. Returns an unsubscribe function. */
export const onFeed = (cb: (ev: FeedEvent) => void): (() => void) => {
  subs.add(cb)
  if (!es) connect(false)
  watch()
  return () => {
    subs.delete(cb)
    if (subs.size === 0) (es?.close(), (es = null))
  }
}

/** Called after every feed gap: reload whatever state the subscriber shows. */
export const onResync = (cb: () => void): (() => void) => onFeed((ev) => ev.type === RESYNC && cb())

/**
 * Append `ev` to an agent's event log, dropping streaming fragments once they are no longer needed,
 * so a long run keeps its first message instead of filling the log with deltas.
 *   - assistant.streaming_delta: never kept (byte counters only);
 *   - message / reasoning deltas: removed when the full assistant.message / assistant.reasoning arrives;
 *   - tool_call_delta: only the latest is kept (the live activity line needs just one).
 */
export const appendCompact = <E extends { type: string; data: any }>(log: E[], ev: E, cap: number): void => {
  const d = ev.data ?? {}
  const drop = (pred: (e: E) => boolean) => {
    for (let i = log.length - 1; i >= 0; i--) if (pred(log[i]!)) log.splice(i, 1)
  }
  if (ev.type === "assistant.streaming_delta") return
  if (ev.type === "assistant.message") drop((e) => e.type === "assistant.message_delta" && e.data?.messageId === d.messageId)
  if (ev.type === "assistant.reasoning") drop((e) => e.type === "assistant.reasoning_delta" && e.data?.reasoningId === d.reasoningId)
  // A call's input deltas fold into one event (the transcript streams it) until the call starts; then it is dropped.
  if (ev.type === "assistant.tool_call_delta") {
    let prev: E | undefined
    for (let i = log.length - 1; i >= 0 && !prev; i--) if (log[i]!.type === "assistant.tool_call_delta" && log[i]!.data?.toolCallId === d.toolCallId) prev = log[i]

    if (prev) return void (prev.data = { ...prev.data, ...d, inputDelta: `${prev.data.inputDelta ?? ""}${d.inputDelta ?? ""}` })
  }
  if (ev.type === "tool.execution_start") drop((e) => e.type === "assistant.tool_call_delta" && e.data?.toolCallId === d.toolCallId)
  log.push(ev)
  if (log.length > cap) log.splice(0, log.length - cap)
}
