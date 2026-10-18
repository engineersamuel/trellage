---
schemaVersion: 2
templates:
  discover-ecc-workflow: >-
    /ecc:ecc-guide {{intent}}


    Read the installed ECC catalog before recommending a workflow. Select the
    smallest relevant set

    of current skills, commands, or agents and explain the next action.
  plan-change: >-
    /ecc:plan {{intent}}


    Ground the plan in this repository's existing patterns, tests, and error
    handling. Do not edit code

    until I approve the plan.
  tdd-implementation: >-
    /ecc:tdd-workflow {{intent}}


    Use the repository's existing test tools, preserve unrelated changes, and
    provide evidence for the

    failing test, the fix, and final validation.
  review-and-verify: >-
    /ecc:code-review {{intent}}


    After the review findings are resolved as requested, use
    /ecc:verification-loop before claiming

    the work is complete.
---

# claude / ecc

Launch this profile with `trx run claude ecc`. It runs on the host and uses the local proxy at `http://127.0.0.1:8080`.

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
- The local `copilot-proxy-rs` service must be available at `http://127.0.0.1:8080`.
