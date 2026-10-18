---
schemaVersion: 2
templates:
  test-driven-development: |-
    Use the test-driven-development and systematic-debugging skills to
    address {{intent}}.
  plan-then-execute-branch: |-
    Use the writing-plans skill to draft a plan for {{intent}}, then
    executing-plans to carry it out, and finishing-a-development-branch to
    close it out.
  parallel-review-and-dispatch: |-
    Use dispatching-parallel-agents and subagent-driven-development to
    split up {{intent}}, then run requesting-code-review and
    receiving-code-review before merging.
---

# Native Copilot CLI (`copilot`) — `superpowers` profile

`trx run copilot superpowers` runs the host GitHub Copilot CLI with the `superpowers`
plugin from `obra/superpowers-marketplace`, the same skill library used by
`trx run codex superpowers` and referenced by this repository's own
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
  use `trx run copilot awesome` instead.
- You want HVE Core's RPI workflow instead — use `trx run copilot hve`; each profile
  installs exactly one cataloged plugin, not a combination.
- You need an approval pause before Copilot acts — launch always passes
  `--autopilot --allow-all --no-ask-user`.

## Workflow Notes

- These skill names come directly from this repository's own `config.example.toml`
  `superpowers` source selection (`https://github.com/obra/superpowers.git`),
  which the installed `superpowers-marketplace` plugin wraps.
- The profile also carries the shared `native-common` floating skill bundle
  (see `config.example.toml`: `engineersamuel` wildcard, `show-me`, and manually
  activated `i-have-adhd`), so
  general-purpose repository skills remain available alongside superpowers'.
- Update uses the native marketplace upgrade mechanism (`trx upgrade copilot superpowers
  superpowers`); setup/launch/update/repair remove forbidden Superpowers
  variants rather than layering multiple plugin identities.

## Gotchas

- `trx`'s Herdr compatibility ledger marks `copilot`/`superpowers` as
  `known-issue: C`: a correct answer can be produced but the session gets
  stuck in a repeated approval loop (`outcome=turn_limit`) — watch for that
  pattern rather than assuming the run is a slow but ordinary loop.
- `trx list copilot --json` only advertises the exact prompt/`--no-ask-user`
  hard-deny/model-override contract for Copilot CLI `1.0.80`; other versions
  report conservative `headless` values.
