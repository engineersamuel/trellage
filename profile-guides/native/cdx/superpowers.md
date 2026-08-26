---
schemaVersion: 1
capabilities:
  - superpowers-tdd-and-debugging-skills
  - subagent-dispatch-workflow
  - codex-workspace-write-sandbox
  - keyless-proxy-model-routing
  - isolated-codex-profile-home
bestFor:
  - Test-driven development and systematic root-cause debugging using the superpowers skill library ported from obra/superpowers
  - Branch lifecycle discipline — writing plans, executing them, and finishing a development branch cleanly
  - Code-review loops that want both requesting-code-review and receiving-code-review conventions plus subagent-driven or parallel-agent dispatch
avoidFor:
  - Tasks that need native OpenAI authentication by default; the profile routes through copilot-proxy-rs unless you opt in with cdx --native-auth
  - Anything needing an interactive approval pause; launch always passes --ask-for-approval never and disables user-input requests
  - Sessions that need a different marketplace's skill set installed alongside superpowers; setup and launch remove forbidden Superpowers variants rather than mixing them
prerequisites:
  - id: codex-cli
    description: Codex CLI 0.146.0 or later installed on the host.
  - id: fish-shell-config
    description: An existing readable, writable, regular, non-symlink ~/.config/fish/config.fish (installer requires Fish).
  - id: proxy-health
    description: copilot-proxy-rs listening on http://127.0.0.1:8080 for the default keyless model routing.
workflows:
  - id: test-driven-development
    description: Drive an implementation from a failing test using the test-driven-development and systematic-debugging skills.
    skill: test-driven-development
    examples:
      - Fix this bug by first writing a failing test that reproduces it
      - Add this feature test-first and keep the test suite green throughout
    promptTemplate: |
      Use the test-driven-development and systematic-debugging skills to
      address {{intent}}.
  - id: plan-then-execute-branch
    description: Write a plan, execute it, and finish the development branch cleanly using writing-plans, executing-plans, and finishing-a-development-branch.
    skill: writing-plans
    examples:
      - Write an implementation plan for this feature before touching any code
      - This branch is ready; finish it and prepare it for review
    promptTemplate: |
      Use the writing-plans skill to draft a plan for {{intent}}, then
      executing-plans to carry it out, and finishing-a-development-branch to
      close it out.
  - id: parallel-review-and-dispatch
    description: Dispatch independent slices of work to parallel subagents and run a code-review exchange using dispatching-parallel-agents, subagent-driven-development, requesting-code-review, and receiving-code-review.
    skill: dispatching-parallel-agents
    examples:
      - Split this refactor into independent pieces and dispatch them in parallel
    promptTemplate: |
      Use dispatching-parallel-agents and subagent-driven-development to
      split up {{intent}}, then run requesting-code-review and
      receiving-code-review before merging.
---

# Native Codex (`cdx`) — `superpowers` profile

`cdx superpowers` runs the host Codex CLI with the `superpowers` plugin from
`obra/superpowers-marketplace`, Codex-adapted for design, TDD, debugging,
review, verification, and branch-finishing discipline. See
`prototypes/trellage-codex-profiles/README.md`.

## Use This Profile When

- You want the superpowers skill library — `brainstorming`,
  `dispatching-parallel-agents`, `executing-plans`,
  `finishing-a-development-branch`, `receiving-code-review`,
  `requesting-code-review`, `subagent-driven-development`,
  `systematic-debugging`, `test-driven-development`, `using-git-worktrees`,
  `using-superpowers`, `verification-before-completion`, `writing-plans`, and
  `writing-skills` — driving a Codex CLI session.
- You want Codex's native OS-level sandbox: writes restricted to workspace and
  temp directories, reads and network access allowed, no approval prompts.
- You want disciplined branch-finishing and verification-before-completion
  habits enforced by the skill set rather than by manual checklist.

## Avoid This Profile When

- You need native OpenAI authentication by default; use
  `cdx --native-auth superpowers exec "..."` for one launch instead.
- You want to combine superpowers with a different Codex marketplace plugin in
  the same profile; setup, launch, update, and repair actively remove
  forbidden Superpowers variants rather than layering plugins.
- You need an interactive pause to answer a clarifying question; launch
  disables `default_mode_request_user_input`.

## Workflow Notes

- Superpowers' update path uses the native marketplace upgrade mechanism
  (`cdx update superpowers`), distinct from HVE's remove-and-reinstall update.
- `using-git-worktrees` and `using-superpowers` are meta-skills worth invoking
  early in a session to establish workflow conventions before diving into a
  specific task.
- These skill names come directly from this repository's own `skills.json`
  `superpowers` source selection (`https://github.com/obra/superpowers.git`),
  which the installed `superpowers-marketplace` plugin wraps — treat them as
  the vocabulary to reference in prompts.

## Gotchas

- Unlike `cldx`, `cpx`, `grx`, `jcx`, `omp`, `picx`, and `prx`, `bin/cdx` shows
  no wiring to the shared `native-common` floating-skills bundle — do not
  assume `engineersamuel` or `show-me` skills are present here.
- This repo has no verified evidence of an explicit `$name` invocation
  requirement for superpowers skills in Codex (unlike `cdx pstack`'s
  documented `$name` convention); treat skill names as descriptive vocabulary
  rather than a proven command syntax.
