---
schemaVersion: 1
capabilities:
  - firstmate-fleet-supervisor
  - parallel-isolated-worktree-workers
  - ship-and-scout-tasks
  - pull-request-delivery
  - captain-merge-authority
  - fleet-status-bearings
  - copilot-proxy-workers
  - latest-upstream-firstmate
bestFor:
  - Several related engineering tasks on one GitHub project that one supervisor should split, run in parallel isolated worktrees, and deliver as pull requests
  - Mixed investigation and implementation, where read-only scouts answer open questions before ship tasks change code
  - Long-running work where the human only approves decisions and merges instead of coordinating each agent
  - Checking fleet progress, open pull requests, and pending decisions in a running Firstmate session
avoidFor:
  - One small edit or question that a single agent can finish; use trx run pi default
  - Work on uncommitted changes, because workers start from the remote base branch and cannot see the local worktree
  - Untrusted repositories or tasks that need a container boundary; workers run on the host with permissions bypassed
prerequisites:
  - id: firstmate-tools
    description: git, gh, jq, node, treehouse, gh-axi and tasks-axi on PATH; trx run pi firstmate offers to install missing ones before launch.
  - id: proxy-health
    description: copilot-proxy-rs listening on http://127.0.0.1:8080; the supervisor and its workers reach models through it.
  - id: github-auth
    description: gh authenticated for the target GitHub project, because workers push branches and open pull requests.
workflows:
  - id: fleet-delivery
    description: Split a goal on one GitHub project into ship and scout tasks that run in parallel worktrees and return pull requests or reports.
    examples:
      - Fix the flaky login test and add dark mode to my web app
      - Find out why the test suite is slow, then speed it up once I approve a fix
      - Update the SDK to the new version and document the isolation status of every adapter
    promptTemplate: |
      ahoy! Plan this as Firstmate tasks for my GitHub project and run them as a fleet:
      {{intent}}
  - id: fleet-investigation
    description: Run read-only scouts that answer questions about a project with measured evidence and return reports, without changing code.
    examples:
      - Find which code paths can leak the API key into a child process
      - Measure the slowest tests and explain the cause of each
    promptTemplate: |
      ahoy! Send scouts (report only, no code changes) to answer:
      {{intent}}
  - id: fleet-status
    description: Report the running fleet's tasks, pull requests, reports and decisions waiting on the captain, without starting work.
    examples:
      - What is the fleet working on and what needs my decision
      - Which pull requests are ready to merge
    promptTemplate: |
      Show me /bearings, then answer without starting new work:
      {{intent}}
---

# Firstmate on Pi (`trx run pi firstmate`)

`trx run pi firstmate` starts Pi as the
[Firstmate](https://github.com/kunchenguid/firstmate) supervisor. trx clones
Firstmate to `~/.local/share/trellage/firstmate`, rebases it onto the latest
`main` before every launch, and starts Pi there. The user is the
captain: they talk only to Firstmate, and Firstmate starts, steers and
reports on its workers. Workers are Pi sessions pinned to the supervisor's generated Pi directory and its copilot-proxy-rs provider and model.

## Use This Profile When

- The goal splits into several tasks that can run at the same time on one
  GitHub project.
- Some questions must be answered (scouts) before code changes (ships).
- The captain wants pull requests and short reports, not to drive agents.

## Avoid This Profile When

- One agent can finish the work in one session.
- The work depends on uncommitted local changes. Workers start from the
  remote base branch.
- The target has no GitHub remote and the captain does not want a
  `local-only` project.

## Writing A Firstmate Message

The prompt is one message pasted into the Firstmate session. Firstmate reads
plain words, so write it the way a captain talks to a first mate:

- Start with `ahoy!`.
- Name the project as a GitHub `owner/name` with its base branch. When
  Firstmate may not know it yet, ask it to add the project and state the
  delivery mode: `direct-PR` (push and open a PR), `no-mistakes` (full
  validation pipeline before the PR) or `local-only` (no push). Use
  `direct-PR` unless the request says otherwise.
- Split the goal into numbered tasks with short titles. Mark each task
  `SCOUT` (report only, no code) or `SHIP` (code change delivered by the
  delivery mode). One task per worker; do not split work one worker can do.
- Use scouts first for uncertainty that can change the plan, and make the
  dependent ship wait for the captain's approval of a scout's finding.
- Say which tasks run in parallel. Add an order only for a real dependency,
  and name the condition: "starts only after task 1 is merged" or "starts
  only after I approve a fix from task A".
- Give each task the real files, symbols and commands it needs, and end it
  with one `Done when:` line a worker can check: tests that pass, text that no
  longer appears, a measured number.
- Add one `Rules for all tasks:` block for shared limits, such as files no
  worker may edit because other work is not merged.
- Remind Firstmate that workers start from the base branch and cannot see
  uncommitted work when that matters.
- Ask for visibility: `/bearings` once the tasks have started, and each pull
  request or report as soon as it is ready.
- Merges stay with the captain: never tell Firstmate to merge on its own
  unless the request says so.
- End with: `Ask me before you decide anything this prompt does not state.`

## Gotchas

- Only one Firstmate session can act per home. A second session stays
  read-only because the first holds the fleet lock.
- Do not tell Firstmate to use `/login` or the keychain: workers reach
  copilot-proxy-rs through files trx writes.
- Optional tools such as `no-mistakes` and `quota-axi` are only needed for
  `no-mistakes` delivery or quota profiles.
