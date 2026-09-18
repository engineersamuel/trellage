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
  - retry-safe-fleet-inbox
  - fleet-status-and-project-memory
  - notify-only-condition-watches
bestFor:
  - Explicit requests for fmx default, fmx/default, firstmate/default, firstmate / default, or native:fmx/default
  - Coordinating several related engineering tasks across isolated Git worktrees while one Firstmate supervisor routes, supervises, and delivers the work
  - Long-running project programs that need durable backlog, task, watcher, and project state between interactions
  - Mixed ship and scout work where Firstmate handles delegated decisions and workers report actionable status changes
  - Reviewing progress and pending human decisions in an existing fleet without starting more workers
  - Preserving confirmed project findings with Stow or watching a defined fleet condition for notification
avoidFor:
  - Simple one-shot edits or questions that do not need a persistent fleet
  - Untrusted repositories or tasks that require a container security boundary; Firstmate workers run directly on the host
  - Work that requires a Firstmate backend other than Herdr or tmux, or a worker harness other than the Trellage-managed Claude runtime
prerequisites:
  - id: fmx-setup
    description: Select or create a fleet in the interactive guide when instance support is available. Unqualified fmx setup default prepares only the shared legacy fleet; it does not create a worktree fleet.
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
    frame: fixed
    scope: project
    description: Let Firstmate decompose a substantial project request into isolated ship and scout tasks, supervise the crew, and return the integrated delivery outcome.
    examples:
      - Split this feature in /path/to/repository into independent worktrees, supervise the workers, and bring back the completed pull requests
      - Coordinate the bug fix, migration, and documentation work in my registered project as separate tasks without making me manage each agent
    promptTemplate: |
      ## Firstmate operating contract

      Keep Firstmate as the sole router and integration authority within the
      human captain's explicit authorization. Verify the
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
    frame: fixed
    scope: project
    description: Dispatch isolated scouts for independent evidence gathering, reconcile their reports, and return one decision-ready conclusion.
    examples:
      - Investigate the three likely causes of this production regression in /path/to/repository and recommend the safest fix
      - Have separate scouts in my registered project compare these migration options, then synthesize the evidence and tradeoffs
    promptTemplate: |
      ## Firstmate investigation contract

      Keep Firstmate as the sole router and decision authority for delegated
      fleet work. The human captain retains approval authority. Verify the
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
  - id: review-fleet-status
    frame: fixed
    scope: fleet
    description: Use Bearings and current fleet evidence to report progress, stale tasks, reports, and pending human decisions without dispatching more work.
    examples:
      - Show what my running fleet has completed, what is blocked, and which decisions need my approval
      - Review saved task and scout reports after a disconnected supervisor session without starting new workers
    promptTemplate: |
      ## Firstmate fleet status contract

      Review the selected fleet instance. Use the installed Bearings workflow
      and `fm-fleet-snapshot.sh --json` for current task, report, and decision
      evidence. Separate current state from the last recorded event and from
      process liveness. Name stale or missing evidence instead of guessing.
      The snapshot can refresh observation caches; do not describe it as
      universally mutation-free or call `fm-session-start.sh` as a status probe.

      Report completed artifacts, active work, blockers, pending human
      decisions, and saved requests whose dispatch is not yet proved. A saved
      inbox note or acknowledgement does not prove task completion. Do not
      create projects or workers, drain decisions to approve them, merge,
      deploy, or tear down the fleet. The human captain keeps decision authority.

      ## Status request

      {{intent}}
  - id: maintain-project-memory
    frame: fixed
    scope: project
    description: Use ordinary Stow to retain confirmed project findings and decisions in scoped Firstmate memory without changing runtime instructions.
    examples:
      - Save the confirmed architecture findings and decisions for my registered project so the next session can use them
      - Review my project memory, correct facts contradicted by current evidence, and retain the supporting references
    promptTemplate: |
      ## Firstmate project memory contract

      Confirm the selected project and the requested memory write scope. Read
      its existing memory and supporting evidence first. Use ordinary Stow to
      retain confirmed facts, decisions, unresolved questions, and references.
      Distinguish a hypothesis from a confirmed outcome. Do not retain secrets.

      Keep private memory and operational writes under the selected instance's `FM_HOME`.
      Do not modify the pinned runtime, create a Git index or skill registry in
      the home, or use advanced Stow skill offload. Do not initialize a project
      or change unrelated memory without a plain-text confirmation. This is
      memory work, not permission to dispatch implementation workers, merge,
      deploy, or alter the fleet. Report what changed and what remains uncertain.

      ## Memory request

      {{intent}}
  - id: watch-fleet-condition
    frame: fixed
    scope: fleet
    description: Register a supported condition watch that notifies Firstmate or the captain, with a defined deadline and no automatic consequential action.
    examples:
      - Notify me when the existing fleet's release checks finish; ask me for the observation deadline before arming the watch
      - Watch the blocked task until its dependency is ready, then notify Firstmate instead of dispatching or merging it
    promptTemplate: |
      ## Firstmate condition watch contract

      Confirm the condition, observation scope, deadline, and notification
      destination before arming a watch. Ask for missing values instead of
      inventing them. Use the installed condition-watch workflow and
      `fm-procevent-when.sh` with supported observational checks. State what
      evidence makes the condition true and what a timeout will report.

      Use only Firstmate's normal notification path. Condition satisfaction
      does not authorize task dispatch, new workers, arbitrary shell actions,
      merge, deployment, or teardown. Report the watch identity and how to
      inspect or cancel it through the supported control path. Preserve saved
      decisions and return control rather than adding another scheduler.

      ## Watch request

      {{intent}}
---

# Native Firstmate (`fmx`) — `default` profile

`default` is a configuration template. With instance support, the interactive
guide recommends a named fleet for the entry worktree and requires confirmation.
Each fleet has its own
pinned runtime, durable `FM_HOME`, supervisor Claude home, and worker homes.
Unqualified `fmx default` retains the shared legacy fleet.
Firstmate remains the only router within the selected fleet.
The captain is the human; the `captain/claude` directory holds supervisor state.

## Use This Profile When

- The work naturally divides into several ship or scout tasks.
- You want durable project registration, backlog, task status, watcher, and
  recovery state between conversations.
- You want Firstmate to own fleet routing while the human retains approval authority and workers
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
- The supervisor and every worker use separate Trellage-managed Claude state.
- The legacy fleet uses the `fmd-` prefix. For a named instance, use its owned
  runtime's verified task namespace, not a prefix derived from the profile,
  name, or UUID. Stop before creating tasks if that namespace cannot be verified.
  The profile permits only Claude workers.
- Validated `home/config/crew-dispatch.json` rules can select Claude models and
  effort per task. Explicit worker controls take precedence over a matching
  rule, its default, and the normal crew default. Guide-provider model and
  effort options do not change worker policy.
- The supervisor runs in `runtime/`, not the caller's repository. Guide
  workflows retain a confirmed project/source and base commit separately from
  Herdr placement. Staged, unstaged, and untracked changes are not copied.
- With the supported control API, queued requests for the same instance go to
  one fleet. Different `default` instances do not share state or supervisors.
  Start and recover save requests before starting one supervisor; send
  work uses the existing supervisor. Saved, announced, and completed are
  separate states. An unknown result must reuse its request ID.
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
- Update and repair refuse while the supervisor or workers are active.
- A new prompt in the same worktree reuses its fleet. After a prior supervisor
  exits, Recover may be the allowed action instead of Start. Joining another
  instance requires confirmation and does not change the worktree association.
- Shared tool or launcher changes must account for every active fleet.
  Instance support requires compatible Native and shared-writer components;
  do not bypass an upgrade diagnostic or remove a compatibility record.
- Supervisor recovery may retain live workers only on an unchanged verified
  runtime with ready prerequisites. It is not permission to update or repair.
- Fleet-status and condition-watch workflows do not require an invented
  project target and do not inherit delivery or teardown instructions.
- Include a repository path or registered Firstmate project name in the task;
  the supervisor must not guess which repository the fleet should change.
