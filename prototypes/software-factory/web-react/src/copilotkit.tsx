// Must be the first import: ES modules run imports before this file, and the store calls randomUUID on load.
import "./secure-context";
// Option 1: React + CopilotKit + Effect + one zustand store. See AGENTS.md for the rules.
import { CopilotChat, CopilotKitProvider, useAgentContext, useCopilotKit, useFrontendTool, useRenderTool } from "@copilotkit/react-core";
import { Effect } from "effect";
import { activityRenderers } from "./chat/ActivityCards";
import { OpenUiCard, renderOpenUiInto } from "./genui/OpenUi";
import { WorkerBoard } from "./genui/WorkerBoard";
import { useEffect, useMemo } from "react";
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
import { coordinator, freshThread, loadCapabilities, openThread, openUiChatAction } from "./state/chat";
import { startHostEvents } from "./state/host-events";
import { Action } from "./state/model";
import { dispatch, patchSettings, startStore, useApp } from "./state/store";

function ToolRenderers() {
  // Agent-designed UI: render_ui carries an OpenUI Lang program (rule 10). Buttons continue the chat.
  const { copilotkit } = useCopilotKit();
  const onAction = useMemo(() => openUiChatAction(copilotkit), [copilotkit]);
  useRenderTool({
    name: "render_ui",
    parameters: z.object({ title: z.string().optional(), program: z.string() }),
    render: ({ parameters, status }) =>
      parameters?.program ? (
        <div className="sf-openui">
          <OpenUiCard program={parameters.program} streaming={status !== "complete"} onAction={onAction} />
        </div>
      ) : null,
  }, [onAction]);
  // Known layout (rule 13): the live worker board, drawn with OpenUI components.
  useRenderTool({ name: "show_worker_board", parameters: z.object({}), render: (p) => <WorkerBoard result={p.result} /> });
  // Decisions render as an answerable card in the chat (own row, not grouped).
  const decision = z.object({ title: z.string(), summary: z.string().optional(), options: z.array(z.string()).optional() });
  useRenderTool({ name: "request_approval", parameters: decision, render: (p) => <DecisionCard name={p.name} toolCallId={p.toolCallId} args={p.parameters} result={p.result} /> });
  useRenderTool({ name: "ask_user", parameters: decision, render: (p) => <DecisionCard name={p.name} toolCallId={p.toolCallId} args={p.parameters} result={p.result} /> });
  // Every other tool: affectUI's Tool Call Card. `group` lets the chat fold calls in a row into ToolGroup.
  useRenderTool({ name: "*", group: true, render: ToolCard });
  return null;
}

/** Sent as forwardedProps with every run. */
const RUN_PROPERTIES = { interrupts: true };
const FocusArgs = z.object({ id: z.string() });

/** What the coordinator can do in this page (AG-UI frontend tools) and what the human is looking at (AG-UI context). */
function UiBridge() {
  // Runs in the browser: the coordinator's call ends its run, CopilotKit runs this and resumes with the result.
  useFrontendTool({
    name: "focus_agent",
    description: "Show one agent (coordinator or worker id) in the human's side panel. Use it when you point the human at a worker.",
    parameters: FocusArgs,
    handler: async ({ id }) => {
      if (!useApp.getState().workers[id]) return `unknown agent ${id}`;
      patchSettings({ focus: id });
      return `showing ${id}`;
    },
  });
  const focus = useApp((s) => s.settings?.settings.focus ?? null);
  const pending = useApp((s) => s.decisions.filter((d) => d.status === "pending").length);
  useAgentContext({ description: "Agent shown in the human's side panel", value: focus ?? "none" });
  useAgentContext({ description: "Decisions waiting for the human", value: pending });
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
  // An unstarted draft is not a conversation yet: it is run from its node on the Org Canvas.
  const threads = useApp((s) => s.threads).filter((t) => !(t.draft && !t.draft.startedAt));
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
    <CopilotKitProvider
      selfManagedAgents={{ coordinator }}
      enableInspector={false}
      markdownRenderer={factoryMarkdownRenderer}
      renderActivityMessages={activityRenderers}
      // This UI answers decisions as AG-UI interrupts (resume); Foldkit does not send it and gets plain runs.
      properties={RUN_PROPERTIES}
    >
      <ToolRenderers />
      <UiBridge />
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
        .sf-chat .ui-tcc, .sf-chat .ui-tcc-group, .sf-openui, .sf-board{margin:6px 0}
        .sf-board{background:var(--sf-surface);border-radius:10px;padding:12px 14px;box-shadow:0 0 0 0.5px var(--sf-border)}.sf-board-metrics{display:flex;gap:24px;padding:4px 0 8px}.sf-board-row{cursor:pointer}.sf-board small{color:var(--sf-muted);margin-left:4px}.sf-board-wait{color:var(--sf-muted)}
        /* affectUI card stays verbatim; its variables follow the factory palette from outside (rule 12). */
        :root .sf-chat .ui-tcc, :root .sf-chat .ui-tcc-group{--ui-tcc-card:var(--sf-surface);--ui-tcc-code:var(--sf-bg);--ui-tcc-accent:var(--sf-accent);--ui-tcc-strong:var(--sf-text);--ui-tcc-ink:var(--sf-text);--ui-tcc-text:var(--sf-muted);--ui-tcc-focus:var(--sf-accent)}`}</style>
    </CopilotKitProvider>
  );
}

startStore();
startHostEvents();
void Effect.runPromise(loadCapabilities);
createRoot(document.getElementById("root")!).render(<App />);
startDecisionCenter();
startFolderSidebar();
startTranscripts();
// The factory stream and canvas render coordinator answers written in OpenUI Lang with the same themed card.
setOpenUiRenderer(renderOpenUiInto);
startPrototypes();
