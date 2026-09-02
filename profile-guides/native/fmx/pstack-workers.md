---
schemaVersion: 1
capabilities:
  - fmx-pstack-workers-native-profile
  - firstmate-fleet-orchestration
  - lean-pstack-worker-policy
  - conditional-worker-briefs
  - smallest-change-discipline
  - blast-radius-analysis
  - real-artifact-verification
  - consent-managed-firstmate-prerequisites
bestFor:
  - Explicit requests for fmx pstack-workers, fmx pstack-worker, fmx/pstack-workers, or native:fmx/pstack-workers
  - Substantial implementations, refactors, and debugging programs where Firstmate should coordinate the fleet and every worker should follow a concise pstack-derived engineering discipline
  - Parallel changes that need isolated worktrees plus explicit smallest-change, blast-radius, and real-artifact proof requirements
  - Complex work where workers should inspect architecture or history only when the task crosses a boundary or the reason for existing behavior affects the fix
avoidFor:
  - Work that needs the complete Cursor or Codex pstack plugin, Poteto Mode router, pstack subagents, or mandatory multi-frontier review
  - Simple one-shot edits where the extra worker-policy section adds no value
  - Work that requires Firstmate secondmates, a non-Claude worker harness, or a backend other than Herdr or tmux
  - Untrusted repositories or tasks that require a container security boundary
prerequisites:
  - id: fmx-pstack-setup
    description: Run fmx setup pstack-workers so the pinned Firstmate runtime, isolated captain state, and managed worker policy are installed.
  - id: managed-fleet-tools
    description: On first launch, fmx detects missing locked Firstmate tools and offers to install them into the displayed fmx-owned user-data path only after explicit consent.
  - id: github-auth
    description: GitHub CLI authenticated through the host gh configuration; token-only environment authentication is not forwarded.
  - id: proxy-health
    description: copilot-proxy-rs listening on http://127.0.0.1:8080 and advertising the managed Claude model.
  - id: backend
    description: Run inside a Herdr pane or have tmux installed for the default backend.
workflows:
  - id: disciplined-fleet-delivery
    description: Use Firstmate as the only fleet router while each worker receives a conditional pstack-derived inner loop for scope control and proof.
    examples:
      - Split this risky refactor in /path/to/repository across isolated workers, require the smallest safe changes, and prove each result with real commands
      - Coordinate this multi-part feature in my registered project and make every worker name its blast radius and verification gaps
    promptTemplate: |
      ## Firstmate pstack-worker operating contract

      Keep Firstmate as the sole router and integration authority. Verify the
      target repository path or registered project name rather than assuming
      registration. Until registration is confirmed, use the conservative
      unregistered posture: `no-mistakes` delivery with `yolo` off. If project
      intake is incomplete, propose the exact source and local name with the
      standing registration defaults `no-mistakes-prod-only` and `yolo` off,
      then ask one concise confirmation before mutation.

      Inspect the repository first and record the smallest useful durable task
      graph and worker count with explicit ownership, artifacts, and true
      dependencies. Ships are the default for implementation. Use scouts only
      when unresolved evidence can change what should be built, and promote an
      existing scout instead of creating duplicate implementation work. Assign
      genuinely independent, non-overlapping work to isolated worktrees, define
      shared interfaces before dependent implementation, and prevent duplicate
      edits.

      Rely on the profile-injected lean pstack-derived inner loop and do not
      duplicate its policy section in worker briefs. Each worker must choose the
      smallest logical change, state the expected blast radius, run a `how` walk
      only for unfamiliar areas or shared boundaries, run a `why` history check
      only when history affects the decision, prove completion with a real
      artifact, and report verification gaps. Workers must not route, merge, or
      assume captain authority. Do not invoke Poteto Mode, pstack subagents, or
      a second router.

      Confirm each spawned worker is processing its brief. Supervise durable
      status and wake events, steer blockers through the supported control path,
      and record open decisions so they survive captain turns. Serialize only
      for a true semantic dependency or shared mutable state; when a merge must
      land before another wave starts, state why a frozen interface or commit is
      insufficient.

      Resolve each task to `direct-PR`, `no-mistakes`, or `local-only` from the
      registered posture and task scope; do not offer a false binary. Under
      `no-mistakes-prod-only`, use `no-mistakes` for product-facing, mixed, or
      uncertain work and `direct-PR` for confirmed internal-only work. Ask
      before any required project or pipeline initialization. Preserve captain
      merge authority, hold green work durably while approval is pending, and
      continue unrelated ready work. Reconcile results, verify the integrated
      outcome, perform safe teardown only after required artifacts and delivery
      state are secured, and return one final report covering the task graph,
      worker artifacts, delivery state, decisions, gaps, and residual risks. Do
      not make the user coordinate individual workers.

      ## Task

      {{intent}}
  - id: disciplined-parallel-debugging
    description: Dispatch parallel debugging workers that reproduce first, inspect architecture or history only when needed, and return artifact-backed conclusions.
    examples:
      - Investigate these intermittent failures in /path/to/repository, reproduce them, and require artifact-backed conclusions
      - Have separate workers in my registered project test the likely root causes, but avoid broad architecture walks unless a boundary is involved
    promptTemplate: |
      ## Firstmate pstack-worker investigation contract

      Keep Firstmate as the sole router and decision authority. Verify the
      target and registration state first. If project intake is incomplete,
      keep `no-mistakes` delivery with `yolo` off until registration is
      confirmed, propose the exact source and local name with standing defaults
      `no-mistakes-prod-only` and `yolo` off, then ask one concise confirmation
      before mutation.

      Consult existing reports before dispatch. Record a durable task graph and
      assign only independent, non-overlapping hypotheses to isolated scouts or
      ship workers. Confirm every worker is processing its brief, supervise
      durable status and wake events, steer blockers through the supported path,
      and record open decisions.

      Rely on the profile-injected policy rather than duplicating it in worker
      briefs. Every worker must reproduce or obtain concrete evidence first,
      state the smallest logical next change and expected blast radius, run a
      `how` walk only for unfamiliar areas or shared boundaries, run a `why`
      history check only when history affects the decision, prove conclusions
      with a real artifact, and report falsified alternatives and verification
      gaps. Workers must not route, merge, or assume captain authority. Do not
      invoke Poteto Mode, pstack subagents, or a second router.

      Compare competing explanations centrally. If implementation becomes
      authorized, promote the existing scout when possible instead of creating
      duplicate work, then resolve `direct-PR`, `no-mistakes`, or `local-only`
      delivery and merge authority explicitly. Preserve completed artifacts,
      perform safe teardown only after delivery or report retention is
      confirmed, and return one evidence-backed final decision with remaining
      uncertainty and residual risks.

      ## Investigation

      {{intent}}
---

# Native Firstmate (`fmx`) — `pstack-workers` profile

`fmx pstack-workers` keeps Firstmate as the outer fleet router and injects one
small worker-policy section into ship and scout briefs. The policy is derived
from pstack's engineering principles, but it is not the full pstack runtime.

## What The Worker Policy Adds

- Prefer the smallest logical change and subtract before adding.
- Name the expected blast radius before expanding scope.
- Run a `how` walk only for unfamiliar areas, shared boundaries, or diagnosis.
- Run a `why` history check only when history affects the decision.
- Give one short reason when those walks are not needed.
- Prove completion with a real artifact, command, flow, or local verifier.
- State any remaining verification gap.
- Stay a worker; never take over fleet routing, merge authority, or captain
  decisions.

## What It Does Not Add

- No `$poteto-mode` invocation.
- No Cursor or Codex pstack plugin dependency.
- No pstack subagent fleet.
- No second work router.
- No mandatory multi-frontier review before every delivery.

## Gotchas

- The integration is experimental because upstream Firstmate has no immutable
  tagged release; this Trellage version uses one reviewed commit and overlay.
- First launch detects missing locked fleet tools and asks for consent before
  installing them into the displayed `fmx`-owned user-data path. Declining
  leaves the host unchanged.
- The policy is always present as a short conditional section, but workers run
  its expensive inspection steps only when the stated condition applies.
- This profile has the same host-native security boundary and v1 backend and
  harness limits as `fmx default`.
- Use `native:cdx/pstack` instead when you want one Codex agent running the
  complete Codex pstack skill catalog rather than a Firstmate fleet.
- Include a repository path or registered Firstmate project name in the task;
  the captain must not guess which repository the fleet should change.
- Generated prompts cover the supported fleet lifecycle conditionally. They do
  not force secondmates, Relay, voice, Zellij, Orca, cmux, browser work, or
  other upstream features that the selected task and v1 profile do not need.
