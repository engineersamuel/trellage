# Trellage Agent Guide

**Trellage Sandbox** compiles locked agent profiles and runs them in isolated
Docker containers. **Trellage Native** runs profile launchers directly on the
host. Examples: `trx`, `agx`, `cpx`, `cdx`, `cldx`, `fmx`, `grx`, `jcx`,
`omp`, `picx`, and `prx`.

## Project overview

- Trellage Sandbox profiles describe reproducible container environments.
- The Trellage Sandbox CLI validates, locks, builds, launches, resumes, diagnoses, and destroys those environments.
- Trellage Native profiles isolate agent state but are not containers or security boundaries, **except** `cdx` (Codex) and `grx` (Grok), which enable each harness's native OS-level sandbox (Seatbelt/Landlock, workspace-write scope, network allowed). Interactive `cdx` sessions allow on-request sandbox escalation so approved Git metadata writes can complete; non-interactive launches do not prompt. See `docs/native-sandbox-research.md`.
- The `trx` router presents Trellage Native profiles. Examples: `agx`, `cpx`, `cdx`, `cldx`, `fmx`, `grx`, `jcx`, `omp`, `picx`, and `prx` launchers.
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
  `mise run rebuild-profiles`: installs worktree `trellage`, reinstalls native
  launchers (`agx`/`cdx`/`cpx`/`cldx`/`fmx`/`grx`/`jcx`/`omp`/`picx`/`prx`) then `trx`, then
  runs a non-locked Sandbox `build` for each `profiles/*`. Use `--native-only`
  or `--sandbox-only` on the underlying script when you only need one side.
  Installed `post-merge` and `post-rewrite` hooks rebuild the compiler and
  refresh native launchers automatically when the local `main` worktree
  receives merged commits.

## Fresh Azure integration test

- The reusable execution goal is
  `docs/goals/azure-fresh-install.md`. Give that file to a goal-loop agent when
  the complete clean-host installation proof must be repeated.
- Before a live run, trust the worktree with `mise trust`, authenticate the
  Azure CLI, and provide both authentication contexts:
  `COPILOT_GITHUB_TOKEN` (or `GH_TOKEN` / `gh auth token`) for Native Copilot,
  and `COPILOT_PROXY_GITHUB_TOKEN` (or the safe mode-0600
  `~/.config/copilot-proxy-rs/github_token`) for `copilot-proxy-rs`.
- Run the static workflow contract without Azure cost:
  `make azure-fresh-install-contract`.
- Preview the effective Azure configuration without mutation:
  `mise run azure-fresh-install -- plan`.
- After the changes are merged, run the complete proof with
  `mise run azure-fresh-install -- all`. To test unmerged launcher candidates
  from the current worktree, use
  `TRELLAGE_AZURE_APPLY_LOCAL_CHANGES=1 mise run azure-fresh-install -- all`.
- A successful run must save evidence under
  `~/.local/state/trellage-azure-fresh/evidence/<resource-group>/`, verify exact
  `OK` results for all eight Native launchers and Sandbox `claude-council`,
  verify both `fmx` profiles through setup, doctor, healthy inventory,
  source-pin, and overlay evidence, and delete its owned Azure resource group.
- A failed run intentionally retains the resource group. Use
  `mise run azure-fresh-install -- ssh`, then retry `bootstrap` or `accept`.
  Always finish an abandoned run with `mise run azure-fresh-install -- down`.
- This is a live, billable, quota-consuming integration test. Do not add it to
  `make test` or run it without explicit intent. Before delivery, run
  `make test`; after merged launcher or compiler changes, also run
  `mise run rebuild-profiles`.

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
- `prototypes/trellage-router` and `prototypes/trellage-*-profiles` contain Trellage Native launchers and profiles (`agx`, `cdx`, `cpx`, `cldx`, `fmx`, `grx`, `jcx`, `omp`, `picx`, `prx`).
- `profiles` contains concrete locked profile definitions.
- `scripts` contains repository orchestration and profile verification tools.
- `tests` contains shell contracts for manifests, adapters, runners, sessions, workspaces, and evidence.
- `harnesses` contains comparison manifests consumed by `scripts/harness`.
- `.agents` contains canonical cross-harness rules, hooks, and MCP configuration.
- `.github` contains the GitHub Copilot instruction adapter and GitHub Actions workflow.
- `pocs` contains standalone, self-contained proof-of-concept examples that are deliberately independent of the Trellage profile compiler and its contracts (each subfolder has its own README/Dockerfile/scripts and is not exercised by `make test`).

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
- Preserve deterministic core profile locks and isolated runtime state. Skill
  content is intentionally floating and is not part of the lock.
- Keep static verification free of model inference and paid calls.
- Do not weaken or skip repository contracts to make a change pass.
- Keep changes scoped and preserve unrelated dirty-worktree edits.
- Every new Trellage Sandbox profile under `profiles/` MUST include
  `sandbox-common` in `skill_bundles`. This bundle supplies Caveman as an
  always-on skill, the selected mattpocock skills, `show-me`, and every skill
  from `engineersamuel/skills` except cataloged exclusions. The
  `engineersamuel` source MUST require `ui-guidelines`.
- Every new harness profile MUST mount the host `~/.copilot/models.json` read-only at `/home/agent/.copilot-models.json`.
- `skills.json` is the only skill-source allowlist. Skill entries MUST NOT
  contain a ref, commit, digest, or fetched timestamp. Third-party selections
  MUST be explicit. Wildcards require `allowWildcard = true`.
- Every native launcher MUST use the shared floating-skills manager with
  `native-common`. Every comparison image MUST use the single
  `comparison-common` snapshot staged for that build operation. These common
  bundles MUST retain the `engineersamuel` source so `ui-guidelines` is
  available on every native and container surface.
- Native first use and `trx skills update` fetch current default-branch
  content. Later native launches reuse the shared cache without network
  access. Sandbox and comparison builds fetch current skill content at build
  time. A fetch or validation failure MUST fail closed and preserve any
  previously published native cache.
