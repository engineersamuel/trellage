# web-foldkit agent guide

Foldkit (TEA + Effect) host for the software factory. The live Foldkit source and examples are vendored at
`repos/foldkit` (tag `foldkit@0.170.0`); grade code against them, not against memory.

## Checks

Run all four before you finish: `npm run typecheck`, `npm run lint`, `npm run test`, `npx vite build`.

## No React

This app has no React and no CopilotKit. Do not add `react`, `react-dom`, `@copilotkit/*`, `@openuidev/react-*`,
or `zustand`, and do not mount a React island. `npm ls react react-dom @copilotkit/react-core` must list nothing.

- App chrome (navbar, settings, thread picker): Foldkit `view` + `@foldkit/ui`. The page layout is the Inbox
  (`../shared/protos/p3.ts`, plain DOM): sidebar with ＋ Draft, inbox, conversation tree or canvas (Tree | Canvas
  switch), and the detail column where the host places the chat.
- Chat shell (messages, composer, threads, streaming, tool rows): `@plana-solutions/agent-interface`.
- A card whose layout we know: a Foldkit view, or an OpenUI program the coordinator builds
  (`../coordinator/src/cards.ts`).
- A card whose layout the agent invents (`render_ui`, answers that start with `root =`): OpenUI Lang, drawn by
  agent-interface's Foldkit GenUI views. OpenUI Lang is the only agent UI format.
- A third-party React component: do not wrap it. Port the behavior to Foldkit, or drop it.

### OpenUI cards outside the chat

`src/openUiCard.ts` draws OpenUI programs for the shared stream (`shared/protos`, `setOpenUiRenderer`). Each card is a
small `Runtime.makeElement` program that embeds the chat Submodel with one answer and draws it with `genUiCardView`
(added to agent-interface by the patch below). So a stream card has the same components, DOM, query tools and popovers
as a chat card. "Continue the conversation" leaves the card through the `followUp` outbound Port; the host sends it to
the agent that wrote the card. `src/openUiCard.test.ts` covers drawing and actions;
`../coordinator/test/openui-cards.test.ts` parses every coordinator card with the `openuiChat` catalog (copy in
`../shared/openui-chat-library.json`; `src/openUiCatalog.test.ts` keeps it in sync).

`src/openUiParity.css` keeps the Select popover unclipped, as Radix does.

## Patched packages

`patches/` holds `patch-package` patches; `postinstall` applies them with `--error-on-fail`, so `npm install` fails when
a patch no longer fits. `@plana-solutions/agent-interface` is patched in these files:
`node_modules/@plana-solutions/agent-interface/dist/client/flags.js` (Effect 4.1 Crypto),
`node_modules/@plana-solutions/agent-interface/dist/features/timeline.js` (a `[data-sf-tool]` slot per finished tool
call; `../shared/diffview.ts` `startToolDiffs` draws the file diffs in it), and
`node_modules/@plana-solutions/agent-interface/dist/client/timeline.js` +
`node_modules/@plana-solutions/agent-interface/dist/client/genui/rendered.js` (cache each turn layout and the answer
list per messages array, so one chat Message does not rebuild them 4-6 times), and
`node_modules/@plana-solutions/agent-interface/dist/client/thread-scroll-dom.js` (`WatchUserBubble` does not read layout
on mount; one forced layout per bubble made every thread switch a slow Patch, and the ResizeObserver's first report
gives the same value). Typing cost does not grow with the history:
`node_modules/@plana-solutions/agent-interface/dist/features/messages.js` and
`node_modules/@plana-solutions/agent-interface/dist/features/sidebar.js` memoize the message list and the sidebar on
every Model field except `composerText` and `composer` (neither view reads them), and
`node_modules/@plana-solutions/agent-interface/dist/client/update.js` keeps `timelines` and `threadScroll` as the same
objects when their rebuilt value is equal, so that memo hits on each keystroke. OpenUI parity with
`@openuidev/react-ui@0.18.1` (the React renderer this replaced; proven pixel-equal on the catalog):
`node_modules/@plana-solutions/agent-interface/dist/features/genui/card.js` +
`node_modules/@plana-solutions/agent-interface/dist/index.js`/`index.d.ts` (public `genUiCardView`;
`node_modules/@plana-solutions/agent-interface/dist/features/genui/render.js` exports `rendererView`),
`node_modules/@plana-solutions/agent-interface/dist/features/genui/medium-card-blocks.js` (composite card charts match
`AreaChart`/`BarChart`/`LineChart`, as React does, so they get the 180 px card height),
`node_modules/@plana-solutions/agent-interface/dist/features/genui/charts/legend.js` (percentage as two text nodes, as
React renders it), and `node_modules/@plana-solutions/agent-interface/dist/features/genui/forms/select.js` (the popover
wrapper is `position: absolute`, so it opens under its trigger). `src/agentInterfacePatch.test.ts` fails if any of these
patches is missing.

To upgrade agent-interface:

1. Change the exact version in `package.json`, run `npm install`.
2. If postinstall fails: make the same change by hand in `node_modules/@plana-solutions/agent-interface/dist/`.
3. Delete the old patch file, run `npx patch-package @plana-solutions/agent-interface` (new file has the new version).
4. Run the four checks, then delete `node_modules/.vite` and restart the dev server.

## Guided goal page

`public/goal-page/` (served at `/goal-page/index.html`) is a plain HTML + JS page, not Foldkit: the Goals dialog's
"＋ New goal (guided)" link opens it. Its API is the coordinator's `/api/goal-page/*` (`../coordinator/src/goalPage.ts`,
prompts in `../coordinator/defaults/prompts/goal-page/`). Launch saves the GoalSpec and starts `sf goal run`.

## Live chat cards

The coordinator's `show_*` tools answer Foldkit turns with an OpenUI card whose data is an OpenUI
`Query("factory_card", …)` (built in `../coordinator/src/cards.ts`, rows from `../shared/cardviews.ts`). The card tools
(`factory_card`, `focus_agent`, `answer_decision`, `start_finding`) are `genui.tools` in `src/chatProgram.ts`.

Cards are refreshed by Messages, not timers: the `cardData` Subscription turns factory feed events that change card
data into `ReceivedCardDataChange`, and update sends the chat one `TickedGenUiQueryRefresh` per live card query
(`refreshCards` in `src/chat.ts`). The query's 60 s interval is only a safety net. A new card data source needs its
feed event in `CARD_EVENTS` (`src/subscription.ts`).
