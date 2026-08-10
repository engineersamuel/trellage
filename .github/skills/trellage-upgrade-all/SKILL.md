---
name: trellage-upgrade-all
description: 'Safely promote and run Trellage harness upgrades on the local host. Use when the user invokes trellage-upgrade-all, asks to upgrade every Trellage profile, synchronize the installed Trellage CLI with an active development worktree, verify harnesses against latest stable GitHub releases, or prove repeated upgrades are deterministic.'
user-invocable: true
disable-model-invocation: false
---

# Trellage Upgrade All

Promote verified local Trellage development work, run the installed host command, and prove every profile is current and reproducible.

## Safety Contract

- Operate on the host, not inside a Trellage agent container.
- Treat `command -v trellage` as the final executable under test.
- Never claim success from `node packages/trellage-cli/dist/cli.js` alone.
- Never overwrite, reset, discard, or mix unrelated dirty changes.
- Never push, force-push, merge with a merge commit, or publish a release unless separately requested.
- Prefer rebase when an active development branch must be brought onto local `main`.
- Run Git and build commands only in verified Trellage worktrees.
- Resolve the upgrade target once (see "Upgrade Target") and perform every upgrade, lock, and commit step there.
- Never expose or persist GitHub credentials. Use existing host `gh` authentication only for release metadata.
- A transient upstream failure may use a verified existing lock, but report that as fallback rather than as a newly resolved release.

## Upgrade Target

The **upgrade target** is the worktree whose profile locks this run upgrades and commits. Resolve it once, before step 1, and use it for steps 5, 6, 9, and 10.

```bash
target="${TRELLAGE_UPGRADE_ROOT:-<installed-repository>}"
```

- When `TRELLAGE_UPGRADE_ROOT` is set, it is authoritative. This is how automation points the upgrade at an isolated worktree instead of the developer's checkout.
- When it is unset, the target is the installed repository, preserving normal interactive behavior.

Validate an overridden target before using it:

1. `git -C "$target" rev-parse --show-toplevel` must equal `$target`.
2. Its `git rev-parse --git-common-dir` must match the installed repository's, so it is a worktree of the same Trellage repository.
3. It must be clean.

Fail if any check does not hold. Never fall back to the installed repository after an override was supplied; a bad override is an error, not a reason to write to the developer's checkout.

When the target is not the installed repository, treat the installed checkout as **read-only reference state**. Inspect it to identify and validate the CLI, but never commit to it, never fast-forward its `main`, and leave it exactly as found.

## Workflow

### 1. Identify the Installed CLI

Run:

```bash
command -v trellage
type -a trellage
```

Resolve symlinks until the real launcher is found. Derive its repository with:

```bash
git -C "<launcher-directory>" rev-parse --show-toplevel
```

Record the installed command path, resolved launcher path, repository, branch, commit, and `origin/main` commit. Fail if the launcher is not inside a valid Trellage repository.

### 2. Identify the Development Candidate

If the current directory belongs to the same Git repository, treat its worktree and `HEAD` as the development candidate. Otherwise, use the installed repository's local `main`.

Inspect both candidate and installed worktrees:

```bash
git status --short
git branch --show-current
git rev-parse HEAD
```

Stop before promotion if either worktree contains unrelated changes. Existing generated profile-lock changes may proceed only when they are the explicit subject of this upgrade.

### 3. Synchronize Local Main

Fetch metadata without changing files:

```bash
git fetch --prune origin
```

Skip this entire step when `TRELLAGE_UPGRADE_ROOT` is set: automation supplies a target already based on current `origin/main`, and promotion into the installed checkout is out of scope for that run.

If no development candidate is being promoted, fast-forward local `main` to `origin/main`.

If the candidate contains commits absent from installed `main`:

1. Require a clean, committed candidate.
2. Run the validation gate in the candidate.
3. Rebase the candidate onto current local `main` when necessary.
4. Fast-forward installed `main` to the candidate with `git merge --ff-only`.
5. Do not push unless the user explicitly asks.

If rebase conflicts occur, use the `resolving-merge-conflicts` skill. Never use destructive reset or checkout commands.

### 4. Validate and Build the Compiler

In `packages/trellage-cli`, run:

```bash
npm run lint
npm run format:check
npm test
npm run check
npm run build
```

The launcher's source fingerprint must accept the resulting `dist` build. Warnings may be reported, but any nonzero exit blocks promotion.

### 5. Capture the Pre-Upgrade State

Run from the resolved upgrade target so profile discovery cannot accidentally use another worktree:

```bash
cd "$target"
```

Because the `trellage` launcher dispatches to the worktree copy matching `$PWD`, this both pins profile discovery and keeps the CLI under test consistent with the target.

Require a clean tree. Record hashes of all profile lock files and the target's commit. Capture command output in a temporary file with a cleanup trap.

### 6. Run the Exact Installed Upgrade

Run:

```bash
trellage upgrade all
```

Require exit code zero, one successful `upgraded:` result for every discovered profile, and no `upgrade failed:` lines.

Reject stale behavior if output contains:

```text
npm:@anthropic-ai/claude-code@2.1.218
```

Claude must install through the locked native `http:claude` GitHub asset.

### 7. Verify Upstream Stable Releases

Use GitHub's stable latest-release endpoints:

```bash
gh api repos/anthropics/claude-code/releases/latest --jq .tag_name
gh api repos/openai/codex/releases/latest --jq .tag_name
gh api repos/github/copilot-cli/releases/latest --jq .tag_name
gh api repos/can1357/oh-my-pi/releases/latest --jq .tag_name
```

Normalize Claude `v`, Codex `rust-v`, Copilot `v`, and Pi `v` tag prefixes. Compare each profile's `[packages.harness].version` with its harness's latest stable release. Do not treat prereleases as stable.

If GitHub is unreachable and the upgrade used verified lock fallback, report upstream comparison as unavailable. Do not falsely claim latest-release verification.

### 8. Verify Active Runtime Images

For every profile, run the harness binary from:

```text
trellage-profile-<profile>-linux-arm64:locked
```

Use these entrypoints:

- Claude: `claude --version`
- Codex: `codex --version`
- Copilot: `copilot --version`
- Pi: `omp --version`

Require every runtime version to equal its lock version.

### 9. Prove Determinism

After the first successful upgrade, record all lock hashes. Run the exact installed command a second time:

```bash
trellage upgrade all
```

Require exit code zero, every profile upgraded, no failures, and identical lock hashes before and after the second run.

For Claude images, verify `/mise/installs/http-claude/<version>/metadata.json` records the lock's `source_date_epoch` as `extracted_at`.

### 10. Handle Expected Lock Updates

If the first run changed files:

1. Require every changed path to be a profile platform lock.
2. Reject any unexpected source, profile, script, or configuration change.
3. Review the lock diff for version, integrity, release URL, source commit, and final OCI digest changes.
4. Commit deterministic lock-only updates in the upgrade target with a concise `chore(profiles): ...` message.
5. Include the configured Copilot co-author trailer.
6. Do not push unless explicitly requested. Automation that set `TRELLAGE_UPGRADE_ROOT` owns pushing and pull-request creation.

If no release changed, the upgrade target must remain clean.

The installed repository must be clean and unchanged whenever it is not itself the target.

### 11. Completion Audit

Before reporting success, require:

- installed launcher resolves to the intended repository
- every lock change is committed in the upgrade target, and the target's `HEAD` advanced whenever locks changed
- the installed repository is unchanged when it is not the target
- local installed `main` contains the promoted fix (only when the installed repository is the target)
- compiler source and `dist` fingerprint match
- all discovered profiles succeeded twice
- locks match resolvable latest stable GitHub releases
- active runtime versions match locks
- second run produced no lock drift
- no temporary files remain
- no unexpected dirty files remain

Report the installed commit and a compact profile/version table. State any verified fallbacks explicitly.

## Failure Handling

| Failure | Required action |
| --- | --- |
| Installed CLI points to another checkout | Stop using worktree-local proof; synchronize or promote the installed checkout first |
| Candidate or installed tree has unrelated changes | Preserve them and stop; do not reset or overwrite |
| Compiler fingerprint is stale | Rebuild `packages/trellage-cli`, then rerun the installed launcher |
| Claude output references npm `2.1.218` | Installed checkout is stale; do not retry the network request |
| Release lookup fails transiently | Accept only a cryptographically verified existing lock and label it as fallback |
| One profile fails | Continue collecting all profile outcomes, fix the root cause, then rerun all profiles |
| Second run changes a lock | Treat as a reproducibility bug; diagnose before committing or reporting success |
| Runtime version differs from lock | Treat the image as stale or incorrectly tagged; rebuild and reverify |
