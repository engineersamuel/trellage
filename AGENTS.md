# Trellage Agent Guide

**Trellage Sandbox** compiles locked agent profiles and runs them in isolated
Docker containers. **Trellage Native** runs profile launchers directly on the
host. Examples: `trx`, `cpx`, `cdx`, `cldx`, `grx`, `jcx`, `omp`, and `prx`.

## Project overview

- Trellage Sandbox profiles describe reproducible container environments.
- The Trellage Sandbox CLI validates, locks, builds, launches, resumes, diagnoses, and destroys those environments.
- Trellage Native profiles isolate agent state but are not containers or security boundaries, **except** `cdx` (Codex) and `grx` (Grok), which enable each harness's native OS-level sandbox (Seatbelt/Landlock, workspace-write scope, network allowed, no approval prompts). See `docs/native-sandbox-research.md`.
- The `trx` router presents Trellage Native profiles. Examples: `cpx`, `cdx`, `cldx`, `grx`, `jcx`, `omp`, and `prx` launchers.
- The comparison harness runs isolated coding-agent configurations against the same prompt.
- Generated evidence is normalized for later grading; the harness does not select a winner.

## Build and test

- Run the full repository suite with `make test`.
- Run profile compiler tests with `make profile-compiler`.
- Run native profile matrix contracts with `make profile-matrix-test`.
- Run static native profile verification with `make profile-matrix`.
- Run Oxlint with `cd packages/trellage-cli && npm run lint`.
- Check Oxfmt with `cd packages/trellage-cli && npm run format:check`.
- Run the TypeScript compiler directly with `cd packages/trellage-cli && npm run check`.
- Build the TypeScript package with `cd packages/trellage-cli && npm run build`.
- Live profile probes require explicit `PROFILE_MATRIX_ARGS=--live` opt-in because they may consume paid quota.
- Validate locally: `mise run trellage -- validate <profile name>`.
- Smoke-test locally: `mise run trellage -- --profile <profile name> -p "Reply exactly OK"`.
- After merging CLI/compiler/native launcher changes, from the repo root run
  `mise run rebuild-profiles`. This is the canonical all-profile
  `engineersamuel/skills` refresh path: it fetches the latest upstream commit,
  replaces the vendored snapshot and `REF`, updates every Sandbox profile ref
  and generated skill inventory, updates every native launcher ref and
  exact-ref TypeScript test assertion, installs worktree `trellage`, publishes
  the refreshed native runtime assets while reinstalling
  `cdx`/`cpx`/`cldx`/`grx`/`jcx`/`omp`/`prx` then `trx`, and runs a non-locked
  Sandbox `build` for each `profiles/*` to regenerate locks and image digests.
  Do not edit those synchronized refs, inventories, test assertions, locks,
  runtime assets, or Sandbox images manually. Use `--native-only` or
  `--sandbox-only` on the underlying script when you only need one side; the
  shared skill refresh still runs first. Rebuild comparison images separately
  with `make build`. Installed `post-merge` and `post-rewrite` hooks rebuild the
  compiler and refresh native launchers automatically when the local `main`
  worktree receives merged commits.

## Worktrees and mise trust

- `mise trust` is keyed by absolute config path, so every new worktree starts
  untrusted. This repository's `mise.toml` sets `[env]`, which mise refuses to
  load until trusted; `[tools]`-only configs need no trust.
- Symptom: any `mise run ...` in a fresh worktree fails with
  `Config files in <path>/mise.toml are not trusted`.
- Fix, once per worktree, from its root: `mise trust`.
- Verify with `mise trust --show` (expect `trusted`) or `mise tasks`.
- When deleting a worktree, run `mise trust --untrust` from it first; trust
  entries are keyed by path and otherwise accumulate for directories that no
  longer exist.
- Automation that creates worktrees must trust the config itself rather than
  assume an inherited trust decision. The checkout is a verbatim copy of an
  already-trusted `main`, so this is not a new trust decision.

## Architecture

- `packages/trellage-cli` contains the Effect-based TypeScript profile compiler and CLI.
- `prototypes/trellage` contains the Trellage Sandbox launcher and container runtime entrypoints.
- `prototypes/trellage-router` and `prototypes/trellage-*-profiles` contain Trellage Native launchers and profiles (`cdx`, `cpx`, `cldx`, `grx`, `jcx`, `omp`, `prx`).
- `profiles` contains concrete locked profile definitions.
- `scripts` contains repository orchestration and profile verification tools.
- `tests` contains shell contracts for manifests, adapters, runners, sessions, workspaces, and evidence.
- `harnesses` contains comparison manifests consumed by `scripts/harness`.
- `.agents` contains canonical cross-harness rules, hooks, and MCP configuration.
- `.github` contains the GitHub Copilot instruction adapter and GitHub Actions workflow.

## GitHub delivery

- Every profile image MUST declare the `gh` runtime package.
- Launch Trellage from a valid Git worktree.
- Trellage mounts writable worktree and common Git metadata.
- `gh` auth is ephemeral under the container `/tmp` tmpfs.
- NEVER bake, persist, log, or mount host GitHub credentials.
- Use `git` and `gh` only for explicit user-authorized delivery.
- Verify scope, tests, PR state, and merge result before reporting delivery.

## Grok profile recovery

- Applies ONLY to `grx`; `cdx` and `cpx` use different authentication.
- `grx` auth readiness failure? Verify `~/.grok/auth.json` is readable, regular, non-symlink.
- Valid source + missing profile `auth.json`? Run `grx repair PROFILE`, then `grx doctor PROFILE`.
- Regular profile `auth.json` with incorrect permissions? Set mode `0600`, then repair and doctor.
- Profile authentication symlink or non-regular path? Report it; NEVER alter it automatically.
- NEVER run `grok login`, delete authentication paths, follow authentication symlinks, or weaken authentication permissions without explicit user authorization.
- Repair or doctor failure? Report the exact diagnostic; NEVER substitute proxy or native authentication.

## Package feeds on Microsoft-managed devices

Microsoft-managed hosts block direct access to public package registries,
including `pypi.org`, `files.pythonhosted.org`, and often public npm/NuGet
endpoints. Use Central Feed Services (CFS) packagefeedproxy instead:

| Ecosystem | Approved simple / registry URL |
| --- | --- |
| npm | `https://packagefeedproxy.microsoft.io/npm/` |
| PyPI (pip / uv) | `https://packagefeedproxy.microsoft.io/pypi/simple/` |
| NuGet | `https://packagefeedproxy.microsoft.io/nuget/v3/index.json` |

### Trellage Sandbox (`trellage`)

Package feeds are **host policy**, not baked into profile images. That keeps
images and locked digests portable for non-Microsoft developers.

- **Image builds** honor host `npm config get registry` for npm, and discover a
  PyPI simple index for `uv`/pip in this order, injecting `UV_DEFAULT_INDEX` and
  `PIP_INDEX_URL` into the builder only when set/discovered:
  1. `UV_DEFAULT_INDEX` / `PIP_INDEX_URL` / `UV_INDEX_URL` in the environment
  2. Host `pip` / `pip3` / `python3 -m pip` `global.index-url` (from `pip config list`)
  3. If npm registry is `packagefeedproxy.microsoft.io/npm`, use the CFS PyPI URL above
- **Runtime sessions** (`docker exec`) forward the same host HTTPS feed env
  (`UV_DEFAULT_INDEX`, `PIP_INDEX_URL`, `npm_config_registry`, …) into every
  harness container so in-sandbox `pip`/`uv`/`npm` installs work on CFS hosts.
  No-op when those vars are unset (public registries).
- Proxy vars (`HTTP(S)_PROXY`, `NO_PROXY`, …) are forwarded into the builder.
- If Prime kernel bootstrap fails with `uv venv … --seed` exit code 2, assume
  public PyPI is blocked and confirm CFS discovery (or set `UV_DEFAULT_INDEX`
  explicitly) before rebuilding.
- Locked OCI digests for **prime-agent** (and any future build that installs
  unpinned PyPI packages) may differ between CFS and public-PyPI builders.
  Prefer a local non-locked rebuild when digests drift on a managed device.

Host one-time setup (fish example):

```fish
set -gx UV_DEFAULT_INDEX https://packagefeedproxy.microsoft.io/pypi/simple/
# npm and pip are often MDM-managed already; verify with:
#   npm config get registry
#   pip3 config list
```

Optional user uv config (`~/.config/uv/uv.toml`):

```toml
[[index]]
url = "https://packagefeedproxy.microsoft.io/pypi/simple/"
default = true
```

### Trellage Native (`trx`, `cpx`, `cdx`, `grx`, …)

- Native launchers run on the host; they inherit host package-manager config.
- Configure npm, pip, and uv on the host (as above). Do not rely on public PyPI
  inside agent sessions on Microsoft-managed devices.
- `trx` does not rewrite package feeds; keep shell/MDM defaults correct so every
  native harness sees the same CFS endpoints.

### Agent behavior

- Prefer the CFS feed URLs above over public PyPI/npm when installing packages
  on Microsoft-managed devices.
- Never disable corporate feed policy, tunnel around it, or commit secrets that
  bypass CFS.
- When documenting build failures, distinguish “CFS feed not configured for uv”
  from application bugs.

## Conventions

- Use Effect for TypeScript application logic where practical.
- Preserve deterministic profile locks and isolated runtime state.
- Keep static verification free of model inference and paid calls.
- Do not weaken or skip repository contracts to make a change pass.
- Keep changes scoped and preserve unrelated dirty-worktree edits.
- Every new Trellage Sandbox profile under `profiles/` MUST declare the pinned Caveman Agent Skill with `always_on = true`. Its platform lock MUST contain the exact resolved commit and inventory, and the profile MUST pass the deterministic Caveman matrix contract and no-model image probe. Trellage Native profiles are outside this rule unless separately requested.
- Every new harness profile MUST mount the host `~/.copilot/models.json` read-only at `/home/agent/.copilot-models.json`.
- Every native launcher and container harness (Trellage Sandbox profile, Trellage Native launcher, or comparison-harness container) MUST have the `humanlayer/skills` `show-me` skill installed (equivalent to `npx skills add humanlayer/skills --skill show-me`), so visual explanations (diagrams, code trees, diffs) are available on demand via `/show-me`. For Trellage Sandbox profiles, declare it as a pinned `[[skills]]` entry (`repository = "https://github.com/humanlayer/skills.git"`, a pinned commit `ref`, `select = ["show-me"]`) alongside the Caveman and mattpocock skill blocks; see any `profiles/*/profile.toml` for the pattern. Any future Trellage Native launcher or comparison-harness container MUST add an equivalent install step when one is introduced.
- Every new native launcher, Trellage Sandbox profile, and comparison-harness container MUST install every skill from `engineersamuel/skills`. Use the shared vendored snapshot and atomic sync helper for native launchers and comparison containers. Sandbox profiles MUST pin `https://github.com/engineersamuel/skills.git` and list the complete generated skill inventory in `select`. Rebuild and comparison build paths MUST refresh the snapshot before installing or building.
