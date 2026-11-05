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
7. **Chat goes through CopilotKit.** The coordinator agent and thread switching live in `src/state/chat.ts`;
   it is the only code that writes `coordinator.threadId` or calls `setMessages`. Tool calls render with
   `useRenderTool` (`src/copilotkit.tsx`), drawn by the affectUI card (`src/chat/ToolCards.tsx`).
8. **Third-party components are installed verbatim** under `src/components/ui/` (shadcn registry files),
   with a source/licence header. Do not edit them; wrap them. Re-fetch to update.
9. **Pin CopilotKit.** `@copilotkit/react-core` is a release candidate; keep the exact version and keep
   CopilotKit calls in `copilotkit.tsx`, `src/chat/` and `src/state/chat.ts`.
