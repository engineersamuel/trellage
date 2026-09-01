---
schemaVersion: 1
capabilities:
- broad-software-engineering
- workflow-discovery
- implementation-planning
- test-driven-development
- systematic-debugging
- code-review
- delivery-verification
bestFor:
- Broad software delivery when one profile should provide planning, implementation, debugging, review,
  and verification workflows
- Existing repositories that benefit from a large catalog of engineering skills and specialist agents
- Teams that want ECC's lifecycle and safety hooks without its heavier automatic formatting, type-check,
  or tmux behavior
avoidFor:
- Focused research, blogging, social content, frontend design, or council deliberation with a dedicated
  Trellage profile
- Small one-shot questions where a large workflow catalog adds unnecessary choice
- Work that explicitly requires ECC's standard or strict hook automation
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
---

# claude-ecc

## Use This Profile When

- You want one broad Claude engineering profile for discovery, planning, implementation, debugging, review, and verification.
- You want to choose from ECC's current skills and specialist agents instead of installing a narrow workflow profile.
- You want ECC hooks enabled for essential lifecycle and safety behavior without its heavier edit-time automation.

## Avoid This Profile When

- A focused Trellage profile already matches the task, such as `claude-research`, `claude-blog`, `claude-social-media`, `claude-frontend-design`, or `claude-council`.
- You only need a quick factual answer or a small reversible edit.
- You require ECC's `standard` or `strict` hook profile rather than the configured `minimal` profile.

## Workflow Notes

- Start with `/ecc:ecc-guide` when you do not know which ECC component fits. It reads the installed catalog instead of relying on stale feature counts.
- Use `/ecc:plan` for approval-gated planning, then use `/ecc:tdd-workflow` for implementation.
- Use `/ecc:code-review` for local or pull-request review, then use `/ecc:verification-loop` before delivery.
- The profile installs the official `ecc` Claude plugin from `affaan-m/ECC`, including its plugin-discovered commands, skills, agents, and hooks.
- `sandbox-common` remains available alongside ECC.

## Gotchas

- Hooks are enabled with `hook_profile=minimal`. Automatic tmux startup, formatting, type-checking, and strict reminders are intentionally not active.
- ECC repository `rules/` and `contexts/` are not imported by this profile. Its root `.mcp.json` is explicitly excluded, so the unpinned sample Chrome DevTools MCP is not available at runtime.
- The upstream source is large and floats on `main`; a Trellage release lock records the exact commit and plugin version used for a release.
- This Opus-routed profile requires the external `copilot-proxy-rs_default` Docker network.
