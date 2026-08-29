---
schemaVersion: 1
capabilities:
  - native-copilot-auth-model-catalog
  - lsp-debugger-browser-eval-tools
  - typed-subagent-fan-out
  - community-skill-led-orchestration
  - native-common-skill-bundle
  - host-token-auth-forwarding
bestFor:
  - Work that should use OMP's native GitHub Copilot authentication and full discovered model catalog instead of the local proxy
  - Sessions that lean on OMP's built-in LSP, debugger, browser, and eval tools alongside typed subagent fan-out
  - Applying the shared poteto-mode, pstack-omp, and orchestrate-omp community skills, plus the 46 pstack workflow/principle/automation/support skills
avoidFor:
  - Hosts with no usable GitHub Copilot credential and no willingness to run omp copilot auth-broker login github-copilot
  - Fully offline or airgapped model routing; use omp local for the keyless proxy-backed profile instead
  - Non-interactive launches that must fail on any user prompt without OMP 17.2.12 exactly; questionToolControl=prompt-only is only proved for that version
prerequisites:
  - id: mise
    description: mise installed on the host; setup resolves and pins the eligible OMP release.
  - id: copilot-credential
    description: A usable GitHub Copilot credential in COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, gh auth token, or (macOS) the copilot-cli Keychain entry, or profile-scoped auth via omp copilot auth-broker login github-copilot.
  - id: omp-317-community-skills
    description: OMP 17.3.5 or newer for the bundled community skill directory to be discovered; older pins omit it until omp update.
  - id: cli-tools
    description: curl and jq available on the host for setup, doctor, and update checks.
workflows:
  - id: native-copilot-tool-assisted-engineering
    description: Deliver a complex engineering outcome with OMP's native Copilot provider, tool surface, and typed subagents.
    examples:
      - Trace this production failure with the debugger, implement the fix, and verify the regression test
      - Use typed subagents to complete this refactor and review the integrated result
    promptTemplate: |
      Use OMP's native GitHub Copilot provider, available tools, and typed
      subagents to deliver {{intent}}.
  - id: poteto-mode-orchestration
    description: Use the shared poteto-mode community skill to structure multi-step orchestration work.
    skill: skill://poteto-mode
    examples:
      - Use poteto-mode to break this migration into coordinated phases
      - Use poteto-mode to plan, implement, and verify this cross-service change
    promptTemplate: |
      Use skill://poteto-mode to plan and coordinate {{intent}}.
  - id: pstack-orchestrate-omp
    description: Combine the pstack-omp and orchestrate-omp community skills for pstack-style workflow automation on OMP's typed subagent fan-out.
    skill: skill://pstack-omp
    examples:
      - Use the pstack workflow skills to drive this feature through design, implementation, and review
      - Coordinate specialized subagents to debug this regression and verify the final fix
    promptTemplate: |
      Use skill://pstack-omp together with skill://orchestrate-omp to drive
      {{intent}} through OMP's typed subagent fan-out.
---

# Native Oh My Pi (`omp`) — `copilot` profile

`omp copilot` runs OMP with its native GitHub Copilot provider and discovered
model catalog, defaulting to `github-copilot/gpt-5.6-sol:medium`, without the
local proxy. See `prototypes/trellage-omp-profiles/README.md`.

## Use This Profile When

- You want OMP's native GitHub Copilot authentication and model catalog
  instead of the keyless local proxy used by `omp local`.
- You want OMP's built-in LSP, debugger, browser, and eval tools together
  with typed subagent fan-out for a single task.
- You want the shared community skill bundle: `orchestrate-omp`,
  `poteto-mode`, and `pstack-omp` from `dsebban/skills`, plus 46 pstack
  workflow/principle/automation/support skills from
  `cursor/plugins/pstack` — 49 skills in total, synced into
  `agent/community-skills`.

## Avoid This Profile When

- No usable GitHub Copilot credential is available on the host and you are
  not ready to run `omp copilot auth-broker login github-copilot` for
  profile-scoped authentication.
- You want a fully offline, keyless proxy-backed route instead — use `omp
  local`.
- You need `--headless-policy no-user-input` to fail closed on a live-proved
  prompt/text contract and are not running exact OMP `17.2.12`; other
  versions fall back to conservative `headless` values.

## Workflow Notes

- Token order for native Copilot auth is `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
  `GITHUB_TOKEN`, then `gh auth token`; macOS additionally falls back to the
  existing `copilot-cli` Keychain credential. Only `COPILOT_GITHUB_TOKEN` is
  forwarded to OMP; other token variables are removed first, and the token is
  never copied to disk or logged.
- `dsebban/skills` and `cursor/plugins/pstack` both provide a `poteto-mode`
  skill; Trellage intentionally selects the `dsebban` version because it
  adapts pstack skill links and agent roles for OMP.
- Tool approval is set to `yolo` in both managed configuration and every
  launch argument vector; the agent can use all host access available to the
  OMP process.
- The profile also carries the shared `native-common` floating skill bundle
  (see `skills.json`: `engineersamuel` wildcard plus `show-me`).

## Gotchas

- `trx`'s Herdr compatibility ledger marks `omp`/`copilot` as `verified`
  with no open known-issue entry.
- The bundled 49 community skills require OMP `17.3.5` or newer; a profile
  pinned to an older release omits the `agent/community-skills` directory
  from discovery until `omp update` runs.
- `skill://` is the invocation convention documented by `dsebban/skills` for
  its own three community skills; no equivalent explicit invocation syntax
  is documented for the 46 `cursor/plugins/pstack` skills bundled alongside
  them.
