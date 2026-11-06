# web-react agent guide

React + CopilotKit host for the software factory. Stack: **React 19 + CopilotKit (AG-UI) + Effect + one zustand store.**
The Foldkit UI (`../web-foldkit`) stays; both mount the plain-DOM modules in `../shared`.

## Checks

Run all before you finish: `npx tsc --noEmit`, `bun test` (in `web-react/`), `npx vite build`.
If you change `../shared`, also run the Foldkit checks (`../web-foldkit/AGENTS.md`).

## Rules

1. **One store.** App state lives in `src/state/store.ts` (zustand). Components read with `useApp(selector)`.
   No component calls `fetch`, `onFeed`, or `window.addEventListener` for app state.
2. **Named actions, pure reducer.** Every state change is an `Action` (`Data.taggedEnum`) handled by `reduce` in
   `src/state/model.ts`. `model.ts` imports no React, no DOM, no HTTP. Test new actions in `test/model.test.ts`.
3. **I/O is Effect.** HTTP goes through `../shared/http.ts` (`json`, `send`) and decodes with a Schema from
   `../shared/schemas.ts`. An Effect program does the I/O, then dispatches an action with the result.
   No `Schema.Unknown` + cast for API payloads.
4. **One feed bridge.** `bridge` in `store.ts` is the only app-wide feed subscriber: events become actions
   (`feedActions`) or reloads. A component that needs a scoped stream (one worker's events) runs it as an
   Effect fiber and interrupts it on unmount, like `useWorkerEvents`.
5. **Local view state stays local.** Open/closed, copied, hover and form input use `useState` inside the
   component. If two components or the app need it, it goes in the store.
6. **Shared DOM modules talk through `src/state/host-events.ts`.** `../shared` code raises window events
   (`sf:open-thread`, `sf:new-thread`, `sf:select-worker`, `sf:open-report`) because Foldkit mounts it too.
   Only `host-events.ts` turns them into actions. Do not convert `../shared` modules to React while Foldkit uses them.
7. **Chat goes through CopilotKit.** The store owns the open thread id; `CopilotChat` gets it as `threadId`
   and loads history through `FactoryAgent.connect()` (`src/state/chat.ts`, a `MESSAGES_SNAPSHOT` of the saved
   thread). Never write `coordinator.threadId` or call `setMessages` yourself; dispatch `ThreadSelected` /
   `ThreadReloaded`. Tool calls render with `useRenderTool` (`src/copilotkit.tsx`): the affectUI card for every
   tool (`src/chat/ToolCards.tsx`), an answerable card for `request_approval` / `ask_user` (`src/chat/DecisionCard.tsx`).
   A failed call is the AG-UI tool message `error`; the feed timing is the fallback for old threads.
   **AG-UI 1.0 in use:** Stop calls `/api/agui/stop` (`FactoryAgent.abortRun`; the run ends `cancelled` and is saved).
   A run that ends with an open decision ends with the `interrupt` outcome; `DecisionCard` answers it with
   `resume` (`answerInterrupt`), else through the approvals API. `FactoryAgent.runAgent` abandons interrupts that are
   still open and drops ones answered elsewhere. Subagents and started workers arrive as activity messages
   (`src/chat/ActivityCards.tsx`, `renderActivityMessages`). Frontend tools (`useFrontendTool`) and `useAgentContext`
   reach the coordinator; keep frontend tools fast, the coordinator waits for their result.
8. **Third-party components are installed verbatim** under `src/components/ui/` (shadcn registry files),
   with a source/licence header. Do not edit them; wrap them. Re-fetch to update.
9. **Pin CopilotKit and AG-UI together.** `@ag-ui/client` must match the version `@copilotkit/react-core` depends on,
   so there is one agent class. The root `zustand` stays 4.x for OpenUI's peer dependency; the store imports
   `zustand5` (an npm alias). **Pin CopilotKit.** `@copilotkit/react-core` is a release candidate; keep the exact version and keep
   CopilotKit calls in `copilotkit.tsx`, `src/chat/`, `src/genui/` and `src/state/chat.ts`.

## CopilotKit and OpenUI: which one draws what

CopilotKit owns the chat and every UI whose layout we know in advance. OpenUI draws only UI the agent designs.

| UI | Use | Where |
|---|---|---|
| Chat shell: messages, input, threads, reasoning, tool-call grouping | CopilotKit `CopilotChat` and its slots | `copilotkit.tsx` |
| A tool call | `useRenderTool("*")` + affectUI card | `src/chat/ToolCards.tsx` |
| A known card (approval, question, status, report) | `useRenderTool` with a zod `parameters` schema + our React component | `src/chat/` |
| A layout the agent decides (dashboard, plan, comparison, chart) | the `render_ui` tool with an OpenUI Lang program | `src/genui/OpenUi.tsx` |

10. **Known layout → CopilotKit; agent layout → OpenUI.** Before adding a card, ask: do we know its layout? If yes,
    add a backend tool with typed arguments and a `useRenderTool` renderer. Only `render_ui` carries OpenUI Lang.
    Do not teach the agent a second UI language (CopilotKit `standardUI`, A2UI, Open Generative UI) while OpenUI is in use.
11. **OpenUI goes through `src/genui/`.** Only `src/genui/` imports `@openuidev/*`; the renderer and theme live in `OpenUi.tsx`. The chat (`OpenUiCard`) and the
    shared stream and canvas (`renderOpenUiInto`, via `setOpenUiRenderer`) use it, so every agent card looks the same.
    OpenUI buttons are actions: `continue_conversation` sends the text as the next user message of the open thread
    (`openUiChatAction`), `open_url` opens a tab. A card with buttons that do nothing is a bug.
12. **One theme.** Every surface follows the factory palette (`--sf-*`, from settings): OpenUI through `openUiTheme`,
    the affectUI card by overriding its `--ui-tcc-*` variables from our CSS, our own cards with `var(--sf-*)`.
    No hard-coded surface, text or accent colours in our components (status colours such as red for errors are fine).
13. **Reuse, don't wrap twice.** A known card may use OpenUI's React components directly (for example a chart inside a
    typed card) through `src/genui/`, wrapped in `OpenUiTheme`; it still renders through `useRenderTool`, not `render_ui`.
    Example: `show_worker_board` → `src/genui/WorkerBoard.tsx` (a pure `toBoard` view model, tested in `test/workerboard.test.ts`;
    live workers from the store, the tool result as the fallback snapshot).
14. **A gap is a typed tool, not a new library.** When neither catalog has a component (map, video, HTML), add a tool
    with typed arguments and a renderer. Add a component library only verbatim under `src/components/ui/` (rule 8).
15. **Generative UI is data, not state.** A renderer reads its tool arguments and the store; it never writes app state
    except through actions (`dispatch`) or Effect APIs (`../shared/approvals.ts`). Card-local state (open, input) stays local.
16. **OpenUI stays while Foldkit stays.** OpenUI is the one agent UI format both UIs draw. Revisit when Foldkit is retired
    and CopilotKit `standardUI` is no longer Experimental; then gaps (Steps, metrics, radar charts) become custom components.
