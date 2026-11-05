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
