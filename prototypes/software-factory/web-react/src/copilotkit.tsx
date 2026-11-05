// Plain HTTP on a tailnet IP is not a secure context, so browsers omit crypto.randomUUID.
// CopilotKit and the thread picker need it; getRandomValues still works there.
if (typeof crypto.randomUUID !== "function") {
  crypto.randomUUID = () =>
    "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) =>
      (+c ^ (crypto.getRandomValues(new Uint8Array(1))[0]! & (15 >> (+c / 4)))).toString(16),
    ) as `${string}-${string}-${string}-${string}-${string}`;
}

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
  // Every other tool: affectUI's Tool Call Card. `group` lets the chat fold calls in a row into ToolGroup.
  useRenderTool({ name: "*", group: true, render: ToolCard });
  return null;
}

/** Saved threads (shared with Foldkit and the sf CLI). The store holds the list and the open id. */
function ThreadPicker() {
  const threads = useApp((s) => s.threads);
  const current = useApp((s) => s.threadId);
  return (
    <div className="ck-threads">
      <select value={threads.some((x) => x.id === current) ? current : ""} onChange={(e) => (e.target.value ? void openThread(e.target.value) : freshThread())}>
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
    const mo = new MutationObserver(tag);
    mo.observe(document.body, { subtree: true, childList: true, characterData: true });
    tag();
    document.addEventListener("click", onClick, true);
    return () => (mo.disconnect(), document.removeEventListener("click", onClick, true));
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
          <CopilotChat
            agentId="coordinator"
            labels={{ chatInputPlaceholder: "Ask the coordinator to build something… (try: switch to the nord theme)" }}
            chatView={{ messageView: { assistantMessage: { toolCallsView: { group: ToolGroup } } } }}
          />
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
