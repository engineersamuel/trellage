---
schemaVersion: 1
capabilities:
  - superpowers-tdd-and-debugging-workflows
  - grok-workspace-sandbox
  - keyless-proxy-model-routing
  - isolated-grok-profile-home
  - never-authenticate-guarantee
bestFor:
  - Test-driven development and systematic root-cause debugging using the superpowers skill library on a Grok session with its own subagents
  - Branch lifecycle discipline and code-review loops (writing-plans, executing-plans, finishing-a-development-branch, requesting/receiving-code-review)
  - Sessions that should keep network access but restrict filesystem writes to the working directory, ~/.grok/, and temp
avoidFor:
  - Sessions where no genuine grok login has ever been performed on the host; grx fails closed rather than prompting for login itself
  - Work needing MCP servers imported from ~/.grok/config.toml; MCPs are profile-local and must be configured explicitly per profile
prerequisites:
  - id: grok-build-cli
    description: Grok Build CLI 0.2.112 or later, tested with 0.2.112.
  - id: host-grok-login
    description: A genuine grok login performed once on the host outside grx, producing a usable ~/.grok/auth.json.
  - id: proxy-health
    description: copilot-proxy-rs listening on http://127.0.0.1:8080/v1 for the default grok-4.6 model routing.
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
      - Plan, implement, and verify this feature before preparing the branch for review
      - Complete this approved implementation plan and finish the branch cleanly
    promptTemplate: |
      Use the writing-plans skill to draft a plan for {{intent}}, then
      executing-plans to carry it out, and finishing-a-development-branch to
      close it out.
  - id: parallel-review-and-dispatch
    description: Dispatch independent slices of work to parallel subagents and run a code-review exchange using dispatching-parallel-agents, subagent-driven-development, requesting-code-review, and receiving-code-review.
    skill: dispatching-parallel-agents
    examples:
      - Split this refactor into independent pieces and dispatch them in parallel
      - Have independent subagents assess the migration, API, and test changes before integration
    promptTemplate: |
      Use dispatching-parallel-agents and subagent-driven-development to
      split up {{intent}}, then run requesting-code-review and
      receiving-code-review before merging.
---

# Native Grok (`grx`) — `superpowers` profile

`grx superpowers` runs Grok Build with the superpowers skill set (source
`obra/superpowers`), Grok-native sessions and subagents, and a separate
Caveman plugin. See `prototypes/trellage-grok-profiles/README.md`.

## Use This Profile When

- You want superpowers' design, TDD, debugging, review, verification, and
  branch-finishing skills — `brainstorming`, `dispatching-parallel-agents`,
  `executing-plans`, `finishing-a-development-branch`,
  `receiving-code-review`, `requesting-code-review`,
  `subagent-driven-development`, `systematic-debugging`,
  `test-driven-development`, `using-git-worktrees`, `using-superpowers`,
  `verification-before-completion`, `writing-plans`, `writing-skills` —
  driving a Grok session.
- You want Grok's native `--sandbox workspace` profile: filesystem writes
  restricted to the current working directory, `~/.grok/`, and temp, network
  access allowed, with `bypassPermissions`/`--always-approve` removing
  approval prompts independently of the sandbox layer.
- You want the never-authenticate guarantee described in the family README:
  `grx` never performs xAI login itself and fails closed instead of falling
  back to an interactive or device-code prompt.

## Avoid This Profile When

- No genuine `grok login` has ever been run on this host outside `grx` — the
  launcher exits with a diagnostic rather than prompting for login.
- You need MCP servers from your personal `~/.grok/config.toml`; configure
  each profile's MCPs explicitly instead (`grx superpowers mcp add ...`).
- You want HVE Core's RPI workflow instead — use `cpx hve`; `grx` no longer
  carries an HVE Core profile.

## Workflow Notes

- These skill names come directly from this repository's own `skills.json`
  `superpowers` source selection (`https://github.com/obra/superpowers.git`).
- Pass `-m`/`--model` to select another model from the proxy catalog instead
  of the `grok-4.6` default; `grx` forwards the option unchanged.
- The profile also carries the shared `native-common` floating skill bundle
  (see `skills.json`: `engineersamuel` wildcard plus `show-me`).
- Profile policy disables Claude/Cursor compatibility loading and Codex
  sessions; personal `~/.agents/skills` and `~/.agents/commands` are ignored,
  while repository-native `.grok`, `.agents`, and `AGENTS.md` remain visible.

## Gotchas

- `trx`'s Herdr compatibility ledger marks `grx`/`superpowers` as
  `known-issue: B`: the session can get stuck on an unrecognized Grok
  first-run data-retention consent screen — check for that screen before
  assuming the run has stalled for another reason.
- `GRX_DISABLE_AUTH_CHECK=1` exists only for trusted local proxy setups that
  intentionally route all model traffic through `copilot-proxy-rs`; it should
  not be set for ordinary use since it skips the host auth viability check.
