---
schemaVersion: 1
capabilities:
  - fmx-default-native-profile
  - firstmate-fleet-orchestration
  - isolated-git-worktree-crews
  - event-driven-worker-supervision
  - durable-firstmate-home
  - tmux-and-herdr-backends
  - consent-managed-firstmate-prerequisites
  - trellage-managed-claude-workers
bestFor:
  - Explicit requests for fmx default, fmx/default, or native:fmx/default
  - Coordinating several related engineering tasks across isolated Git worktrees while one Firstmate captain routes, supervises, and delivers the work
  - Long-running project programs that need durable backlog, task, watcher, and project state between captain interactions
  - Mixed ship and scout work where the captain should handle decisions and workers should report only actionable status changes
avoidFor:
  - Simple one-shot edits or questions that do not need a persistent fleet
  - Untrusted repositories or tasks that require a container security boundary; Firstmate workers run directly on the host
  - Work that requires a Firstmate backend other than Herdr or tmux, or a worker harness other than the Trellage-managed Claude runtime
prerequisites:
  - id: fmx-setup
    description: Run fmx setup default so the pinned Firstmate runtime and isolated captain state are installed; each worker gets separate state when spawned.
  - id: managed-fleet-tools
    description: On first launch, fmx detects missing locked Firstmate tools and offers to install them into the displayed fmx-owned user-data path only after explicit consent.
  - id: github-auth
    description: GitHub CLI authenticated through the host gh configuration; token-only environment authentication is not forwarded.
  - id: proxy-health
    description: copilot-proxy-rs listening on http://127.0.0.1:8080 and advertising the managed Claude model.
  - id: backend
    description: Run inside a Herdr pane or have tmux installed for the default backend.
workflows:
  - id: coordinate-fleet-delivery
    description: Let Firstmate decompose a substantial project request into isolated ship and scout tasks, supervise the crew, and return the integrated delivery outcome.
    examples:
      - Split this feature in /path/to/repository into independent worktrees, supervise the workers, and bring back the completed pull requests
      - Coordinate the bug fix, migration, and documentation work in my registered project as separate tasks without making me manage each agent
    promptTemplate: |
      ## Firstmate operating contract

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
  - id: run-fleet-investigation
    description: Dispatch isolated scouts for independent evidence gathering, reconcile their reports, and return one decision-ready conclusion.
    examples:
      - Investigate the three likely causes of this production regression in /path/to/repository and recommend the safest fix
      - Have separate scouts in my registered project compare these migration options, then synthesize the evidence and tradeoffs
    promptTemplate: |
      ## Firstmate investigation contract

      Keep Firstmate as the sole router and decision authority. Verify the
      target and registration state first. If project intake is incomplete,
      keep `no-mistakes` delivery with `yolo` off until registration is
      confirmed, propose the exact source and local name with standing defaults
      `no-mistakes-prod-only` and `yolo` off, then ask one concise confirmation
      before mutation.

      Consult existing reports before dispatch. Record a durable task graph and
      assign only independent, non-overlapping hypotheses to isolated scouts.
      Require concrete evidence, falsifiers, and self-contained report
      artifacts rather than speculative summaries. Confirm every scout is
      processing its brief, supervise durable status and wake events, steer
      blockers through the supported path, and record open decisions.

      Compare competing explanations centrally. If implementation becomes
      authorized, promote the existing scout when possible instead of creating
      duplicate work, then resolve `direct-PR`, `no-mistakes`, or `local-only`
      delivery and merge authority explicitly. Preserve completed reports,
      perform safe teardown only after their artifacts are secured, and return
      one decision-ready final report with ruled-out alternatives, remaining
      uncertainty, and the recommended next action. Do not make the user
      coordinate individual scouts.

      ## Investigation

      {{intent}}
---

# Native Firstmate (`fmx`) — `default` profile

`fmx default` runs a pinned Firstmate runtime with a durable profile-local
`FM_HOME`, one isolated Claude home for the captain, and separate Claude homes
for workers. Firstmate remains the only fleet router.

## Use This Profile When

- The work naturally divides into several ship or scout tasks.
- You want durable project registration, backlog, task status, watcher, and
  recovery state between conversations.
- You want the captain to own routing and decisions while autonomous workers
  stay in isolated Git worktrees.

## Avoid This Profile When

- One normal coding-agent session can finish the work directly.
- The repository is not trusted. This is host-native orchestration, not a
  container or security boundary.
- You need Zellij, Orca, cmux, any secondmate, or non-Claude workers; those
  upstream Firstmate surfaces are outside the first `fmx` contract.

## Workflow Notes

- `fmx` uses Herdr when launched inside a valid Herdr pane. Otherwise it uses
  tmux.
- First launch detects missing locked fleet tools and asks for consent before
  installing them into the displayed `fmx`-owned user-data path. Declining
  leaves the host unchanged.
- The captain and every worker use separate Trellage-managed Claude state.
- GitHub operations use the host `gh` configuration. Token environment
  variables are not forwarded into the model process.
- Firstmate source is pinned by the installed catalog. Use `fmx update`, not
  `/updatefirstmate`, to change the managed runtime.
- Generated prompts cover the supported fleet lifecycle conditionally. They do
  not force secondmates, Relay, voice, Zellij, Orca, cmux, browser work, or
  other upstream features that the selected task and v1 profile do not need.

## Gotchas

- The integration is experimental because upstream Firstmate has no immutable
  tagged release; this Trellage version uses one reviewed commit and overlay.
- The profile is interactive. It does not publish a headless prompt contract.
- Uninstall preserves Firstmate homes, project clones, task records, worker
  state, and the pinned profile runtime.
- Update and repair refuse while the captain or workers are active.
- Include a repository path or registered Firstmate project name in the task;
  the captain must not guess which repository the fleet should change.
