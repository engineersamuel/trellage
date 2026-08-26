---
schemaVersion: 1
capabilities:
  - superpowers-tdd-and-debugging-skills
  - rundown-briefing-output-style
  - autopilot-no-ask-user-launch
  - native-common-skill-bundle
  - isolated-copilot-home
bestFor:
  - Test-driven development and systematic root-cause debugging with GitHub Copilot CLI using the superpowers skill library
  - Branch lifecycle discipline — writing plans, executing them, and finishing a development branch cleanly
  - Code-review loops using requesting-code-review and receiving-code-review, plus subagent-driven or parallel-agent dispatch
avoidFor:
  - Tasks scoped to discovering/importing Copilot agents, instructions, or skills — use cpx awesome instead
  - Sessions that need an approval pause; every launch passes --autopilot --allow-all --no-ask-user
  - Mixing in the hve-core plugin in the same profile; setup and launch manage exactly one cataloged plugin per profile
prerequisites:
  - id: copilot-cli
    description: GitHub Copilot CLI 1.0.74 or later, already authenticated, on the host.
  - id: cli-tools
    description: jq and curl available on the host for setup, doctor, and update checks.
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

# Native Copilot CLI (`cpx`) — `superpowers` profile

`cpx superpowers` runs the host GitHub Copilot CLI with the `superpowers`
plugin from `obra/superpowers-marketplace`, the same skill library used by
`cdx superpowers` and referenced by this repository's own
`codex-superpowers`/`superpowers` skill sources. See
`prototypes/trellage-copilot-profiles/README.md`.

## Use This Profile When

- You want superpowers' design-first, TDD, root-cause debugging, review, and
  verification discipline driving GitHub Copilot CLI: `brainstorming`,
  `dispatching-parallel-agents`, `executing-plans`,
  `finishing-a-development-branch`, `receiving-code-review`,
  `requesting-code-review`, `subagent-driven-development`,
  `systematic-debugging`, `test-driven-development`, `using-git-worktrees`,
  `using-superpowers`, `verification-before-completion`, `writing-plans`, and
  `writing-skills`.
- You want disciplined branch-finishing and verification-before-completion
  habits enforced by the skill set rather than manual checklists.
- You want the built-in Rundown output style (TL;DR, checklist, "Your move:")
  applied automatically to responses.

## Avoid This Profile When

- The task is discovering or importing Copilot agents/instructions/skills —
  use `cpx awesome` instead.
- You want HVE Core's RPI workflow instead — use `cpx hve`; each profile
  installs exactly one cataloged plugin, not a combination.
- You need an approval pause before Copilot acts — launch always passes
  `--autopilot --allow-all --no-ask-user`.

## Workflow Notes

- These skill names come directly from this repository's own `skills.json`
  `superpowers` source selection (`https://github.com/obra/superpowers.git`),
  which the installed `superpowers-marketplace` plugin wraps.
- The profile also carries the shared `native-common` floating skill bundle
  (see `skills.json`: `engineersamuel` wildcard plus `show-me`), so
  general-purpose repository skills remain available alongside superpowers'.
- Update uses the native marketplace upgrade mechanism (`cpx update
  superpowers`); setup/launch/update/repair remove forbidden Superpowers
  variants rather than layering multiple plugin identities.

## Gotchas

- `trx`'s Herdr compatibility ledger marks `cpx`/`superpowers` as
  `known-issue: C`: a correct answer can be produced but the session gets
  stuck in a repeated approval loop (`outcome=turn_limit`) — watch for that
  pattern rather than assuming the run is a slow but ordinary loop.
- `cpx list --json` only advertises the exact prompt/`--no-ask-user`
  hard-deny/model-override contract for Copilot CLI `1.0.80`; other versions
  report conservative `headless` values.
