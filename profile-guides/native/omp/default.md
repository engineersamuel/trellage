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
  - Applying the shared poteto-mode, pstack-omp, and orchestrate-omp community skills with the 31 harness-neutral workflow, principle, automation, and support skills
avoidFor:
  - Hosts without a host-installed OMP executable or usable GitHub Copilot credential
  - Fully offline or airgapped model routing; use trx run omp local for the keyless proxy-backed profile instead
  - Non-interactive launches that must fail on any user prompt unless host OMP is exactly 18.8.5; only that version has the verified prompt/text contract
prerequisites:
  - id: host-omp
    description: A valid host-installed OMP executable; Bun, Homebrew, and mise are supported owners for automatic update and latest-version checks, while manually maintained executables remain usable for setup, launch, repair, doctor, and inventory.
  - id: copilot-credential
    description: A usable GitHub Copilot credential in COPILOT_GITHUB_TOKEN, GH_TOKEN, GITHUB_TOKEN, gh auth token, or (macOS) the copilot-cli Keychain entry, or profile-scoped auth via trx run omp default auth-broker login github-copilot.
  - id: omp-317-community-skills
    description: OMP 17.3.5 or newer for the bundled community skill directory to be discovered; older host versions remain usable without it.
  - id: cli-tools
    description: curl and jq available on the host for setup, doctor, and owner update checks.
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
    description: Combine the pstack-omp and orchestrate-omp community skills for workflow automation on OMP's typed subagent fan-out.
    skill: skill://pstack-omp
    examples:
      - Use the pstack workflow skills to drive this feature through design, implementation, and review
      - Coordinate specialized subagents to debug this regression and verify the final patch
    promptTemplate: |
      Use skill://pstack-omp together with skill://orchestrate-omp to drive
      {{intent}} through OMP's typed subagent fan-out.
---

# Native Oh My Pi (`omp`): `default` profile

`trx run omp default` runs OMP with the host-installed `omp` executable, its
native GitHub Copilot provider, and the discovered model catalog. The launcher
uses the backend's `copilot` profile name internally. See
`prototypes/trellage-omp-profiles/README.md` for the complete lifecycle.

## Use This Profile When

- You want OMP's native GitHub Copilot authentication and model catalog
  instead of the keyless local proxy used by `trx run omp local`.
- You want OMP's built-in LSP, debugger, browser, and eval tools together
  with typed subagent fan-out for one task.
- You want the 34 approved OMP community skills and the shared native-common
  skill bundle.

## Avoid This Profile When

- No host-installed OMP executable or usable GitHub Copilot credential is
  available, and profile-scoped authentication is not an option.
- You want a keyless local route instead. Use `trx run omp local`.
- You need `--headless-policy no-user-input` on an unverified OMP version.
  Trellage publishes that contract only for exact OMP 18.8.5.

## Host installation and updates

Trellage does not install or pin a private OMP copy. A valid manually maintained
host executable is enough for setup, launch, repair, doctor, and inventory.
Bun, Homebrew, and mise are the supported owners for automatic update and
latest-version checks; use the detected owner for updates:

```text
bun update -g --latest @oh-my-pi/pi-coding-agent '@oh-my-pi/pi-natives*'
brew upgrade can1357/tap/omp
mise upgrade github:can1357/oh-my-pi
```

`trx setup omp default` prepares the profile and managed overlay. `trx repair
omp default` reconciles managed state without changing the host OMP version.
`trx doctor omp default` is read-only. Unknown package ownership does not block
setup, launch, repair, doctor, or inventory; it fails only update and check.
Update a manually maintained host binary with the mechanism that installed it.

## Workflow Notes

- Token order for native Copilot auth is `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`,
  `GITHUB_TOKEN`, then `gh auth token`; macOS additionally falls back to the
  existing `copilot-cli` Keychain credential. Only
  `COPILOT_GITHUB_TOKEN` is forwarded to OMP. Admission briefly stages the
  credential in a per-launch mode-0600 file; the adapter removes that handoff
  immediately after reading it, and removes it on admission failure. The token
  is never included in admission JSON or logged.
- `PI_CONFIG_FILES` retains existing entries and receives the Trellage overlay
  last. Explicit OMP `--config` arguments load later and override the overlay.
- The overlay disables startup update checks and marketplace auto-update,
  enables the setup completion marker, sets tool approval to `yolo`, enables
  Git protection and secret handling, and uses streaming cache warming.
- Trellage does not rewrite `config.yml`, Copilot `models.yml`, authentication,
  sessions, caches, history, or other profile state. The local profile's
  provider file is the only managed `models.yml` exception.
- `dsebban/skills` and `Aqua-123/pstack-for-codex` provide the approved 34
  community skills. OMP 17.3.5 or newer discovers the community directory.
  `trx skills update` refreshes caches, and `trx upgrade omp default
  --skills-only` synchronizes the existing profile.

## Headless behavior

Only exact OMP 18.8.5 publishes the verified prompt/text headless capability.
After an unverified host upgrade, `trx list --json` publishes conservative
metadata and `--headless-policy no-user-input` fails before invoking OMP. The
temporary `ask.enabled: false` layer is passed with a later `--config` and is
removed after the launch.

## Authentication

If no host Copilot credential is available, use profile-scoped authentication:

```bash
trx run omp default auth-broker login github-copilot
```

The profile defaults to `github-copilot/gpt-5.6-sol:medium` while leaving the
rest of the authenticated Copilot model catalog available.

## Gotchas

- `trx`'s Herdr compatibility ledger marks `omp`/`copilot` as `verified` with
  no open known-issue entry.
- A successful package-manager update does not prove headless compatibility
  for the new version. Wait for a new live contract before relying on that
  capability.
