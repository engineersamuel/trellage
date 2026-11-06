# web-foldkit agent guide

Foldkit (TEA + Effect) host for the software factory. The live Foldkit source and examples are vendored at
`repos/foldkit` (tag `foldkit@0.170.0`); grade code against them, not against memory.

## Checks

Run all four before you finish: `npm run typecheck`, `npm run lint`, `npm run test`, `npx vite build`.

## React islands

React is allowed only as an island inside the Foldkit view. These rules apply to every island:

1. **Foldkit owns all app state.** React never holds state the Model needs. If the app must know it, it lives in the Model.
2. **An island is a leaf.** Props go in; events come out as Foldkit Messages. Mount it with `h.OnMount(...)` and a
   `Mount.define`, the same way `MountTranscript` (`src/workerPanel/command.ts`) works: create the React root in
   `Effect.acquireRelease` and unmount it in the release.
3. **Use React only for libraries that exist only in React.** Examples: the OpenUI `Renderer`, a code editor, a chart.
   Never use React for layout or flow.
4. **Scene tests stub the island with `Mount.resolve`**, so the test story stays the same with or without React.
5. **Use framework-free CopilotKit parts directly.** `@ag-ui/client` has no React dependency. For AG-UI features
   (tool calls, state events), use the protocol, not `@copilotkit/react-core`.

## Patched packages

`patches/` holds `patch-package` patches; `postinstall` applies them with `--error-on-fail`, so `npm install` fails
when a patch no longer fits. `@plana-solutions/agent-interface` is patched in five files: `client/flags.js` (Effect 4.1 Crypto),
`features/timeline.js` (a `[data-sf-tool]` slot per finished tool call; `shared/diffview.ts` `startToolDiffs`
draws the file diffs in it), and `client/timeline.js` + `client/genui/rendered.js` (cache each turn layout and
the answer list per messages array, so one chat Message does not rebuild them 4-6 times), and
`client/thread-scroll-dom.js` (`WatchUserBubble` does not read layout on mount; one forced layout per bubble made
every thread switch a slow Patch, and the ResizeObserver's first report gives the same value).
`src/agentInterfacePatch.test.ts` fails if any of these patches is missing.

To upgrade agent-interface:
1. Change the exact version in `package.json`, run `npm install`.
2. If postinstall fails: make the same change by hand in `node_modules/@plana-solutions/agent-interface/dist/`.
3. Delete the old patch file, run `npx patch-package @plana-solutions/agent-interface` (new file has the new version).
4. Run the four checks, then delete `node_modules/.vite` and restart the dev server.

## Live chat cards

The coordinator's `show_*` tools answer Foldkit turns with an OpenUI card whose data is an OpenUI
`Query("factory_card", …)` (built in `coordinator/src/cards.ts`, rows from `shared/cardviews.ts`). The card tools
(`factory_card`, `focus_agent`, `answer_decision`, `start_finding`) are `genui.tools` in `src/chatProgram.ts`.

Cards are refreshed by Messages, not timers: the `cardData` Subscription turns factory feed events that change card
data into `ReceivedCardDataChange`, and update sends the chat one `TickedGenUiQueryRefresh` per live card query
(`refreshCards` in `src/chat.ts`). The query's 60 s interval is only a safety net. A new card data source needs its
feed event in `CARD_EVENTS` (`src/subscription.ts`).
