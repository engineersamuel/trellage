# Handoff: one Foldkit factory UI, zero React, no CopilotKit

Date: 2026-11-06
Scope: `prototypes/software-factory`.
The only user-facing app after this work is `web-foldkit`. Delete `web-react`.

## Outcome

A person opens one factory UI. It is a Foldkit app. It has no React, no CopilotKit, and no second Vite server.

Done means:

- `web-react/` is deleted, including its CopilotKit skills, `copilotkit.html`, and `package-lock.json`.
- `web-foldkit/package.json` and `web-foldkit/src` contain no `react`, `react-dom`, `@copilotkit/*`, `@openuidev/react-*`, or `zustand`.
- `npm ls react react-dom @copilotkit/react-core` from `web-foldkit` lists nothing.
- `mise run factory:up` starts the coordinator and Foldkit only. The old Option 1 URL is gone.
- Every behavior in the port table below either works on Foldkit or is explicitly dropped in the coordinator prompt, with the replacement named.
- `web-foldkit/AGENTS.md` forbids React islands and CopilotKit imports.

## Why this is the right cut

The two pages already look the same because they share `shared/` (feed, folders, decisions, transcripts, themes, extension slots). CopilotKit was a second owner of the chat. Foldkit already owns the app loop, and `@plana-solutions/agent-interface@0.5.0` is already a native Foldkit chat that speaks AG-UI and draws the `openuiChat` catalog.

React stays only where a component has not been redrawn. This port redraws those components. It does not keep a React island "for now."

## Drawing rule

| Kind of UI | Draw it with |
| --- | --- |
| App chrome the factory owns: navbar, settings, worker panel, thread picker | Foldkit `view` + `@foldkit/ui` |
| Chat shell: messages, input, threads, streaming, tool rows | `@plana-solutions/agent-interface` |
| A card whose layout we know (approval, tool call, activity, report, worker board) | A Foldkit view, fed by a typed tool result or a Message |
| A card whose layout the agent invents (`render_ui`, stream answers that start with `root =`) | OpenUI Lang, rendered by agent-interface's Foldkit genui views |
| A third-party React file | Do not wrap it. Port the behavior, or drop it |

Do not add CopilotKit `standardUI`, A2UI, or MCP Apps. OpenUI Lang is the only agent UI format. Do not teach the coordinator a second one.

## Port table

Keep the behavior. Change the owner. "Already there" means do not rebuild it.

| React surface | File | Destination |
| --- | --- | --- |
| Chat shell, history, stop, AG-UI wire | `web-react/src/copilotkit.tsx` `CopilotChat` | Already there: agent-interface in `web-foldkit/src/main.ts`, wired to `/api/agui?answer=openui` |
| Thread picker | `ThreadPicker` in `copilotkit.tsx` | Already there if agent-interface's thread list is the one the factory uses. If the React picker shows drafts the Foldkit list hides, match that filter in the Foldkit view |
| Tool call card and group | `src/chat/ToolCards.tsx` wrapping `src/components/ui/tool-call-card.tsx` (affectUI, MIT, installed verbatim) | Foldkit view in the chat, or agent-interface's own tool-call row if it already shows name, status, args, result, timing, and error. Do not copy the affectUI file. Do not edit a vendored third-party component. Reimplement the behavior in Foldkit HTML |
| Approval / question card | `src/chat/DecisionCard.tsx` | Foldkit card. Answer through the approvals API (`shared/approvals.ts`). See interrupts below |
| Activity cards (subagent, started worker) | `src/chat/ActivityCards.tsx` | Foldkit view of the same AG-UI activity events agent-interface already decodes. If the package drops them, render them from the factory feed in the worker panel. Do not invent a React activity renderer |
| `render_ui` OpenUI card | `src/genui/OpenUi.tsx` | agent-interface already renders OpenUI inside the chat. Confirm a `render_ui` tool result becomes that view. The stream/canvas path is the next row |
| Stream and canvas OpenUI | `openui-card.ts` and `renderOpenUiInto` | Foldkit HTML into the element `shared/protos/core.ts` already passes. See "Stream renderer" |
| Worker board | `src/genui/WorkerBoard.tsx` | Foldkit view of `toBoard`. The pure function and its test move to `web-foldkit` or `shared/`. OpenUI table/metric components may draw it only if the data still comes from the Model, not from an agent-written program. `show_worker_board` stays a typed tool |
| Report viewer | `src/shared/ReportViewer.tsx`, `report-model.ts` | Foldkit modal. Move the pure functions (`findings`, `toMdx`, `REPORT_REF`, `briefRef`) and their tests. Click handling for `reports/*.md` must work on shared DOM too, the way `ReportLinks` scanned the page |
| Markdown / code block | `src/shared/CodeBlock.tsx` | agent-interface already renders markdown. Factory diff highlighting already has a Foldkit path (`src/diffHighlight.ts`). Do not port the CopilotKit `markdownRenderer` slot |
| Factory shell and worker panel | `FactoryShell.tsx`, `WorkerPanel.tsx` | Already there: `web-foldkit/src/view.ts` and `workerPanel/` |
| Zustand store, actions, feed bridge | `src/state/*` | Already there as the Foldkit Model. Do not copy the store. If a reducer case has no Foldkit Message, add the Message. Keep `model.ts` tests that encode a rule the Foldkit stories do not |
| `focus_agent` frontend tool | `useFrontendTool` in `copilotkit.tsx` | A Foldkit-side AG-UI client tool that patches `settings.focus`, or a coordinator tool that emits a feed event the Foldkit subscription already applies. The coordinator must not call a tool only the deleted React page implemented |
| `useAgentContext` (focused agent, pending decisions) | `UiBridge` | Send the same facts on the AG-UI run from the Foldkit chat backend, or drop them from the coordinator prompt if the feed already carries them |
| Host window events | `host-events.ts` | Foldkit already shares `shared/` modules. Map `sf:open-thread`, `sf:new-thread`, `sf:select-worker`, `sf:open-report` to Messages. Do not leave a React-only listener |
| CopilotKit skills under `web-react/.agents` and `skills-lock.json` | those files | Delete with the package. They are CopilotKit product docs, not factory UI |

## Interrupts

`copilotkit.tsx` sends `properties: { interrupts: true }`. A decision ends the run as an AG-UI interrupt, and `DecisionCard` resumes it. The comment in that file says Foldkit does not send that property and gets plain runs.

Pick one and test it:

1. Preferred: the Foldkit chat sends the same interrupt property through `ChatBackend` / `agUiWire`, and the approval card resumes with the same payload `answerInterrupt` sends today (`interruptId`, `status: "resolved"`, `payload.answer`, optional `note`).
2. Acceptable: keep plain runs and answer only through `shared/approvals.ts`, and change the coordinator so it does not wait for an interrupt resume from this UI.

Do not leave a path where the coordinator waits for a resume the only remaining UI never sends.

## Stream renderer

`shared/protos/p2.ts` `openUiBody` calls `renderOpenUi(el, program, agentId, threadId)` and caches `{ el, stop }` by `key:program`. The host registers the renderer. Today Foldkit registers React (`src/openui-card.ts`) and React registers React (`web-react/src/genui/OpenUi.tsx`). Both go away.

Replace the registration with a Foldkit mount:

- Parse with agent-interface's OpenUI parser (`pooledProgramParser` plus the `openuiChat` schema from `@openuidev/lang-core`).
- Draw with agent-interface's Foldkit component views, not `@openuidev/react-ui`.
- Return a cleanup function. `p2.ts` calls it. The same program must not remount.
- Button presses call the `onAction` the shared helper already handles (`continue_conversation`, `open_url`).
- Theme comes from `--openui-*` (`coordinator/src/settings.ts`). Do not hard-code a dark palette.
- A partial program must not throw. The React card passed `isStreaming: false`. Match that unless the feed says the program is still growing.

`componentRegistry` and `genUiAssistantMessageView` are not on agent-interface's public export list (`dist/index.d.ts`). Do not import `dist/features/genui/*` from app code.

Order:

1. Use a public helper from a newer `@plana-solutions/agent-interface` that renders one program to an element, or to Foldkit `Html`, and returns cleanup.
2. If none exists, add that helper upstream in `agentinterface-effect` and depend on it.
3. Last resort: a small local Foldkit view for the components the stream actually shows, parsing with `@openuidev/lang-core`. Do not copy the package's private registry into the repo.

`shared/` must stay free of Foldkit and React imports. The registration function is the boundary.

## Delete list

- Directory `prototypes/software-factory/web-react/`.
- The `copilotkit` process in `process-compose.yaml`, and the `web-react` `npm ci`, the Option 1 URL and the `copilotkit` service name in the `factory:*` tasks of the repository `mise.toml`.
- README row "1 React + CopilotKit 2.0 RC".
- Coordinator CSS that exists only for `[data-copilotkit]` in `coordinator/src/settings.ts`, once no page emits that attribute.
- Comments and prompts that tell the agent the human is looking at the CopilotKit page. Keep tools that both UIs already shared (`render_ui`, `show_worker_board`, `update_settings`).
- `web-foldkit` dependencies: `react`, `react-dom`, `@types/react`, `@types/react-dom`, `@openuidev/react-headless`, `@openuidev/react-lang`, `@openuidev/react-ui`, `zustand`.

Search the prototype for `copilotkit`, `@copilotkit`, `web-react`, `5173`, `createRoot`, and `from "react"` after the delete. Hits inside `web-foldkit/repos/foldkit` (the vendored framework) are fine. Hits in coordinator tests are fine only when they assert the AG-UI translator, not the React page.

## Version trap

`web-foldkit/package.json` overrides force agent-interface onto the host's `effect@4.1.2`, `foldkit@0.170.0`, and `@foldkit/ui@0.170.0`. The published package peers `effect@4.0.6` and depends on `foldkit@0.169.0`.

`patches/@plana-solutions+agent-interface+0.5.0.patch` rewrites `readFlags` because Effect 4.1 removed the root `Crypto` export. `postinstall` runs `patch-package`. Keep the patch until the published package supports Effect 4.1. If you bump the package, regenerate or delete the patch. A patch that does not apply fails the install.

`src/secureContextPolyfill.ts` stays if `readFlags` still needs `crypto.randomUUID()` off a secure origin.

## Steps

1. Read `web-foldkit/AGENTS.md`, `web-react/AGENTS.md`, `src/copilotkit.tsx`, `src/openui-card.ts`, and `shared/protos/core.ts` before editing.
2. Close the port table. For each row, either point at the Foldkit code that already does it, or add that code. Do not mark a row done because the screen looks similar.
3. Move pure functions and their tests before deleting `web-react` (`toBoard`, report ref parsing, decision id parsing, interrupt payload shape).
4. Register the native stream renderer. Delete `src/openui-card.ts`.
5. Wire interrupts, `focus_agent`, and context as chosen above. Update the coordinator prompt in the same change so it cannot call a deleted client tool.
6. Remove React packages from `web-foldkit` and reinstall with npm (`patch-package` and the lockfile are npm). Commit the lockfile with the manifest.
7. Delete `web-react`. Update `process-compose.yaml`, the `factory:*` tasks in `mise.toml`, and `README.md`.
8. Rewrite `web-foldkit/AGENTS.md`: no React, no CopilotKit, known cards are Foldkit views, agent-invented cards are OpenUI Lang.

## Checks

From `prototypes/software-factory/web-foldkit`:

```sh
npm run typecheck
npm run lint
npm run test
npx vite build
npm ls react react-dom @copilotkit/react-core
```

`npm ls` must exit 0 and list none of those packages.

From `prototypes/software-factory/coordinator`: run the existing test command for that package (the AG-UI translator tests). A prompt or tool change that breaks `coordinator/test` is not done.

From `prototypes/software-factory`:

```sh
mise run factory:status
```

After `mise run factory:up`, only the Foldkit URL and the coordinator API should be listed. `http://localhost:5173/copilotkit.html` must not be started.

Browser, on `http://localhost:5174/`:

- Chat streams. An OpenUI Lang answer renders as a card inside the chat, not as raw `root =` text.
- The prototype stream shows the same kind of answer as a card. `continue_conversation` sends a follow-up. `open_url` opens a tab. Switching layout does not duplicate the card.
- A tool call shows name, status, args, and result. A failed call shows the error.
- `request_approval` / `ask_user` can be answered, and the coordinator continues.
- `show_worker_board` shows live workers. Selecting a row focuses that worker.
- A `reports/*.md` path opens the report viewer, including a path rendered by a shared DOM module.
- Theme change recolors chat, Foldkit chrome, and OpenUI cards.
- `focus_agent`, if kept, changes the side panel.

If no browser is available, say so. Unit tests do not prove the stream card or the approval resume.

## Out of scope

- CopilotKit Channels, Inspector, A2UI, and Slack/Teams skills. They leave with `web-react`.
- Moving coordinator machines (security review, delivery, fan-out) into the browser.
- Making `shared/` import Foldkit.
- Rewriting affectUI's MIT source into the repo. Port the visible behavior, or use the chat package's tool row.
