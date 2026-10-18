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

# Native Codex (`codex`) — `superpowers` profile

`trx run codex superpowers` runs the host Codex CLI with the `superpowers` plugin from
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
- You want Codex Full Access with no command approval prompts and no Codex OS
  sandbox. Commands run with the host account's permissions.
- You want disciplined branch-finishing and verification-before-completion
  habits enforced by the skill set rather than by manual checklist.

## Avoid This Profile When

- You need a security boundary around agent commands. Use the
  `codex-superpowers` Trellage Sandbox profile instead.
- You require native OpenAI authentication; this canonical profile is routed
  through local `copilot-proxy-rs`.
- You want to combine superpowers with a different Codex marketplace plugin in
  the same profile; setup, launch, update, and repair actively remove
  forbidden Superpowers variants rather than layering plugins.
- You need an interactive pause to answer a clarifying question; launch
  disables `default_mode_request_user_input`.

## Workflow Notes

- Superpowers' update path uses the native marketplace upgrade mechanism
  (`trx upgrade codex superpowers`), distinct from HVE's remove-and-reinstall update.
- `using-git-worktrees` and `using-superpowers` are meta-skills worth invoking
  early in a session to establish workflow conventions before diving into a
  specific task.
- These skill names come directly from this repository's own `config.example.toml`
  `superpowers` source selection (`https://github.com/obra/superpowers.git`),
  which the installed `superpowers-marketplace` plugin wraps — treat them as
  the vocabulary to reference in prompts.

## Gotchas

- The profile includes the shared `native-common` floating skills in addition
  to the Superpowers marketplace plugin.
- This repo has no verified evidence of an explicit `$name` invocation
  requirement for superpowers skills in Codex (unlike `trx run codex pstack`'s
  documented `$name` convention); treat skill names as descriptive vocabulary
  rather than a proven command syntax.
