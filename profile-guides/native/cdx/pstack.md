---
schemaVersion: 1
capabilities:
  - pstack-poteto-mode-orchestration
  - explicit-invocation-skill-catalog
  - codex-workspace-write-sandbox
  - keyless-proxy-model-routing
  - isolated-codex-profile-home
bestFor:
  - Substantial engineering tasks that benefit from Poteto Mode's playbook selection, verifiable step recording, and narrower-skill delegation ($poteto-mode)
  - Targeted single-operation work such as tracing a subsystem ($how), reconstructing why code looks the way it does ($why), or a skeptical multi-lens diff review ($interrogate)
  - Reproduce-first bug fixing with $tdd, or removing low-value comments/prose with $no-comments and $unslop
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
    description: Route a substantial engineering task through Poteto Mode, which selects a playbook, records verifiable steps, and invokes narrower skills as needed while the parent task keeps integration authority.
    examples:
      - Add a --json flag to this command; keep text output byte-identical and verify both modes
      - This retry path creates duplicate rows; reproduce it first, fix the root cause, and verify the real behavior
    promptTemplate: |
      $poteto-mode {{intent}}
  - id: targeted-single-skill
    description: Invoke one specific pstack skill directly instead of the full Poteto Mode flow, for a narrow single-operation request.
    skill: architect
    examples:
      - Settle the types and module boundaries for this feature before I start implementing
      - Trace how the retry subsystem actually works today
    promptTemplate: |
      $architect {{intent}}
  - id: review-and-polish
    description: Run a skeptical multi-lens review of a diff, then strip low-value comments and machine-shaped prose.
    skill: interrogate
    examples:
      - Review this diff skeptically before I open the PR
    promptTemplate: |
      $interrogate {{intent}}
      $no-comments
      $unslop
---

# Native Codex (`cdx`) — `pstack` profile

`cdx pstack` runs the host Codex CLI with Aqua-123's `pstack-for-codex` plugin,
a Codex-native derivative of `cursor/plugins`'s `pstack`. See
`prototypes/trellage-codex-profiles/README.md` and the upstream
`Aqua-123/pstack-for-codex` README for the skill catalog and invocation rules.

## Use This Profile When

- You want deliberate, explicit-invocation engineering skills: `$poteto-mode`
  as the main entry point, plus 45 narrower skills such as `$how`, `$why`,
  `$recall`, `$architect`, `$arena`, `$swarm`, `$interrogate`, `$tdd`,
  `$no-comments`, `$unslop`, `$show-me-your-work`, and `$setup-benny`.
- You want Codex's native OS-level sandbox: writes restricted to workspace and
  temp directories, reads and network access allowed, no approval prompts.
- You want a recorded, reviewable trail of verifiable steps (via
  `$show-me-your-work`'s `decisions.tsv`) for a substantial change.

## Avoid This Profile When

- You expect skills to trigger automatically from plain descriptions — every
  pstack-for-codex skill is explicit-invocation only; nothing fires without a
  `$name` in the prompt.
- You need native OpenAI authentication by default; use
  `cdx --native-auth pstack exec "..."` for one launch instead.
- You need the optional `pstack-poteto-agent` / `pstack-comment-sicko` agent
  profiles without running `$setup-pstack` first — they are opt-in and not
  installed by plain `cdx setup pstack`.

## Workflow Notes

- Start a new Codex task after installing or updating the plugin so Codex
  reloads the plugin catalog; skill discovery does not refresh mid-session.
- `$poteto-mode` retains authority for integration, external writes, commits,
  pushes, and the final result even while it delegates to narrower skills.
- Hook trust for keeping Poteto Mode active across turns needs Codex to trust
  the plugin's hook source; without that trust it still works for the current
  turn only, reporting `current-turn-only`. Say "disable $poteto-mode" to
  clear session state.
- Codex CLI 0.146.0 has no offline runtime skill-index command; verify the
  installed catalog with `codex plugin list --json` rather than a live index.

## Gotchas

- Unlike `cldx`, `cpx`, `grx`, `jcx`, `omp`, `picx`, and `prx`, `bin/cdx` shows
  no wiring to the shared `native-common` floating-skills bundle — do not
  assume `engineersamuel` or `show-me` skills are present alongside pstack.
- The `$name` skill-invocation syntax is specific to this Codex-native plugin;
  it does not carry over to `cdx superpowers` or any other native
  launcher's skill system.
