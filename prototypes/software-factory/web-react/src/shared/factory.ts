import { useEffect, useMemo, useState } from "react";
import { onFeed, RESYNC } from "../../../shared/feed";
import { Effect, Schema } from "effect";
import { fire, json, runOr, send } from "../../../shared/http";
import { Steps, StoredEvent, Worker as WorkerSchema, type SecurityReview as Review } from "../../../shared/schemas";

export type Worker = typeof WorkerSchema.Type;

export type FeedEvent = {
  seq: number;
  workerId: string;
  type: string;
  agentId: string | null;
  timestamp: string;
  data: any;
};

/** Live worker list: initial fetch + factory.* events from the raw feed. */
export function useWorkers(): Worker[] {
  const [workers, setWorkers] = useState<Record<string, Worker>>({});
  useEffect(() => {
    const load = () =>
      // A failed or malformed response keeps the last good list.
      void runOr(json("/api/workers", Schema.Array(WorkerSchema)), null).then((ws) => ws && setWorkers(Object.fromEntries(ws.map((w) => [w.id, w]))));
    load();
    return onFeed((ev) => {
      if (ev.type === RESYNC) load();
      else if (ev.type === "factory.worker_started" || ev.type === "factory.worker_updated") {
        setWorkers((ws) => ({ ...ws, [ev.data.id]: ev.data }));
      } else if (ev.type === "factory.worker_stopped") {
        setWorkers(({ [ev.data.id]: _, ...rest }) => rest);
      }
    });
  }, []);
  return useMemo(
    () => Object.values(workers).sort((a, b) => (a.role === "coordinator" ? -1 : b.role === "coordinator" ? 1 : a.name.localeCompare(b.name))),
    [workers],
  );
}

/** Raw Copilot SDK events for one worker: backlog + live tail. */
export function useWorkerEvents(id: string | null): FeedEvent[] {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    if (!id) return;
    let backlogMax = -1;
    const pending: FeedEvent[] = [];
    let loaded = false;
    const load = () => {
      loaded = false;
      pending.length = 0;
      void runOr(json(`/api/workers/${encodeURIComponent(id)}/events`, Schema.Array(StoredEvent)), null)
        .then((log) => {
          if (!log) return;
          backlogMax = log.at(-1)?.seq ?? -1;
          loaded = true;
          setEvents([...log, ...pending.filter((e) => e.seq > backlogMax)]);
        });
    };
    const off = onFeed((ev) => {
      if (ev.type === RESYNC) return load();
      if (ev.workerId !== id) return;
      if (!loaded) pending.push(ev);
      else if (ev.seq > backlogMax || ev.seq < backlogMax - 1e9) setEvents((es) => [...es.slice(-1999), ev]);
    });
    load();
    return off;
  }, [id]);
  return events;
}

export const api = {
  stop: (id: string) => fire(send(`/api/workers/${encodeURIComponent(id)}`, "DELETE")),
  message: (id: string, prompt: string) => fire(send(`/api/workers/${encodeURIComponent(id)}/message`, "POST", { prompt })),
  abort: (id: string) => fire(send(`/api/workers/${encodeURIComponent(id)}/abort`, "POST")),
};

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

// ---------- Security review (runs after every implement step) ----------

export type SecurityReview = Review;

/** Security reviews from /api/steps, refetched on every factory.security_review event. */
export function useSecurityReviews(): readonly SecurityReview[] {
  const [reviews, setReviews] = useState<readonly SecurityReview[]>([]);
  useEffect(() => {
    const load = () => void runOr(json("/api/steps", Steps), null).then((d) => d && setReviews(d.securityReviews));
    load();
    return onFeed((ev) => {
      if (ev.type === "factory.security_review") load();
    });
  }, []);
  return reviews;
}

// ---------- Settings (agent access parity) ----------

export type Palette = { bg: string; surface: string; border: string; text: string; muted: string; accent: string };
export type Cron = { everySeconds: number; prompt: string; enabled: boolean };
export type Settings = {
  theme: string;
  themes: Record<string, Palette>;
  layout: { panel: "right" | "left" | "hidden"; panelWidth: number };
  navbar: string[];
  animations: boolean;
  hotkeys: Record<string, string>;
  focus: string;
  banner: string | null;
  agent: { model: string; reasoningEffort: string; disabledTools: string[]; instructions: string };
  crons: Record<string, Cron>;
  extensions: Record<string, { slot: string; js: string; css: string; enabled: boolean; description: string }>;
  repo: string;
};
export type SettingsOptions = {
  navbarItems: string[];
  panelPositions: string[];
  hotkeyActions: string[];
  efforts: string[];
  toolKinds: string[];
  models: string[];
};

/** Factory settings shared with the coordinator agent. Updates live from the feed. */
export function useSettings() {
  const [state, setState] = useState<{ settings: Settings; css: string; options: SettingsOptions } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => void runOr(json("/api/settings", Schema.Unknown), null).then((v) => v && setState(v as never));
    load();
    return onFeed((ev) => {
      if (ev.type === RESYNC) load();
      else if (ev.type === "factory.settings_updated") setState((s) => s && { ...s, settings: ev.data.settings, css: ev.data.css });
    });
  }, []);
  const patch = async (p: unknown) => {
    setError(await Effect.runPromise(send("/api/settings", "PATCH", p).pipe(Effect.as(null), Effect.catch((e) => Effect.succeed(e.reason)))));
  };
  return { ...state, error, patch };
}
