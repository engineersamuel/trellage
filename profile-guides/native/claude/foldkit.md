---
schemaVersion: 2
templates:
  build-foldkit-program: "Use the generate-program skill to build: {{intent}}"
  audit-foldkit-program: "Use the audit-program skill to audit this app without changing files: {{intent}}"
  debug-foldkit-runtime: "Inspect the intended Foldkit runtime with DevTools MCP and test data: {{intent}}"
  integrate-openui: "Check the project's Foldkit integration rules and current OpenUI docs before proposing an integration: {{intent}}"
---

# claude / foldkit

Launch with `trx run claude foldkit`. The profile adds Foldkit's `foldkit`, `generate-program`, and `audit-program` skills, OpenUI's `openui` skill, and two profile-scoped MCP servers. It uses the normal Claude proxy and selected common profiles.

## Use This Profile When

- You are building a new Foldkit app or changing an existing one.
- You need an architecture-focused audit of Foldkit code.
- You want to use OpenUI in a project whose own architecture and instructions allow it.
- A Foldkit development app is running and you need to inspect its live state.

## Workflow Notes

- Read the project's instructions and installed Foldkit package types first. A `repos/foldkit` subtree is optional reference material; use only a copy that matches the installed package release.
- Use the `generate-program` or `audit-program` skill for the matching task. The skills are managed in this profile and do not require a plugin marketplace install.
- Use Context7 for `/thesysdev/openui`. Context7 may need browser sign-in the first time. OpenUI MCP setup and skill guidance are at <https://www.openui.com/docs/mcp>.
- The Context7 server is profile-scoped. It does not configure MCP for other Claude profiles or edit the project.
- Foldkit DevTools MCP is available through the pinned `@foldkit/devtools-mcp@0.26.0` package. It requires `npx` and Node.js 22.19 or later.
- To inspect a live app, start its development server and open it in a browser yourself. Then call `foldkit_list_runtimes`, select the intended project and tab, and inspect with test data.
- DevTools can read current and historical Models, Messages, and recorded Command arguments. Check the Message Schema before dispatch. Replay and dispatch change runtime state.
- For OpenUI rendering, check the target project's explicit integration rules and installed packages. Do not assume a renderer is native to Foldkit or add React unless that project permits it.

## Project Changes

Starting this profile does not vendor Foldkit, scaffold an app, install project packages, or create or edit `AGENTS.md`, `CLAUDE.md`, `FOLDKIT.md`, `.mcp.json`, lockfiles, or Git history.

If deeper source context is useful and `repos/foldkit` is missing, ask before adding it. Pin a stable subtree to the `foldkit@<installed-version>` tag. For canary packages, use the full source commit named by the installed version. Keep upstream `FOLDKIT.md` separate from user-owned project instructions.

## Requirements

- Host Claude Code and the local `copilot-proxy-rs` endpoint at `http://127.0.0.1:8080`.
- Node.js 22.19 or later and `npx` for Foldkit DevTools MCP.
- A running Foldkit development server and open app tab only for live runtime inspection.
- Context7 sign-in when Claude requests authentication.

## References

- <https://foldkit.dev/ai/overview>
- <https://foldkit.dev/ai/skills>
- <https://foldkit.dev/ai/mcp>
- <https://www.openui.com/docs/mcp>
