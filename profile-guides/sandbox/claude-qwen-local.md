---
schemaVersion: 1
capabilities:
- offline-local-model-coding
- cost-controlled-bounded-tasks
- private-code-editing
bestFor:
- Private, offline, or cost-controlled coding on bounded, well-scoped tasks
avoidFor:
- Peak-quality UI or design work — use an Opus profile
- Multi-agent orchestration
- Deep research
- High-stakes architecture decisions
prerequisites: []
workflows:
- id: bounded-local-edit
  description: Make a scoped code edit or bug fix entirely on the local Qwen model, with no cloud model
    routing.
  examples:
  - Fix the off-by-one error in this pagination function
  - Add input validation to this local-only script
  promptTemplate: |
    {{intent}}
- id: quick-refactor
  description: Refactor a small, self-contained module without invoking heavier cloud-routed profiles.
  examples:
  - Refactor this utils.py file to remove duplicate helper functions
  promptTemplate: |
    {{intent}}
---

# claude-qwen-local

## Use This Profile When

- You want the task to stay entirely on the local `qwen3.6-35b-a3b-local` model — private, offline-capable, and cost-controlled.
- The task is bounded and well-scoped: a specific bug fix, small refactor, or self-contained edit.

## Avoid This Profile When

- The task needs peak quality on hard UI/design problems — use claude-frontend-design or another Opus profile.
- The task needs multi-agent orchestration, deep research, or high-stakes architecture judgment — those need an Opus-routed profile.

## Workflow Notes

- This profile runs Claude Code in `core` mode with all three model routes (opus/sonnet/haiku) pinned to the same local Qwen model — there is no cloud fallback within the profile.
- No plugins are bundled beyond `sandbox-common`; treat this as a plain, low-ceremony coding profile rather than one with specialized skills.

## Gotchas

- Because every route resolves to the same local model, do not expect Opus-level reasoning quality even though the harness is Claude Code.
- There is no proxy gateway dependency for this profile — it does not need the `copilot-proxy-rs_default` Docker network the way Opus-routed profiles do.
