---
name: finish
description: Use when and only when the user explicitly invokes $finish or /finish to commit current work, rebase onto origin/main, resolve conflicts, create a PR, enable squash auto-merge, and monitor it until merged.
disable-model-invocation: true
---

# Finish

1. Inspect the branch, complete worktree status with `git status --short --untracked-files=all`, and staged and unstaged diffs. If on the default branch, create a descriptive branch.
2. Triage every changed path before staging. The default is to commit all current worktree changes, even changes made before this invocation or unrelated to the latest task. If any path might contain local-only configuration, logs, caches, build output, generated artifacts, large binaries, or other content that might belong in `.gitignore`, stop and ask the user whether to commit, ignore, or remove it. Treat uncertain ownership or purpose as questionable and ask; do not guess or continue. If a path might contain a secret or credential, never commit it; stop and ask the user to remove or secure it.
3. After the triage has no unresolved questionable paths, stage everything with `git add -A`. Confirm no unstaged or untracked changes remain, run applicable checks, and commit all staged changes.
4. Run `git pull --rebase origin main`. Resolve every conflict while preserving both upstream intent and the current change, continue the rebase, then rerun affected checks.
5. Push with `git push --force-with-lease -u origin HEAD`.
6. Create the PR with `gh pr create`, then enable squash auto-merge with `gh pr merge --auto --squash`.
7. Monitor checks and PR state until GitHub reports `MERGED`. Fix owned check failures or conflicts, commit, rebase, push, and resume monitoring. Stop early only for a blocker that requires user action; report it exactly.

Never use raw `--force`, omit a non-questionable worktree change, merge `main` into the branch, or claim completion before the PR is merged.
