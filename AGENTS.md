# Trellage Agent Guide

**Trellage Sandbox** compiles locked agent profiles and runs them in isolated
Docker containers. **Trellage Native** runs profile launchers directly on the
host. Examples: `trx`, `cpx`, `cdx`, and `grx`.

## Project overview

- Trellage Sandbox profiles describe reproducible container environments.
- The Trellage Sandbox CLI validates, locks, builds, launches, resumes, diagnoses, and destroys those environments.
- Trellage Native profiles isolate agent state but are not containers or security boundaries.
- The `trx` router presents Trellage Native profiles. Examples: `cpx`, `cdx`, and `grx` launchers.
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

## Architecture

- `packages/trellage-cli` contains the Effect-based TypeScript profile compiler and CLI.
- `prototypes/trellage` contains the Trellage Sandbox launcher and container runtime entrypoints.
- `prototypes/trellage-router` and `prototypes/trellage-*-profiles` contain Trellage Native launchers and profiles.
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

## Conventions

- Use Effect for TypeScript application logic where practical.
- Preserve deterministic profile locks and isolated runtime state.
- Keep static verification free of model inference and paid calls.
- Do not weaken or skip repository contracts to make a change pass.
- Keep changes scoped and preserve unrelated dirty-worktree edits.
