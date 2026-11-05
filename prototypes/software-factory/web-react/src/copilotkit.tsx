// Plain HTTP on a tailnet IP is not a secure context, so browsers omit crypto.randomUUID.
// CopilotKit and the thread picker need it; getRandomValues still works there.
if (typeof crypto.randomUUID !== "function") {
  crypto.randomUUID = () =>
    "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
      (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (+c / 4)))).toString(16),
    ) as `${string}-${string}-${string}-${string}-${string}`;
}

// Option 1: React + CopilotKit. CopilotKit talks AG-UI straight to the Rust
// coordinator through an HttpAgent (no CopilotKit runtime server in between).
import { HttpAgent } from "@ag-ui/client";
import { CopilotChat, CopilotKitProvider, useRenderTool } from "@copilotkit/react-core";
import { Renderer } from "@openuidev/react-lang";
import { openuiChatLibrary } from "@openuidev/react-ui/genui-lib";
import "@openuidev/react-ui/components.css";
import { ThemeProvider } from "@openuidev/react-ui";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { startDecisionCenter } from "../../shared/decisions";
import { startFolderSidebar, syncThreadUrl } from "../../shared/folders";
import { startTranscripts } from "../../shared/transcript";
import { setOpenUiRenderer, startPrototypes } from "../../shared/protos";
import { onFeed, RESYNC } from "../../shared/feed";
import { FactoryShell } from "./shared/FactoryShell";
import { factoryMarkdownRenderer } from "./shared/CodeBlock";
import { REPORT_REF, ReportViewer } from "./shared/ReportViewer";

const coordinator = new HttpAgent({ url: "/api/agui", agentId: "coordinator" });

function ToolRenderers() {
  // Generative UI pushed by the backend: the coordinator's render_ui tool carries OpenUI Lang.
  useRenderTool({
    name: "render_ui",
    parameters: z.object({ title: z.string().optional(), program: z.string() }),
    render: ({ parameters, status }) =>
      parameters?.program ? (
        <div style={{ margin: "8px 0" }}>
          <ThemeProvider mode="dark">
            <Renderer response={parameters.program} library={openuiChatLibrary} isStreaming={status !== "complete"} />
          </ThemeProvider>
        </div>
      ) : null,
  });
  useRenderTool({
    name: "spawn_worker",
    parameters: z.object({ name: z.string(), task: z.string() }),
    render: ({ parameters, status, result }) => (
      <div className="ck-card">
        <b>🏭 spawn_worker</b> {parameters?.name} — {status}
        <div className="ck-sub">{parameters?.task}</div>
        {result && <div className="ck-sub">pid {safe(result)?.pid} · {safe(result)?.id}</div>}
      </div>
    ),
  });
  useRenderTool({
    name: "*",
    render: ({ name, status }: { name: string; status: string }) => (
      <div className="ck-card">
        <b>🔧 {name}</b> — {status}
      </div>
    ),
  });
  return null;
}

const safe = (s: string) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

type Thread = { id: string; title: string };

/**
 * Saved threads (shared with Foldkit and the sf CLI). Picking one loads its messages
 * into the agent; a thread that changes elsewhere reloads live.
 */
function useThreads() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [current, setCurrent] = useState<string>(() => crypto.randomUUID());
  const loadList = () => fetch("/api/threads/get").then((r) => r.json()).then((v) => setThreads(v.threads));
  const open = async (id: string) => {
    const msgs = await fetch(`/api/threads/get/${encodeURIComponent(id)}`).then((r) => r.json());
    coordinator.threadId = id;
    coordinator.setMessages(msgs);
    setCurrent(id);
    syncThreadUrl(id);
  };
  useEffect(() => {
    loadList();
    return onFeed((ev) => {
      if (ev.type !== "factory.thread_updated" && ev.type !== RESYNC) return;
      loadList();
      // Reload the open thread when another client wrote it (or after a feed gap); our own runs stream in already.
      const id = ev.type === RESYNC ? coordinator.threadId : ev.data.threadId;
      if (id && id === coordinator.threadId && !coordinator.isRunning) open(id).catch(() => {});
    });
  }, []);
  const fresh = () => {
    const id = crypto.randomUUID();
    coordinator.threadId = id;
    coordinator.setMessages([]);
    setCurrent(id);
    syncThreadUrl(null);
  };
  return { threads, current, open, fresh };
}

function ThreadPicker() {
  const t = useThreads();
  // Opening a decision (deep link) opens its conversation behind the card.
  useEffect(() => {
    const onOpen = (e: Event) => t.open((e as CustomEvent<string>).detail);
    window.addEventListener("sf:open-thread", onOpen);
    window.addEventListener("sf:new-thread", t.fresh);
    // The sidebar announces ?thread= on load, which can be before this listener exists: open it here too.
    const linked = new URL(window.location.href).searchParams.get("thread");
    if (linked) t.open(linked).catch(() => {});
    return () => (window.removeEventListener("sf:open-thread", onOpen), window.removeEventListener("sf:new-thread", t.fresh));
  }, []);
  return (<>
    <div className="ck-threads">
      <select value={t.threads.some((x) => x.id === t.current) ? t.current : ""} onChange={(e) => (e.target.value ? t.open(e.target.value) : t.fresh())}>
        <option value="">New thread</option>
        {t.threads.map((x) => (
          <option key={x.id} value={x.id}>{x.title}</option>
        ))}
      </select>
    </div>
  </>);
}

/** Report paths (`reports/x.md`) anywhere on the page open the report viewer. */
function ReportLinks() {
  const [open, setOpen] = useState<{ ref: string; agent?: string } | null>(null);
  useEffect(() => {
    const refOf = (e: Element) => {
      const text = (e.textContent ?? "").trim();
      const href = e.getAttribute("href") ?? "";
      return REPORT_REF.test(text) ? text : REPORT_REF.test(href) ? href : null;
    };
    const tag = () => {
      for (const e of document.querySelectorAll("code:not(.sf-report-link), a:not(.sf-report-link)"))
        if (!e.closest("pre, .rv-modal") && refOf(e)) e.classList.add("sf-report-link");
    };
    const onClick = (ev: MouseEvent) => {
      const e = (ev.target as Element | null)?.closest?.(".sf-report-link");
      const ref = e && refOf(e);
      if (!ref) return;
      ev.preventDefault();
      ev.stopPropagation();
      // The agent that wrote the text decides which conversation worktree a relative path means.
      const host = e.closest<HTMLElement>("[data-agent], [data-transcript]");
      setOpen({ ref, agent: host?.dataset.agent ?? host?.dataset.transcript ?? undefined });
    };
    const mo = new MutationObserver(tag);
    mo.observe(document.body, { subtree: true, childList: true, characterData: true });
    tag();
    document.addEventListener("click", onClick, true);
    const onOpen = (e: Event) => setOpen({ ref: (e as CustomEvent<string>).detail });
    window.addEventListener("sf:open-report", onOpen);
    return () => (mo.disconnect(), document.removeEventListener("click", onClick, true), window.removeEventListener("sf:open-report", onOpen));
  }, []);
  return open ? <ReportViewer refPath={open.ref} agent={open.agent} onClose={() => setOpen(null)} /> : null;
}

function App() {
  return (
    <CopilotKitProvider selfManagedAgents={{ coordinator }} enableInspector={false} markdownRenderer={factoryMarkdownRenderer}>
      <ToolRenderers />
      <ReportLinks />
      <FactoryShell
        title="Factory · CopilotKit"
        chat={<><ThreadPicker /><CopilotChat agentId="coordinator" labels={{ chatInputPlaceholder: "Ask the coordinator to build something… (try: switch to the nord theme)" }} /></>}
      />
      <style>{`.ck-card{border:1px solid var(--sf-border);border-radius:8px;padding:6px 10px;margin:6px 0;font-size:13px}
        .ck-sub{color:var(--sf-muted);font-size:12px;margin-top:2px}
        .ck-threads{padding:6px 12px;border-bottom:1px solid var(--sf-border)}
        .ck-threads select{max-width:100%;background:var(--sf-surface);color:var(--sf-text);border:1px solid var(--sf-border);border-radius:6px;padding:3px 6px}`}</style>
    </CopilotKitProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
startDecisionCenter();
startFolderSidebar();
startTranscripts();
// The factory stream renders coordinator answers written in OpenUI Lang (for the Foldkit chat) as cards.
setOpenUiRenderer((el, program, onAction) => {
  const root = createRoot(el);
  root.render(
    <ThemeProvider mode="dark">
      <Renderer response={program} library={openuiChatLibrary} isStreaming={false} onAction={onAction} />
    </ThemeProvider>,
  );
  return () => root.unmount();
});
startPrototypes();
