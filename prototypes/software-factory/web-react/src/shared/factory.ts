// Worker events for the raw-event view, and the event text helper. App-wide state lives in ../state/store.
import { Effect, Fiber, Schema, Stream } from "effect";
import { useEffect, useState } from "react";
import { RESYNC, type FeedEvent } from "../../../shared/feed";
import { json, type HttpError } from "../../../shared/http";
import { StoredEvent, type Settings as SettingsT, type SettingsOptions as SettingsOptionsT, type Worker as WorkerT } from "../../../shared/schemas";
import { feed } from "../state/store";

export type { FeedEvent };
export type Worker = WorkerT;
export type Settings = SettingsT;
export type SettingsOptions = SettingsOptionsT;

const MAX_EVENTS = 2000;

/**
 * Raw Copilot SDK events for one worker: backlog + live tail. Local to the open panel (not app state),
 * run as one Effect fiber that stops when the panel closes or the worker changes.
 */
export function useWorkerEvents(id: string | null): FeedEvent[] {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    if (!id) return;
    const backlog = json(`/api/workers/${encodeURIComponent(id)}/events`, Schema.Array(StoredEvent)).pipe(
      Effect.map((log) => log as readonly FeedEvent[]),
      Effect.catch((e: HttpError) => Effect.logWarning(`${e.url}: ${e.reason}`).pipe(Effect.as(null))),
    );
    let backlogMax = -1;
    let loaded = false;
    const pending: FeedEvent[] = [];
    const load = backlog.pipe(
      Effect.map((log) => {
        if (!log) return;
        backlogMax = log.at(-1)?.seq ?? -1;
        loaded = true;
        setEvents([...log, ...pending.filter((e) => e.seq > backlogMax)].slice(-MAX_EVENTS));
        pending.length = 0;
      }),
    );
    const program = Effect.gen(function* () {
      // Subscribe first, so nothing between the backlog and the live tail is lost.
      const live = yield* feed.pipe(
        Stream.runForEach((ev) =>
          Effect.sync(() => {
            if (ev.type === RESYNC) return void ((loaded = false), Effect.runFork(load));
            if (ev.workerId !== id) return;
            if (!loaded) pending.push(ev);
            // A restarted coordinator numbers events from a lower start; take them anyway.
            else if (ev.seq > backlogMax || ev.seq < backlogMax - 1e9) setEvents((es) => [...es.slice(-(MAX_EVENTS - 1)), ev]);
          }),
        ),
        Effect.forkChild,
      );
      yield* load;
      yield* Fiber.join(live);
    });
    const fiber = Effect.runFork(program);
    return () => void Effect.runFork(Fiber.interrupt(fiber));
  }, [id]);
  return events;
}

/** One-line summary of a raw Copilot SDK event for the peer view. */
export function describe(ev: FeedEvent): string {
  const d = ev.data ?? {};
  switch (ev.type) {
    case "assistant.message_delta":
      return d.deltaContent ?? "";
    case "assistant.message":
      return d.content ?? "";
    case "user.message":
      return d.content ?? "";
    case "tool.execution_start":
      return `${d.toolName} ${JSON.stringify(d.arguments ?? {}).slice(0, 200)}`;
    case "tool.execution_complete":
      return `${d.success ? "ok" : "failed"} ${(d.result?.content ?? d.error?.message ?? "").slice(0, 200)}`;
    case "session.error":
      return d.message ?? "";
    case "subagent.started":
      return `${d.agentDisplayName ?? d.agentName}: ${d.agentDescription ?? ""}`;
    default:
      return JSON.stringify(d).slice(0, 160);
  }
}
