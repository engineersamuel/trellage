// Must be the first import: ES modules run imports before this file, and the store calls randomUUID on load.
import "./secure-context";
// Option 1: React + CopilotKit + Effect + one zustand store. See AGENTS.md for the rules.
import { CopilotChat, CopilotKitProvider, useRenderTool } from "@copilotkit/react-core";
import { Renderer } from "@openuidev/react-lang";
import { openuiChatLibrary } from "@openuidev/react-ui/genui-lib";
import "@openuidev/react-ui/components.css";
import { ThemeProvider } from "@openuidev/react-ui";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { z } from "zod";
import { startDecisionCenter } from "../../shared/decisions";
import { startFolderSidebar } from "../../shared/folders";
import { startTranscripts } from "../../shared/transcript";
import { setOpenUiRenderer, startPrototypes } from "../../shared/protos";
import { FactoryShell } from "./shared/FactoryShell";
import { factoryMarkdownRenderer } from "./shared/CodeBlock";
import { REPORT_REF, ReportViewer } from "./shared/ReportViewer";
import { DecisionCard } from "./chat/DecisionCard";
import { ToolCard, ToolGroup } from "./chat/ToolCards";
import { coordinator, freshThread, openThread } from "./state/chat";
import { startHostEvents } from "./state/host-events";
import { Action } from "./state/model";
import { dispatch, startStore, useApp } from "./state/store";

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
  // Decisions render as an answerable card in the chat (own row, not grouped).
  const decision = z.object({ title: z.string(), summary: z.string().optional(), options: z.array(z.string()).optional() });
  useRenderTool({ name: "request_approval", parameters: decision, render: (p) => <DecisionCard name={p.name} toolCallId={p.toolCallId} args={p.parameters} result={p.result} /> });
  useRenderTool({ name: "ask_user", parameters: decision, render: (p) => <DecisionCard name={p.name} toolCallId={p.toolCallId} args={p.parameters} result={p.result} /> });
  // Every other tool: affectUI's Tool Call Card. `group` lets the chat fold calls in a row into ToolGroup.
  useRenderTool({ name: "*", group: true, render: ToolCard });
  return null;
}

/**
 * The chat owns no thread state: the store's thread id is passed as `threadId`, so CopilotKit sets the agent's
 * thread and loads its history through FactoryAgent.connect(). `threadVersion` remounts it to reload.
 */
function CoordinatorChat() {
  const threadId = useApp((s) => s.threadId);
  const version = useApp((s) => s.threadVersion);
  return (
    <CopilotChat
      key={`${threadId}:${version}`}
      agentId="coordinator"
      threadId={threadId}
      labels={{ chatInputPlaceholder: "Ask the coordinator to build something… (try: switch to the nord theme)" }}
      chatView={{ messageView: { assistantMessage: { toolCallsView: { group: ToolGroup } } } }}
    />
  );
}

/** Saved threads (shared with Foldkit and the sf CLI). The store holds the list and the open id. */
function ThreadPicker() {
  const threads = useApp((s) => s.threads);
  const current = useApp((s) => s.threadId);
  return (
    <div className="ck-threads">
      <select value={threads.some((x) => x.id === current) ? current : ""} onChange={(e) => (e.target.value ? openThread(e.target.value) : freshThread())}>
        <option value="">New thread</option>
        {threads.map((x) => (
          <option key={x.id} value={x.id}>{x.title}</option>
        ))}
      </select>
    </div>
  );
}

const refOf = (e: Element) => {
  const text = (e.textContent ?? "").trim();
  const href = e.getAttribute("href") ?? "";
  return REPORT_REF.test(text) ? text : REPORT_REF.test(href) ? href : null;
};

/** Report paths (`reports/x.md`) anywhere on the page open the report viewer. */
function ReportLinks() {
  const report = useApp((s) => s.report);
  useEffect(() => {
    // Shared DOM modules render report paths too, so links are found in the page, not in React output.
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
      const agent = host?.dataset.agent ?? host?.dataset.transcript;
      dispatch(Action.ReportOpened(agent ? { ref, agent } : { ref }));
    };
    // Streaming fires many mutations per second: scan at most once per frame. Report paths sit in <code>/<a>
    // elements, which arrive as new nodes, so text-only changes (characterData) need no scan.
    let frame = 0;
    const schedule = () => (frame ||= requestAnimationFrame(() => ((frame = 0), tag())));
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { subtree: true, childList: true });
    tag();
    document.addEventListener("click", onClick, true);
    return () => (mo.disconnect(), cancelAnimationFrame(frame), document.removeEventListener("click", onClick, true));
  }, []);
  return report ? <ReportViewer refPath={report.ref} agent={report.agent} onClose={() => dispatch(Action.ReportClosed())} /> : null;
}

function App() {
  return (
    <CopilotKitProvider selfManagedAgents={{ coordinator }} enableInspector={false} markdownRenderer={factoryMarkdownRenderer}>
      <ToolRenderers />
      <ReportLinks />
      <FactoryShell
        title="Factory · CopilotKit"
        chat={<>
          <ThreadPicker />
          <CoordinatorChat />
        </>}
      />
      <style>{`.ck-threads{padding:6px 12px;border-bottom:1px solid var(--sf-border)}
        .ck-threads select{max-width:100%;background:var(--sf-surface);color:var(--sf-text);border:1px solid var(--sf-border);border-radius:6px;padding:3px 6px}
        .sf-chat .ui-tcc, .sf-chat .ui-tcc-group{margin:6px 0}`}</style>
    </CopilotKitProvider>
  );
}

startStore();
startHostEvents();
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
