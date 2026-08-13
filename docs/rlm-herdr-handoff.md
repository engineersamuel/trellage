# Herdr hand-off: RLM profile-validation report (2026-08-12)

## Context

An external orchestrator (Herdr + `invoke_trellage`) drove all 22 Trellage profiles
once each through `mise run rlm`, asking each delegated harness to reply with an
exact string. 15/22 (68%) failed, spanning at least 7 distinct root-cause
categories. The full original report, including per-profile transcripts and
timings, is reproduced in the RLM handoff session that authored this
repository's fixes; a durable per-profile compatibility ledger derived from it
lives at `docs/herdr-compatibility.json`.

This document is the Trellage-side response: what Trellage fixed directly in
this repository, and what remains **Herdr's responsibility** because it lives
in a different codebase (the `herdr` binary's `driveLoop`, agent detection,
`ScopedHerdr`, and `createHerdrTrellageBackend` are not part of this repo).

## What Trellage fixed (category G — broken profile environments)

- **`cpx hve`**: was `unhealthy` (missing `hve-core-all@hve-core` skill
  plugin). Repaired via `cpx repair hve`; `cpx doctor hve` and
  `cpx inventory hve --json` now report `healthy`. Ledger status: `untested`
  (repaired, awaiting a fresh Herdr verification run).
- **`codex-superpowers` container**: `codex-code-mode-host` — a companion
  binary Codex's experimental `features.code_mode_host` tool (which the
  Superpowers skill family enables) needs — was never resolved, locked, or
  installed by Trellage's codex packaging pipeline. `resolveCodexRelease` only
  ever fetched the primary `codex` GitHub release asset, never the sibling
  `codex-code-mode-host-{arch}-unknown-linux-musl.tar.gz` asset. This was
  already fixed on `main` in PR #80 (`codex-release.ts`, `resolvers.ts`,
  `lock.ts` resolve/lock/validate both assets as a `codex-code-mode-host`
  artifact) and #81 (Codex hooks-trust bypass, category B). The rebuilt image
  has `codex-code-mode-host` on `PATH` alongside `codex`. Ledger status:
  `untested` (fixed and locally verified at the binary level; awaiting a
  fresh Herdr end-to-end run since the original failure was inside the
  Superpowers skill workflow, not just "binary missing").

## What is genuinely blocked (out-of-repo infrastructure, not a code fix)

- **`omp/local`** and **`claude-qwen-local`**: both route to model
  `qwen3.6-35b-a3b-local` via a locally-running `copilot-proxy-rs` instance.
  That instance's `/v1/models` list has no qwen entry — no local Qwen
  inference backend was ever provisioned/registered with it. This is host/
  infrastructure provisioning, not something a Trellage code change can fix;
  repointing either profile's model would defeat its stated purpose (private,
  offline, cost-controlled local-model routing). Follow-up: provision a local
  Qwen model server and register it with `copilot-proxy-rs`, or accept these
  two profiles as `not-setup` until that infrastructure exists.

## What is genuinely Herdr's responsibility (not fixed here)

These root causes live in Herdr's `driveLoop`/agent-detection/consent-dialog
logic, a separate binary from this repository, so no code change here can
address them. Recommend filing these directly against Herdr:

1. **Agent-detection timeout (category A)** — `codex/superpowers`,
   `jcode/default`, `container/claude-council`, `container/prime-agent` never
   had a pane detected within the 300s window. Recommend: run each launcher
   manually inside a Herdr pane and check `herdr agent explain` against that
   pane to see why detection never fires — likely a TUI-signature mismatch
   for these specific launchers.
2. **Unrecognized first-run consent/onboarding dialogs (category B)** —
   `codex/hve` (Codex CLI hooks-trust screen) and `grok/superpowers` (Grok's
   first-run data-retention opt-in) stalled indefinitely because these dialogs
   aren't recognized by the "unambiguous permission dialogs are approved
   automatically" logic. Every profile risks this on its first-ever launch
   from a fresh profile home; recommend adding these as recognized dialogs.
3. **Repeated-approval-loop / no-progress detection (category C)** —
   `copilot/superpowers` printed the correct answer almost immediately, then
   got stuck in a loop where the harness kept re-asking "may I report this
   result?" in slightly different phrasing, and the isolated answerer kept
   re-approving without the harness ever writing `result.md`. This burned the
   turn budget and returned `outcome=turn_limit` despite the correct answer
   having been on screen the whole time. Recommend: detect repeated
   semantically-similar questions as no-progress and escalate (one hard nudge
   to "just write the file", then fail fast) rather than treating each as a
   fresh question.
4. **Composer-stuck nudge inconsistency (category D)** —
   `container/claude-blog` and `container/claude-frontend-design` both booted
   cleanly and had the correct prompt loaded into the input composer, but it
   was never submitted; the documented "3 identical frames then Enter" nudge
   (ADR 0011) didn't fire or didn't work for these two. Notably
   `container/claude-qwen-local` (same Claude Code harness, different model)
   *did* get its prompt submitted, so the nudge isn't universally broken —
   something about these two profiles' screen state specifically evades the
   stuck-frame detector. Recommend comparing captured frames across all three
   to find the discriminating difference.
5. **Scope/readiness resolution errors (category E, partial)** — `grx hve`
   failed with "Agent is outside run scope" (`ScopedHerdr`/
   `createHerdrTrellageBackend` didn't recognize the spawned pane as
   belonging to the current run) and `prx default` failed with
   "agent_not_ready: not an active named agent" (the pane never reached a
   ready state). Both fail fast and cleanly, but both native profiles are
   completely undrivable today. On the Trellage side, `prx`'s readiness gate
   is now exposed via the standardized `not_ready_inventory` contract (see
   below), which should make it easier for Herdr to distinguish "not ready
   yet" from "never became ready."
6. **Repo-context role confusion (category F)** — delegating to
   `cpx copilot/awesome` from within this repository's own worktree caused
   the delegate to load this repo's own docs (which describe
   `invoke_trellage` in detail) and mistake itself for the orchestrator,
   rather than completing the one-line task in `task.md`. This is a
   `task.md`/orchestration-prompt decision made by the calling tool, not by
   Trellage; recommend either not relying on delegates reading repo-root docs
   for short tasks, or having `task.md` explicitly state "you are not the
   orchestrator and have no `invoke_trellage` tool" when delegating within the
   orchestrator's own repository.

## What Trellage added to make future validation runs cheaper

- **Standardized readiness** across all native launchers (`cpx`, `cdx`,
  `grx`, `omp`, `jcx`, `cldx`, `prx`) — every launcher now exposes the same
  `not_ready_inventory` / `readiness: healthy | unhealthy | not-setup`
  contract driven by its `doctor_profile` check, including `prx`'s "active
  named agent" gate, which used to be a launch-time failure rather than a
  queryable readiness signal.
- **`trx list --json`** and **`trellage list --json-full`** now include a
  `readiness` field (derived live from each launcher's own doctor/readiness
  check) and an `herdrCompatibility` field (`status`, optional `issue`,
  optional `notes`) sourced from the curated ledger at
  `docs/herdr-compatibility.json`. A driving tool can now filter to
  `readiness: "healthy"` and `herdrCompatibility.status: "verified"` profiles
  before attempting to launch anything, instead of discovering failures live.
- **`trx inventory <launcher> <profile> --json`** passthrough command, so a
  caller can get the same structured readiness detail `trx list` summarizes,
  per-profile, without needing to know each launcher's own inventory CLI
  shape.

## Ledger maintenance

`docs/herdr-compatibility.json` is a curated signal, not a live probe —
Trellage cannot detect Herdr-side bugs automatically. Update it (and the
duplicated literal in `prototypes/trellage-router/bin/trx`, kept in sync by
convention) whenever a fresh Herdr-driven verification run changes a
profile's known status.
