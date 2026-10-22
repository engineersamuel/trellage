---
schemaVersion: 2
templates:
  poteto-mode-entry-point: |-
    $poteto-mode
    $pstack-for-codex:poteto-mode {{intent}}
  targeted-single-skill: $pstack-for-codex:architect {{intent}}
  review-and-polish: |-
    $pstack-for-codex:interrogate {{intent}}
    $pstack-for-codex:no-comments
    $pstack-for-codex:unslop
---

# Native Codex (`codex`) — `pstack` profile

`trx run codex pstack` runs the host Codex CLI with Aqua-123's `pstack-for-codex` plugin,
a Codex-native derivative of `cursor/plugins`'s `pstack`. See
`prototypes/trellage-codex-profiles/README.md` and the upstream
`Aqua-123/pstack-for-codex` README for the skill catalog and invocation rules.

Poteto Mode is the profile's structured-work entry point. It turns a
substantial software-engineering request into an explicit workflow: understand
the problem, select the applicable playbook and principles, plan the work,
delegate isolated tasks when useful, implement in verifiable steps, and prove
the real result before declaring completion.

## Use This Profile When

- You want deliberate, explicit-invocation engineering skills:
  `$pstack-for-codex:poteto-mode` as the main entry point, plus 45 narrower
  skills such as `$pstack-for-codex:how`, `$pstack-for-codex:why`,
  `$pstack-for-codex:recall`, `$pstack-for-codex:architect`,
  `$pstack-for-codex:arena`, `$pstack-for-codex:swarm`,
  `$pstack-for-codex:interrogate`, `$pstack-for-codex:tdd`,
  `$pstack-for-codex:no-comments`, `$pstack-for-codex:unslop`,
  `$pstack-for-codex:show-me-your-work`, and
  `$pstack-for-codex:setup-benny`.
- You want Codex Full Access with no command approval prompts and no Codex OS
  sandbox. Commands run with the host account's permissions.
- You want verification checkpoints and, for long, autonomous, or multi-phase
  work, a recorded decision trail through
  `$pstack-for-codex:show-me-your-work`.

## Avoid This Profile When

- You need a security boundary around agent commands. Use a Trellage Sandbox
  profile instead; isolated Native profile state is not a sandbox.
- You expect skills to trigger automatically from plain descriptions — every
  pstack-for-codex skill is explicit-invocation only; nothing fires without a
  `$name` in the prompt.
- You only need a simple question, quick lookup, or small edit. Invoke a
  narrower pstack skill directly when one operation still benefits from a
  specialized workflow.
- You require native OpenAI authentication; this canonical profile is routed
  through local `copilot-proxy-rs`.
- You need the optional `pstack-poteto-agent` / `pstack-comment-sicko` agent
  profiles without running `$pstack-for-codex:setup-pstack` first — they are
  opt-in and not installed by plain `trx setup codex pstack`.

## Workflow Notes

- Codex namespaces plugin skills with the plugin name, but the upstream sticky
  hook still recognizes the legacy `$poteto-mode` activation marker. Start with
  the marker, then invoke the discovered skill identity:

  ```text
  $poteto-mode
  $pstack-for-codex:poteto-mode create a SIMD Rust binary search and verify its accuracy
  ```

- Start a new Codex task after installing or updating the plugin so Codex
  reloads the plugin catalog; skill discovery does not refresh mid-session.
- Poteto Mode does not grant extra authority. Reversible local work can proceed
  within the active task, but the mode does not itself authorize commits,
  pushes, deployments, messages, destructive operations, or other external
  writes. The main Codex agent keeps integration and final verification
  responsibility when it delegates.
- A trusted hook can keep Poteto Mode active for later turns in the same Codex
  session. Without a valid sticky receipt, the complete workflow still applies
  to the current turn, but both invocation lines must be used again later. Say
  `disable $poteto-mode` to clear persistent activation.
- Codex CLI 0.146.0 has no offline runtime skill-index command; verify the
  installed catalog with `codex plugin list --json` rather than a live index.

## Writing Poteto Candidates

Write a direct request that gives Poteto a concrete outcome, an investigation
approach, evidence to return, and the next decision. Keep it conversational;
use short paragraphs or lists when they help. Do not expand every request into
a generic project brief or a repository-wide audit.

For architecture and recurring-agent-mistake investigations:

- Use `$pstack-for-codex:correct` to identify recurring mistake classes from
  commits, reverts, and available review evidence. State the history examined,
  cite examples, and count occurrences before calling a pattern common. The
  skill counts a recurring class only after two occurrences. Distinguish
  demonstrated agent mistakes from failures whose authorship is unknown.
- Use `$pstack-for-codex:architect` to compare ownership, module boundaries,
  types, and public interfaces that could prevent those mistakes. Connect each
  recommendation to observed failures; do not assume a rewrite is necessary.
- Use `$pstack-for-codex:recall` only when earlier decisions or conversations
  would help. Use supported project-scoped history access; report unavailable
  history and continue with available evidence.
- Resolve testable technical questions with small, reversible prototypes,
  reproductions, or measurements within the authorized scope. Report what was
  tried, the result, and what it changes about the recommendation. A read-only
  request permits proposing prototypes, not making prototype edits. Ask the
  user only for preferences or decisions evidence cannot settle.
- Return a high-level plan with evidence, alternatives tested, recommended
  changes, expected benefits, verification criteria, and remaining uncertainty.
  For plan-review requests, explicitly constrain correct and architect to
  investigation, design, and permitted prototypes. Their normal workflows
  proceed to fixes and implementation; require approval before those stages.

For a requested autopilot handoff, ask after plan approval whether the user
wants **autopilot-stack** (a reviewed linear Graphite stack the user lands) or
**autopilot-full** (independent PRs carried through merge). Preserve existing
authorization and explain the delivery difference when asking. Do not insert
this choice into tasks that do not request that delivery workflow.

"Project agent" is a user-requested coordinator role, not a guaranteed installed
Codex agent type. Preserve that request when given, but do not invent it for
ordinary tasks. The plugin uses `pstack-poteto-agent` when installed, otherwise
its documented generic-delegate fallback; do not silently install optional agents.

Keep all three candidates faithful to the same scope and checkpoints. For this
kind of investigation, vary history-first, architecture-first, and prototype-first
approaches. An ordinary bug fix should instead focus on reproduction, root cause,
and verification, without inheriting this example's project or approval stages.

Example for a user requesting an agent-friendly architecture plan and a later
autopilot handoff (the renderer supplies the two activation lines):

> Create a project coordinator to investigate how to make this repo easier for
> agents to change correctly. Use $pstack-for-codex:correct to examine past commits
> and identify recurring code-quality, performance, and bug patterns. State the
> history examined and support each recurring class with at least two occurrences.
> Use $pstack-for-codex:architect to compare structural changes that prevent those
> failures. If prior conversations could explain the current design, use
> $pstack-for-codex:recall through supported history access and identify any gaps.
>
> Keep these skills in investigation and design until I approve the plan. Resolve
> testable open questions with small, reversible prototypes; report the evidence
> rather than deferring technical questions to me. Return a high-level plan with
> cited findings, alternatives tested, recommended changes, expected benefits,
> verification criteria, and remaining uncertainty. Do not implement the refactor yet.
>
> Once I approve the plan, ask whether I want autopilot-stack, which prepares a
> reviewed stack for me to land, or autopilot-full, which carries independent PRs
> through merge. Execute only after I choose.

## Gotchas

- The profile includes the shared `native-common` floating skills in addition
  to the pstack plugin. Pstack-specific workflows still require the documented
  plugin skill identities.
- The `$name` skill-invocation syntax is specific to this Codex-native plugin;
  it does not carry over to `trx run codex superpowers` or any other native
  launcher's skill system.
