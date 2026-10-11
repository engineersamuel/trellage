---
schemaVersion: 1
capabilities:
  - keyless-local-proxy-model-routing
  - lsp-debugger-browser-eval-tools
  - typed-subagent-fan-out
  - community-skill-led-orchestration
  - native-common-skill-bundle
bestFor:
  - Fully keyless local model routing where every model role is assigned to the single qwen3.6-35b-a3b-local route
  - Sessions that retain OMP's full host tool and subagent surface without a Copilot or GitHub credential
  - Applying the shared poteto-mode, pstack-omp, and orchestrate-omp community skills with the 31 harness-neutral workflow, principle, automation, and support skills
avoidFor:
  - Hosts without copilot-proxy-rs listening on http://127.0.0.1:8080 with the local Qwen route registered
  - Work that needs OMP's native GitHub Copilot model catalog or authenticated Copilot models; use trx run omp default instead
  - Non-interactive launches that must fail on any user prompt; this profile remains conservative because it has no live headless smoke contract
prerequisites:
  - id: host-omp
    description: A valid host-installed OMP executable; Bun, Homebrew, and mise are supported owners for automatic update and latest-version checks, while manually maintained executables remain usable for setup, launch, repair, doctor, and inventory.
  - id: proxy-health
    description: copilot-proxy-rs listening on http://127.0.0.1:8080 with the qwen3.6-35b-a3b-local route registered for every model role.
  - id: omp-317-community-skills
    description: OMP 17.3.5 or newer for the bundled community skill directory to be discovered; older host versions remain usable without it.
  - id: cli-tools
    description: curl and jq available on the host for setup, doctor, and owner update checks.
workflows:
  - id: keyless-local-engineering
    description: Deliver an engineering outcome with OMP's full tool and typed-subagent surface on the one local model route.
    examples:
      - Analyze this failing integration test, implement the smallest fix, and verify it
      - Use typed subagents to refactor this module and review the integrated result
    promptTemplate: |
      Use OMP's keyless local route, available tools, and typed subagents to
      deliver {{intent}}.
  - id: poteto-mode-orchestration
    description: Use the shared poteto-mode community skill to structure multi-step orchestration work on the local model route.
    skill: skill://poteto-mode
    examples:
      - Use poteto-mode to break this task into coordinated phases
      - Use poteto-mode to plan, implement, and verify this local-model change
    promptTemplate: |
      Use skill://poteto-mode to plan and coordinate {{intent}}.
  - id: pstack-orchestrate-omp
    description: Combine the pstack-omp and orchestrate-omp community skills for workflow automation on OMP's typed subagent fan-out.
    skill: skill://pstack-omp
    examples:
      - Use the pstack workflow skills to drive this feature through design, implementation, and review
      - Coordinate specialized subagents to investigate this defect and verify the final patch
    promptTemplate: |
      Use skill://pstack-omp together with skill://orchestrate-omp to drive
      {{intent}} through OMP's typed subagent fan-out.
---

# Native Oh My Pi (`omp`): `local` profile

`trx run omp local` runs OMP with the host-installed `omp` executable and one
keyless `copilot-proxy-rs` route, `qwen3.6-35b-a3b-local`, assigned to every
model role. See `prototypes/trellage-omp-profiles/README.md` for the complete
lifecycle.

## Use This Profile When

- You want a keyless local route with no GitHub Copilot credential required.
- You want OMP's built-in LSP, debugger, browser, and eval tools together with
  typed subagent fan-out on the local model.
- You want the 34 approved OMP community skills and the shared native-common
  skill bundle.

## Avoid This Profile When

- No local Qwen inference backend is registered with the running
  `copilot-proxy-rs` instance. This is an infrastructure prerequisite, not a
  Trellage profile repair.
- The task needs OMP's native GitHub Copilot model catalog. Use `omp default`.
- The task needs a verified `--headless-policy no-user-input` contract. This
  profile remains conservative until its own live smoke test is recorded.

## Host installation and updates

Trellage does not install or pin a private OMP copy. A valid manually maintained
host executable is enough for setup, launch, repair, doctor, and inventory.
Bun, Homebrew, and mise are the supported owners for automatic update and
latest-version checks; updates remain owned by the package manager that owns
the resolved host executable:

```text
bun update -g --latest @oh-my-pi/pi-coding-agent '@oh-my-pi/pi-natives*'
brew upgrade can1357/tap/omp
mise upgrade github:can1357/oh-my-pi
```

`trx setup omp local` prepares the profile and managed overlay. `trx repair omp
local` reconciles managed state without changing the host OMP version.
`trx doctor omp local` is read-only and also checks proxy health and model
discovery. Unknown package ownership does not block setup, launch, repair,
doctor, or inventory; it fails only update and check. Update a manually
maintained host binary with the mechanism that installed it.

## Workflow Notes

- The local overlay assigns `copilot-proxy-rs/qwen3.6-35b-a3b-local` to every
  model role and restricts the enabled model list to that route.
- `PI_CONFIG_FILES` retains existing entries and receives the Trellage overlay
  last. Explicit OMP `--config` arguments load later and override the overlay.
- The common overlay disables startup update checks and marketplace auto-update,
  sets tool approval to `yolo`, enables Git protection and secret handling, and
  uses streaming cache warming.
- Trellage does not rewrite `config.yml`, authentication, sessions, caches,
  history, or unrelated profile state. The local `models.yml` is the one
  Trellage-managed exception because OMP has no provider-file overlay.
  Unrelated provider files block setup and repair instead of being overwritten.
- `dsebban/skills` and `Aqua-123/pstack-for-codex` provide the approved 34
  community skills. OMP 17.3.5 or newer discovers the community directory.
  `trx skills update` refreshes caches, and `trx upgrade omp local
  --skills-only` synchronizes the existing profile.

## Headless behavior

The local profile publishes conservative headless metadata for every host
version, including exact OMP 18.8.5, because no live smoke contract has been
recorded for the local Qwen route. The launcher accepts
`--headless-policy no-user-input` for the local profile at exact OMP 18.8.5 and
uses a temporary `ask.enabled: false` layer, which is removed after the launch.
That acceptance does not publish a verified local headless contract. Other
versions fail closed before invoking OMP.

## Gotchas

- `trx`'s Herdr compatibility ledger marks `omp`/`local` as `known-issue: G`:
  no local Qwen inference backend registered with the running
  `copilot-proxy-rs` instance is out-of-repo infrastructure provisioning.
- A host OMP upgrade does not grant headless support to this profile. Wait for
  a dedicated live smoke test before relying on non-interactive behavior.
