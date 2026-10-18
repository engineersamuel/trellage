---
schemaVersion: 2
templates:
  native-copilot-tool-assisted-engineering: |-
    Use OMP's native GitHub Copilot provider, available tools, and typed
    subagents to deliver {{intent}}.
  poteto-mode-orchestration: Use skill://poteto-mode to plan and coordinate {{intent}}.
  pstack-orchestrate-omp: |-
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
