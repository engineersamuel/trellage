import { useEffect, useState } from "react";
import { api, type Settings, type SettingsOptions, type Worker, useSecurityReviews, useSettings, useWorkers } from "./factory";
import { WorkerPanel } from "./WorkerPanel";
import { setExtensionWorkers, syncExtensions } from "../../../shared/extensions";
import { currentProto, onProto } from "../../../shared/protos";

/** Empty mount point for agent-written extensions. React never renders children into it. */
const Slot = ({ name, className }: { name: string; className?: string }) => <div data-slot={name} className={className} />;

type S = ReturnType<typeof useSettings>;

/** Shell shared by the factory UI: live theme, navbar, settings drawer, hotkeys, worker panel. */
export function FactoryShell({ title, chat }: { title: string; chat: React.ReactNode }) {
  const s = useSettings();
  const workers = useWorkers();
  const [open, setOpen] = useState(false);
  const [proto, setProto] = useState(currentProto);
  useEffect(() => onProto(setProto), []);
  useHotkeys(s, () => setOpen((o) => !o));
  useEffect(() => {
    if (s.settings) syncExtensions(s.settings, "copilotkit");
  });
  useEffect(() => setExtensionWorkers(workers), [workers]);
  // Worker links in the transcript select that worker.
  useEffect(() => {
    const on = (e: Event) => s.patch({ focus: (e as CustomEvent<string>).detail });
    window.addEventListener("sf:select-worker", on);
    return () => window.removeEventListener("sf:select-worker", on);
  }, [s.patch]);
  if (!s.settings) return null;
  const { layout } = s.settings;
  const cols = layout.panel === "hidden" ? "1fr" : layout.panel === "left" ? `${layout.panelWidth}% 1fr` : `1fr ${layout.panelWidth}%`;
  const panel = (
    <WorkerPanel workers={workers} selected={s.settings.focus} onSelect={(id) => s.patch({ focus: id })} />
  );
  return (
    <div className="sf-root">
      <style>{s.css}</style>
      <Slot name="page-background" className="sf-slot-bg" />
      <Navbar title={title} s={s.settings} workers={workers} onSettings={() => setOpen(true)} />
      {s.settings.banner && <div className="sf-banner">{s.settings.banner}</div>}
      <Slot name="banner" />
      {proto > 0 ? (
        // Prototype layout: shared/protos owns .sfp-host and places the chat cell.
        <div className="sfp-stage" data-proto={proto}>
          <div className="sfp-chat sf-chat"><div className="sf-chat-body">{chat}</div></div>
          <div key={proto} className="sfp-host" data-proto={proto} />
        </div>
      ) : (
        <div className="sf-layout" style={{ gridTemplateColumns: cols }}>
          {layout.panel === "left" && panel}
          <div className="sf-chat">
            <Slot name="chat-background" className="sf-slot-bg" />
            <div className="sf-chat-body">{chat}</div>
          </div>
          {layout.panel === "right" && panel}
        </div>
      )}
      <Slot name="overlay" className="sf-slot-overlay" />
      {open && s.options && <SettingsDrawer s={s.settings} options={s.options} patch={s.patch} error={s.error} onClose={() => setOpen(false)} />}
    </div>
  );
}

function useHotkeys(s: S, toggleSettings: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!s.settings || e.metaKey || e.ctrlKey || e.altKey || t.closest("input,textarea,select,[contenteditable]")) return;
      const action = s.settings.hotkeys[e.key];
      if (!action) return;
      e.preventDefault();
      const names = Object.keys(s.settings.themes);
      const actions: Record<string, () => unknown> = {
        toggleSettings,
        togglePanel: () => s.patch({ layout: { panel: s.settings!.layout.panel === "hidden" ? "right" : "hidden" } }),
        cycleTheme: () => s.patch({ theme: names[(names.indexOf(s.settings!.theme) + 1) % names.length] }),
        focusCoordinator: () => s.patch({ focus: "coordinator" }),
        abortCoordinator: () => api.abort("coordinator"),
      };
      actions[action]?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s.settings, toggleSettings]);
}

function Navbar({ title, s, workers, onSettings }: { title: string; s: Settings; workers: Worker[]; onSettings: () => void }) {
  const coord = workers.find((w) => w.id === "coordinator");
  const busy = coord?.status === "running";
  const items: Record<string, React.ReactNode> = {
    status: (
      <span className="sf-nav-item">
        <span className={`sf-dot ${busy ? "sf-busy" : ""}`} style={{ background: busy ? "#f59e0b" : "#16a34a" }} /> {coord?.status ?? "…"}
      </span>
    ),
    workers: <span className="sf-nav-item">{workers.filter((w) => w.role !== "coordinator").length} workers · {workers.filter((w) => w.status === "running").length} running</span>,
    model: <span className="sf-nav-item">{s.agent.model} · {s.agent.reasoningEffort}</span>,
    context: coord?.contextLimit ? (
      <span className="sf-nav-item sf-ctx" title={`${coord.contextTokens} / ${coord.contextLimit} tokens`}>
        <span className="sf-ctx-bar"><span style={{ width: `${Math.min(100, (100 * (coord.contextTokens ?? 0)) / coord.contextLimit)}%` }} /></span>
        {Math.round((coord.contextTokens ?? 0) / 1000)}k / {Math.round(coord.contextLimit / 1000)}k
      </span>
    ) : (
      <span className="sf-nav-item">ctx –</span>
    ),
    auth: <span className="sf-nav-item">{coord?.auth === "proxy" ? "copilot-proxy-rs" : "native Copilot"}</span>,
    crons: <span className="sf-nav-item">⏱ {Object.values(s.crons).filter((c) => c.enabled).length} crons</span>,
  };
  return (
    <nav className="sf-nav">
      <b>{title}</b>
      {s.navbar.map((k) => <span key={k}>{items[k]}</span>)}
      <Slot name="navbar" className="sf-nav-item" />
      <span style={{ flex: 1 }} />
      <span className="sf-nav-item sf-muted">{s.theme}</span>
      <button onClick={onSettings} title="Settings (,)">⚙</button>
    </nav>
  );
}

function SettingsDrawer({ s, options, patch, error, onClose }: { s: Settings; options: SettingsOptions; patch: (p: unknown) => void; error: string | null; onClose: () => void }) {
  const [cron, setCron] = useState({ name: "", every: "60", prompt: "" });
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <aside className="sf-drawer">
      <header><b>Settings</b><span className="sf-muted"> · the agent can change all of this too</span><button onClick={onClose}>✕</button></header>
      {error && <div className="sf-error">{error}</div>}
      <section><h4>Theme</h4>
        <div className="sf-chips">{Object.entries(s.themes).map(([name, p]) => (
          <button key={name} className={name === s.theme ? "on" : ""} onClick={() => patch({ theme: name })}>
            <span className="sf-swatch" style={{ background: p.bg, borderColor: p.accent }} />{name}
          </button>))}
        </div>
        <label><input type="checkbox" checked={s.animations} onChange={(e) => patch({ animations: e.target.checked })} /> animations</label>
      </section>
      <section><h4>Layout</h4>
        <div className="sf-chips">{options.panelPositions.map((p) => <button key={p} className={p === s.layout.panel ? "on" : ""} onClick={() => patch({ layout: { panel: p } })}>{p}</button>)}</div>
        <label>panel width {s.layout.panelWidth}% <input type="range" min={25} max={70} value={s.layout.panelWidth} onChange={(e) => patch({ layout: { panelWidth: Number(e.target.value) } })} /></label>
      </section>
      <section><h4>Navbar</h4>
        <div className="sf-chips">{options.navbarItems.map((i) => <button key={i} className={s.navbar.includes(i) ? "on" : ""} onClick={() => patch({ navbar: toggle(s.navbar, i) })}>{i}</button>)}</div>
        <label>banner <input value={s.banner ?? ""} placeholder="(none)" onChange={(e) => patch({ banner: e.target.value || null })} /></label>
      </section>
      <section><h4>Agent (core 4)</h4>
        <label>model <select value={s.agent.model} onChange={(e) => patch({ agent: { model: e.target.value } })}>{options.models.map((m) => <option key={m}>{m}</option>)}</select></label>
        <label>reasoning <select value={s.agent.reasoningEffort} onChange={(e) => patch({ agent: { reasoningEffort: e.target.value } })}>{options.efforts.map((m) => <option key={m}>{m}</option>)}</select></label>
        <div>disabled built-in tools</div>
        <div className="sf-chips">{options.toolKinds.map((k) => <button key={k} className={s.agent.disabledTools.includes(k) ? "on danger" : ""} onClick={() => patch({ agent: { disabledTools: toggle(s.agent.disabledTools, k) } })}>{k}</button>)}</div>
        <label>instructions<textarea rows={3} defaultValue={s.agent.instructions} key={s.agent.instructions} onBlur={(e) => patch({ agent: { instructions: e.target.value } })} /></label>
      </section>
      <SecurityReviews />
      <section><h4>Cron prompts</h4>
        {Object.entries(s.crons).map(([name, c]) => (
          <div key={name} className="sf-cron">
            <input type="checkbox" checked={c.enabled} onChange={(e) => patch({ crons: { [name]: { enabled: e.target.checked } } })} />
            <b>{name}</b> every {c.everySeconds}s <span className="sf-muted">{c.prompt}</span>
            <button onClick={() => patch({ crons: { [name]: null } })}>✕</button>
          </div>))}
        <form className="sf-spawn" onSubmit={(e) => { e.preventDefault(); if (!cron.name || !cron.prompt) return; patch({ crons: { [cron.name]: { everySeconds: Number(cron.every), prompt: cron.prompt, enabled: true } } }); setCron({ name: "", every: "60", prompt: "" }); }}>
          <input placeholder="name" value={cron.name} onChange={(e) => setCron({ ...cron, name: e.target.value })} />
          <input style={{ maxWidth: 60 }} value={cron.every} onChange={(e) => setCron({ ...cron, every: e.target.value })} />
          <input placeholder="prompt" value={cron.prompt} onChange={(e) => setCron({ ...cron, prompt: e.target.value })} />
          <button>Add</button>
        </form>
      </section>
      <section><h4>Extensions</h4>
        {Object.keys(s.extensions ?? {}).length === 0 && <div className="sf-muted">none yet. Ask the agent for any UI change.</div>}
        {Object.entries(s.extensions ?? {}).map(([name, x]) => (
          <div key={name} className="sf-cron">
            <input type="checkbox" checked={x.enabled} onChange={(e) => patch({ extensions: { [name]: { enabled: e.target.checked } } })} />
            <b>{name}</b> <span className="sf-muted">{x.slot} · {x.description}</span>
            <button onClick={() => patch({ extensions: { [name]: null } })}>✕</button>
          </div>))}
      </section>
      <section><h4>Hotkeys</h4>
        {Object.entries(s.hotkeys).map(([k, a]) => <div key={k}><kbd>{k}</kbd> {a}</div>)}
      </section>
    </aside>
  );
}

function SecurityReviews() {
  const reviews = useSecurityReviews();
  return (
    <section><h4>Security review</h4>
      {reviews.length === 0 && <div className="sf-muted">runs automatically after every implement step</div>}
      {reviews.slice(-3).map((r) => (
        <div key={r.id}>
          <div className="sf-cron"><b>{r.status}</b> {r.model || "routing model"} <span className="sf-muted">{r.id}</span></div>
          {r.error && <div className="sf-error">{r.error}</div>}
          {r.findings.map((x) => (
            <div key={x.id} className="sf-cron"><b>{x.verdict}</b> [{x.severity}] {x.title} <span className="sf-muted">{x.file} · {x.reason}</span></div>
          ))}
        </div>
      ))}
    </section>
  );
}
