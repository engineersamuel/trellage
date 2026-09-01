---
schemaVersion: 1
capabilities:
- broad-software-engineering
- cross-stack-engineering
- workflow-discovery
- specialist-agent-orchestration
- implementation-planning
- test-driven-delivery
- systematic-debugging
- hook-driven-quality-gates
- security-and-code-review
- delivery-verification
- persistent-engineering-memory
bestFor:
- Broad repository delivery that benefits from one opinionated toolbox for planning, implementation,
  testing, review, security, and verification
- Unfamiliar or mixed-language codebases where a large catalog of specialist agents and framework-specific
  guidance is more useful than a narrow workflow
- Existing repositories that benefit from ECC's standard hook automation and persistent engineering memory
avoidFor:
- Small, bounded edits that do not need a large workflow or hook suite
- Pure research or recent-source synthesis — use claude-research instead
- Architecture deliberation — use claude-council instead
- Frontend design — use claude-frontend-design instead
- Technical blogging — use claude-blog instead
- Social content — use claude-social-media instead
- Retryable graph execution with isolated worktrees — use claude-graph-of-loops instead
prerequisites: []
workflows:
- id: discover-ecc-workflow
  description: Inspect the installed ECC catalog and choose the smallest current skill, command, or agent
    set for the requested engineering task.
  skill: ecc:ecc-guide
  examples:
  - Find the best ECC workflow for migrating this service from REST to gRPC
  - Show me which installed ECC skills fit a production incident investigation
  promptTemplate: |
    /ecc:ecc-guide {{intent}}

    Read the installed ECC catalog before recommending a workflow. Select the smallest relevant set
    of current skills, commands, or agents and explain the next action.
- id: plan-change
  description: Ground a substantial code change in repository evidence and produce an approval-gated
    implementation plan.
  skill: ecc:plan
  examples:
  - Plan a safe migration from session cookies to short-lived access tokens
  - Create an implementation plan for splitting the billing worker into idempotent stages
  promptTemplate: |
    /ecc:plan {{intent}}

    Ground the plan in this repository's existing patterns, tests, and error handling. Do not edit code
    until I approve the plan.
- id: tdd-implementation
  description: Implement a feature, fix, or refactor with ECC's test-driven development workflow and
    repository-specific validation.
  skill: ecc:tdd-workflow
  examples:
  - Implement the approved rate-limiter plan with tests first
  - Fix this intermittent checkout failure using a test that reproduces the root cause
  promptTemplate: |
    /ecc:tdd-workflow {{intent}}

    Use the repository's existing test tools, preserve unrelated changes, and provide evidence for the
    failing test, the fix, and final validation.
- id: review-and-verify
  description: Review a local change or pull request, fix confirmed defects when requested, and run the
    relevant completion checks before delivery.
  skill: ecc:code-review
  examples:
  - Review the current uncommitted authentication changes and verify the final fix
  - Review pull request 42 for correctness risks, then verify the accepted changes
  promptTemplate: |
    /ecc:code-review {{intent}}

    After the review findings are resolved as requested, use /ecc:verification-loop before claiming
    the work is complete.
- id: end-to-end-feature-delivery
  description: Plan, implement, test, review, and verify a cross-stack feature with ECC's engineering
    agents, patterns, and lifecycle checks.
  skill: ecc:orch-add-feature
  examples:
  - Implement this account-deletion feature across the API, database, and frontend with tests and review
  - Deliver this cross-stack billing change with a plan, TDD, security checks, and final verification
  promptTemplate: |
    /ecc:orch-add-feature {{intent}}
- id: systematic-defect-repair
  description: Reproduce a defect, find its root cause, add a regression test, implement the repair,
    and pass ECC's verification gates.
  skill: ecc:orch-fix-defect
  examples:
  - Reproduce and fix this intermittent API timeout with a regression test
  - Diagnose why this migration corrupts nullable timestamps, then repair and verify it
  promptTemplate: |
    /ecc:orch-fix-defect {{intent}}
- id: repository-audit-and-hardening
  description: Audit an unfamiliar repository across architecture, security, tests, and delivery
    practices, then implement the approved hardening work.
  skill: ecc:production-audit
  examples:
  - Audit this service for security, test, and deployment gaps, then fix the highest-confidence issues
  - Review this unfamiliar monorepo and harden its error handling, CI checks, and dependency boundaries
  promptTemplate: |
    /ecc:production-audit {{intent}}
---

# claude-ecc

## Use This Profile When

- You want one broad Claude Code environment for feature delivery, defect repair, repository audits,
  workflow discovery, and cross-stack engineering.
- You benefit from ECC's large catalog of agents, skills, commands, language patterns, lifecycle hooks,
  and persistent engineering memory.
- You want ECC's hook runtime contained inside the Trellage Sandbox instead of running with direct host
  access.

## Avoid This Profile When

- The task is small and bounded; a lighter Native or Sandbox profile has less workflow overhead.
- The task has a narrow specialist outcome. Prefer `claude-research`, `claude-council`,
  `claude-frontend-design`, `claude-blog`, `claude-social-media`, or `claude-graph-of-loops` when its
  workflow matches.

## Workflow Notes

- Start with `/ecc:ecc-guide` when you do not know which current ECC component fits. Use `/ecc:plan`
  for standalone approval-gated planning, `/ecc:tdd-workflow` for focused implementation, and
  `/ecc:code-review` plus `/ecc:verification-loop` before delivery.
- This profile installs the complete `ecc@ecc` Claude marketplace plugin from its official upstream
  source and enables its `standard` hook profile. The plugin does not replace Trellage's
  `sandbox-common` skill bundle.
- ECC's hook runtime runs inside the container. Its state is stored under the
  persistent `/home/agent` profile volume.
- Trellage scopes ECC's temporary edit accumulator to the hook payload's Claude session ID during
  image materialization. Upstream drift in either accumulator hook fails the build closed.
- The upstream source is large and floats on `main`. Update the recorded ECC commit and Claude Code
  release with `trellage upgrade claude-ecc`.

### ECC Entry Points

Each workflow above declares the ECC surface its generated prompt opens with. These ship with the
`ecc@ecc` plugin:

| Surface | Use |
| --- | --- |
| `/ecc:orch-add-feature` | Gated Research, Plan, TDD, Review, Commit pipeline for net-new capability. |
| `/ecc:orch-fix-defect` | Reproduce a defect as a failing regression test, fix to green, review, gated commit. |
| `/ecc:orch-change-feature`, `/ecc:orch-refine-code` | Alter existing behavior, or restructure without changing behavior. |
| `/ecc:code-review`, `/ecc:test-coverage` | Targeted review of a diff or PR, and coverage gap analysis. |
| `/ecc:security-scan` | AgentShield scan of agent, hook, MCP, permission, and secret surfaces. |
| `/ecc:production-audit`, `/ecc:verification-loop`, `/ecc:tdd-workflow` | Production readiness audit, completion verification, and red-green-refactor discipline. |
| `code-architect`, `tdd-guide`, `code-reviewer`, `security-reviewer`, `silent-failure-hunter` agents | Phase specialists the orchestration pipeline delegates to. |

The orchestration pipeline stops at two human gates: **Gate 1** approves the plan before any
implementation, and **Gate 2** confirms before the commit. The ECC commands enforce both gates; do not
ask the agent to skip them. Ask for the exact commands and their real output in the final report,
because ECC's broad catalog makes an unverified completion claim easy to produce.

Run the gated orchestration workflows in an interactive
`trellage --profile claude-ecc` session and paste the prompt. A one-shot `-p` launch cannot answer
Gate 1 or Gate 2 and will stop at the first required confirmation.

`/ecc:security-scan` covers agent and configuration surfaces, not general application security. Name
the `security-reviewer` agent when the application code itself needs a security review.

## Gotchas

- The mounted worktree and shared Git metadata are writable by design.
- The container is a filesystem and process boundary, but the current Trellage network is not a
  default-deny egress boundary.
- ECC is intentionally broad. Its large catalog can add more routing and workflow overhead than a
  specialist profile.
- ECC repository `rules/` and `contexts/` are not imported. `include_mcp = false` excludes its root
  `.mcp.json`, so the unpinned sample `chrome-devtools-mcp@latest` command is not available.
- Like other proxy-backed Claude profiles, this requires the external `copilot-proxy-rs_default`
  Docker network.
