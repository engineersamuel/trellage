import { useEffect, useMemo, useRef, useState } from "react";
import { api, describe, type FeedEvent, type Worker, useWorkerEvents } from "./factory";
import "./panel.css";
import { agentLabel, workerTree } from "../../../shared/tree";

const dot: Record<string, string> = { idle: "#16a34a", running: "#f59e0b", error: "#dc2626" };

/** Worker list + drill-down into one worker's raw Copilot SDK event stream. */
export function WorkerPanel({ workers, selected, onSelect: setSelected }: { workers: Worker[]; selected: string; onSelect: (id: string) => void }) {
  const current = workers.find((w) => w.id === selected) ?? null;

  return (
    <div className="sf-panel">
      <div data-slot="panel-top" />
      <section className="sf-workers">
        <h3>Agents ({workers.length})</h3>
        {workerTree(workers).map(({ w, depth }) => (
          <WorkerRow key={w.id} w={w} depth={depth} active={w.id === selected} onClick={() => setSelected(w.id)} />
        ))}
      </section>
      {current && <Peer w={current} />}
    </div>
  );
}

function WorkerRow({ w, depth, active, onClick }: { w: Worker; depth: number; active: boolean; onClick: () => void }) {
  return (
    <button className={`sf-row ${active ? "active" : ""}`} style={{ paddingLeft: 8 + depth * 22 }} onClick={onClick}>
      {depth > 0 && <span className="sf-branch">└</span>}
      <span className="sf-dot" style={{ background: dot[w.status] ?? "#999" }} />
      <span className={`sf-tag sf-tag-${agentLabel(w).kind}`}>{agentLabel(w).tag}</span>
      <b>{agentLabel(w).name}</b>
      <span className="sf-meta">
        {w.status} · {w.auth} · pid {w.pid ?? "?"} · {w.rssKb ? Math.round(w.rssKb / 1024) + " MB" : ""}
      </span>
    </button>
  );
}

type Line = { key: number; type: string; agentId: string | null; text: string };

/** Collapse message deltas so the peer view reads like a transcript. */
function toLines(events: FeedEvent[], showAll: boolean): Line[] {
  const out: Line[] = [];
  for (const ev of events) {
    if (ev.type === "assistant.message_delta") {
      const last = out.at(-1);
      if (last && last.type === "assistant.stream" && last.agentId === ev.agentId) {
        last.text += ev.data.deltaContent ?? "";
        continue;
      }
      out.push({ key: ev.seq, type: "assistant.stream", agentId: ev.agentId, text: ev.data.deltaContent ?? "" });
      continue;
    }
    if (ev.type === "assistant.message") {
      const last = out.at(-1);
      if (last?.type === "assistant.stream") {
        last.type = "assistant.message";
        continue;
      }
    }
    const interesting = /^(user\.message|assistant\.message|tool\.|subagent\.|session\.(error|idle))/.test(ev.type);
    if (!showAll && !interesting) continue;
    if (ev.type === "assistant.message" && !ev.data.content) continue;
    out.push({ key: ev.seq, type: ev.type, agentId: ev.agentId, text: describe(ev) });
  }
  return out;
}

function Peer({ w }: { w: Worker }) {
  const events = useWorkerEvents(w.id);
  const [showAll, setShowAll] = useState(false);
  const [raw, setRaw] = useState(false);
  const [prompt, setPrompt] = useState("");
  const lines = useMemo(() => toLines(events, showAll), [events, showAll]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [lines.length]);

  return (
    <section className="sf-peer">
      <header>
        <h3>
          {w.name} <small>{w.id}</small>
        </h3>
        <div className="sf-meta">
          {w.model} · {w.auth === "proxy" ? "copilot-proxy-rs" : "native Copilot"} · COPILOT_HOME {w.home}
        </div>
        <div className="sf-actions">
          <label>
            <input type="checkbox" checked={raw} onChange={(e) => setRaw(e.target.checked)} /> raw events
          </label>
          {raw && (
            <label>
              <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> all events
            </label>
          )}
          <button onClick={() => api.abort(w.id)}>Abort</button>
          {w.role !== "coordinator" && <button onClick={() => api.stop(w.id)}>Stop</button>}
        </div>
      </header>
      {!raw && <div key={w.id} className="sf-log" data-transcript-scroll><div data-transcript={w.id} /></div>}
      {raw && <div className="sf-log">
        {lines.map((l) => (
          <div key={l.key} className={`sf-ev sf-${l.type.replace(/\./g, "-")}`}>
            <span className="sf-type">
              {l.type}
              {l.agentId ? ` [${l.agentId.slice(0, 8)}]` : ""}
            </span>
            <span className="sf-text">{l.text}</span>
          </div>
        ))}
        <div ref={end} />
      </div>}
      <form
        className="sf-send"
        onSubmit={(e) => {
          e.preventDefault();
          if (!prompt) return;
          api.message(w.id, prompt);
          setPrompt("");
        }}
      >
        <input placeholder={`message ${w.name} directly`} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <button type="submit">Send</button>
      </form>
    </section>
  );
}
