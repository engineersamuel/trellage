---
schemaVersion: 1
capabilities:
  - keyless-local-proxy-model-routing
  - lsp-debugger-browser-eval-tools
  - typed-subagent-fan-out
  - omp-community-skill-bundle
  - native-common-skill-bundle
bestFor:
  - Fully keyless, local model routing where every model role is assigned to the single qwen3.6-35b-a3b-local route
  - Sessions that should retain OMP's full host tool and subagent surface without needing any Copilot/GitHub credential
  - Applying the shared poteto-mode, pstack-omp, and orchestrate-omp community skills, plus the 46 pstack workflow/principle/automation/support skills
avoidFor:
  - Hosts without copilot-proxy-rs listening on http://127.0.0.1:8080 with the local Qwen route registered; this profile has a known-issue when no backend is registered
  - Work that needs OMP's native GitHub Copilot model catalog or authenticated Copilot models — use omp copilot instead
  - Non-interactive launches that must fail on any user prompt; questionToolControl stays none for this profile until it has its own live smoke test
prerequisites:
  - id: mise
    description: mise installed on the host; setup resolves and pins the eligible OMP release.
  - id: proxy-health
    description: copilot-proxy-rs listening on http://127.0.0.1:8080 with the qwen3.6-35b-a3b-local route registered for every model role.
  - id: omp-317-community-skills
    description: OMP 17.3.5 or newer for the bundled community skill directory to be discovered; older pins omit it until omp update.
  - id: cli-tools
    description: curl and jq available on the host for setup, doctor, and update checks.
workflows:
  - id: local-smoke-test
    description: Confirm the isolated keyless local profile launches and responds before starting real work.
    examples:
      - Reply exactly OMP_LOCAL_OK
      - Check the models command reports the qwen3.6-35b-a3b-local route
    promptTemplate: |
      {{intent}}
  - id: poteto-mode-orchestration
    description: Use the shared poteto-mode community skill to structure multi-step orchestration work on the local model route.
    skill: skill://poteto-mode
    examples:
      - Use poteto-mode to break this task into coordinated phases
    promptTemplate: |
      Use skill://poteto-mode to plan and coordinate {{intent}}.
  - id: pstack-orchestrate-omp
    description: Combine the pstack-omp and orchestrate-omp community skills for pstack-style workflow automation on OMP's typed subagent fan-out.
    skill: skill://pstack-omp
    examples:
      - Use the pstack workflow skills to drive this feature through design, implementation, and review
    promptTemplate: |
      Use skill://pstack-omp together with skill://orchestrate-omp to drive
      {{intent}} through OMP's typed subagent fan-out.
---

# Native Oh My Pi (`omp`) — `local` profile

`omp local` runs OMP with one keyless `copilot-proxy-rs` route
(`qwen3.6-35b-a3b-local`) assigned to every model role, retaining OMP's full
host tool and subagent surface. See `prototypes/trellage-omp-profiles/README.md`.

## Use This Profile When

- You want a fully keyless, offline-capable local model route with no GitHub
  Copilot credential required; the managed provider uses `auth: none`.
- You want OMP's built-in LSP, debugger, browser, and eval tools together
  with typed subagent fan-out on the local model.
- You want the shared community skill bundle: `orchestrate-omp`,
  `poteto-mode`, and `pstack-omp` from `dsebban/skills`, plus 46 pstack
  workflow/principle/automation/support skills from
  `cursor/plugins/pstack` — 49 skills in total, synced into
  `agent/community-skills`.

## Avoid This Profile When

- No local Qwen inference backend is actually registered with the running
  `copilot-proxy-rs` instance — this is a documented known-issue, not a
  Trellage code defect.
- The task needs OMP's native GitHub Copilot model catalog — use `omp
  copilot` instead.
- The task needs `--headless-policy no-user-input` guarantees; this profile's
  `headless.questionToolControl` stays `none` until it has its own live
  smoke test, unlike `omp copilot` on exact OMP `17.2.12`.

## Workflow Notes

- Bare `omp` invocations use `local` by default; use `omp local ...` to be
  explicit or `omp copilot ...` for the other profile.
- `dsebban/skills` and `cursor/plugins/pstack` both provide a `poteto-mode`
  skill; Trellage intentionally selects the `dsebban` version because it
  adapts pstack skill links and agent roles for OMP.
- Tool approval is set to `yolo` in both managed configuration and every
  launch argument vector; the agent can use all host access available to the
  OMP process.
- The profile also carries the shared `native-common` floating skill bundle
  (see `skills.json`: `engineersamuel` wildcard plus `show-me`).

## Gotchas

- `trx`'s Herdr compatibility ledger marks `omp`/`local` as `known-issue: G`:
  no local Qwen inference backend registered with the running
  `copilot-proxy-rs` instance is out-of-repo infrastructure provisioning, not
  a Trellage code defect; the ledger also notes the drive loop can mask the
  real error as an empty submind-answerer response.
- The bundled 49 community skills require OMP `17.3.5` or newer; a profile
  pinned to an older release omits the `agent/community-skills` directory
  from discovery until `omp update` runs.
- `skill://` is the invocation convention documented by `dsebban/skills` for
  its own three community skills; no equivalent explicit invocation syntax
  is documented for the 46 `cursor/plugins/pstack` skills bundled alongside
  them.
