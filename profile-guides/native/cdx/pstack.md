---
schemaVersion: 1
capabilities:
  - pstack-poteto-mode-orchestration
  - explicit-skill-invocation-workflows
  - codex-workspace-write-sandbox
  - keyless-proxy-model-routing
  - isolated-codex-profile-home
bestFor:
  - Substantial engineering tasks that benefit from Poteto Mode's playbook selection, verification checkpoints, controlled delegation, and an optional decision trail for long or multi-phase work ($poteto-mode activation marker plus $pstack-for-codex:poteto-mode skill)
  - Targeted single-operation work such as tracing a subsystem ($pstack-for-codex:how), reconstructing why code looks the way it does ($pstack-for-codex:why), or a skeptical multi-lens diff review ($pstack-for-codex:interrogate)
  - Reproduce-first bug fixing with $pstack-for-codex:tdd, or removing low-value comments/prose with $pstack-for-codex:no-comments and $pstack-for-codex:unslop
avoidFor:
  - Casual prompts that do not name a skill; all 45 pstack-for-codex skills require explicit $name invocation and are not auto-triggered
  - Tasks needing native OpenAI authentication by default; the profile routes through copilot-proxy-rs unless you opt in with cdx --native-auth
  - Multi-writer parallel edits on one shared checkout without isolation; pstack falls back to serial execution when safe isolation is unavailable
prerequisites:
  - id: codex-cli
    description: Codex CLI 0.146.0 or later installed on the host.
  - id: fish-shell-config
    description: An existing readable, writable, regular, non-symlink ~/.config/fish/config.fish (installer requires Fish).
  - id: proxy-health
    description: copilot-proxy-rs listening on http://127.0.0.1:8080 for the default keyless model routing.
  - id: hook-trust
    description: Interactive TTY sessions may be prompted once to trust pstack-for-codex hooks that keep Poteto Mode active across turns; non-TTY/CI launches bypass this automatically.
workflows:
  - id: poteto-mode-entry-point
    description: Route a substantial engineering task through Poteto Mode, which selects the applicable playbook and principles, plans the work, delegates isolated tasks when useful, and verifies the real result without expanding the agent's authority.
    skill: pstack-for-codex:poteto-mode
    examples:
      - Add a --json flag to this command; keep text output byte-identical and verify both modes
      - This retry path creates duplicate rows; reproduce it first, fix the root cause, and verify the real behavior
      - Investigate intermittent test failures
    promptTemplate: |
      $poteto-mode
      $pstack-for-codex:poteto-mode {{intent}}
  - id: targeted-single-skill
    description: Use the architect skill directly to define module boundaries and types before implementation, without the full Poteto Mode flow.
    skill: pstack-for-codex:architect
    examples:
      - Settle the types and module boundaries for this feature before I start implementing
      - Define the module boundaries and public interfaces for this new retry subsystem
    promptTemplate: |
      $pstack-for-codex:architect {{intent}}
  - id: review-and-polish
    description: Run a skeptical multi-lens review of a diff, then strip low-value comments and machine-shaped prose.
    skill: pstack-for-codex:interrogate
    examples:
      - Review this diff skeptically before I open the PR
      - Find correctness risks in this change, then remove unnecessary comments and mechanical prose
    promptTemplate: |
      $pstack-for-codex:interrogate {{intent}}
      $pstack-for-codex:no-comments
      $pstack-for-codex:unslop
---

# Native Codex (`cdx`) — `pstack` profile

`cdx pstack` runs the host Codex CLI with Aqua-123's `pstack-for-codex` plugin,
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
- You want Codex's native OS-level sandbox: writes restricted to workspace and
  temp directories, reads and network access allowed, no approval prompts.
- You want verification checkpoints and, for long, autonomous, or multi-phase
  work, a recorded decision trail through
  `$pstack-for-codex:show-me-your-work`.

## Avoid This Profile When

- You expect skills to trigger automatically from plain descriptions — every
  pstack-for-codex skill is explicit-invocation only; nothing fires without a
  `$name` in the prompt.
- You only need a simple question, quick lookup, or small edit. Invoke a
  narrower pstack skill directly when one operation still benefits from a
  specialized workflow.
- You need native OpenAI authentication by default; use
  `cdx --native-auth pstack exec "..."` for one launch instead.
- You need the optional `pstack-poteto-agent` / `pstack-comment-sicko` agent
  profiles without running `$pstack-for-codex:setup-pstack` first — they are
  opt-in and not installed by plain `cdx setup pstack`.

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

## Gotchas

- The profile includes the shared `native-common` floating skills in addition
  to the pstack plugin. Pstack-specific workflows still require the documented
  plugin skill identities.
- The `$name` skill-invocation syntax is specific to this Codex-native plugin;
  it does not carry over to `cdx superpowers` or any other native
  launcher's skill system.
