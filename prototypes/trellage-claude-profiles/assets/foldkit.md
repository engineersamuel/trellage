# Foldkit and OpenUI

Use the selected `foldkit`, `generate-program`, `audit-program`, and `openui` skills for matching work. Read the project's `AGENTS.md`, `CLAUDE.md`, and any existing `FOLDKIT.md` first. Follow project-specific instructions when they define a deliberate exception to a general skill rule.

Foldkit's installed packages and types define the APIs in use. For deeper reference, use a `repos/foldkit` subtree only when it matches the installed release, and treat it as read-only. Application imports still come from installed packages. If the subtree is missing or stale, explain the optional release-matched setup; do not vendor or update it automatically. Stable releases use the `foldkit@<installed-version>` tag. For canaries, use the full commit identified by the installed version.

Foldkit follows the Elm Architecture: keep state in the Model, record facts as Messages, make `update` choose the next Model and Commands, and let `view` describe the UI. Use the Foldkit and Effect stack before adding another library. Keep an existing project's architecture and explicit integration rules; do not assume OpenUI is a native Foldkit renderer or change its UI framework or model provider just because the `openui` skill is available.

For OpenUI APIs and examples, use Context7 with library `/thesysdev/openui`. If Context7 is unavailable, consult <https://www.openui.com/llms.txt> and the relevant official OpenUI docs. Say when current docs could not be checked. Do not invent package APIs from memory.

DevTools MCP can inspect the live application, not just its code. Before reading runtime data, call `foldkit_list_runtimes` and confirm the intended project and browser tab. Use test data. Models, Message payloads, and recorded Command arguments may contain secrets or private data. Check the Message Schema before dispatching. Dispatch and replay change development runtime state; do not do either unless the task calls for it. Never start a server, open a browser, or dispatch Messages as profile setup.

The MCP server can start without a connected app. Runtime inspection requires a compatible Foldkit development server and an open app tab. Keep the project's `AGENTS.md`, `CLAUDE.md`, `FOLDKIT.md`, MCP files, dependencies, lockfiles, and Git history unchanged unless the user separately asks for a project change. This profile does not sandbox Claude's host access.

References:

- <https://foldkit.dev/ai/overview>
- <https://foldkit.dev/ai/skills>
- <https://foldkit.dev/ai/mcp>
- <https://www.openui.com/docs/mcp>
