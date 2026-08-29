---
schemaVersion: 1
capabilities:
  - keyless-proxy-model-routing
  - semantic-memory
  - firefox-browser-automation
  - persistent-sessions
  - coordinated-agent-swarms
  - native-common-skill-bundle
bestFor:
  - Sessions that want jcode's built-in semantic memory to recall prior discussions, decisions, and patterns across sessions
  - Browser-driven tasks that benefit from jcode's Firefox automation instead of a headless-only tool
  - Multi-agent or coordinated-swarm work that jcode's own orchestration handles natively, without a separate plugin
avoidFor:
  - Tasks that need OS-level sandboxing or containment; jcx adds no containment and jcode runs with all host access available to the process
  - Sessions that must avoid any telemetry surface; note that JCODE_NO_TELEMETRY=1 is set on every launch, but this is jcode's own opt-out flag, not a Trellage guarantee about upstream behavior
  - Work that requires native OpenAI-style credentials; no API key is written and the profile always routes through the local proxy
prerequisites:
  - id: mise
    description: mise installed on the host; setup uses it to resolve and pin the eligible jcode release.
  - id: proxy-health
    description: copilot-proxy-rs listening on http://127.0.0.1:8080 for the default gpt-5.6-sol (medium reasoning) routing.
  - id: cli-tools
    description: curl and jq available on the host for setup, doctor, and update checks.
workflows:
  - id: recall-prior-context
    description: Use jcode's semantic memory to recall decisions or patterns from earlier sessions before starting related work.
    examples:
      - What did we decide about the retry strategy in an earlier session on this repo?
      - Recall the earlier design constraints for this feature before proposing the next change
    promptTemplate: |
      Use jcode's semantic memory to recall prior context for {{intent}}.
  - id: browser-driven-task
    description: Drive jcode's Firefox browser automation for a task that needs real page interaction rather than a headless fetch.
    examples:
      - Open this internal dashboard in the browser and confirm the new deployment banner is visible
      - Use Firefox to reproduce this checkout error and identify the failing request
    promptTemplate: |
      Use jcode's Firefox browser automation to complete {{intent}}.
  - id: coordinated-swarm-delivery
    description: Coordinate a larger outcome through jcode's native agent swarm while keeping the main task integrated.
    examples:
      - Coordinate a swarm to investigate this performance regression, implement the fix, and verify it
      - Split this cross-cutting feature among a swarm, then integrate and test the complete result
    promptTemplate: |
      Use jcode's coordinated agent swarm to deliver {{intent}} while keeping
      the final integration and verification in the main task.
---

# Native jcode (`jcx`) — `default` profile

`jcx` runs jcode directly on the host with one isolated `default` profile,
routed through keyless `copilot-proxy-rs` and defaulting to `gpt-5.6-sol` with
`medium` reasoning. See `prototypes/trellage-jcode-profiles/README.md`.

## Use This Profile When

- You want jcode's semantic memory, Firefox browser automation, persistent
  sessions, and coordinated agent swarms without managing an API key.
- You want an isolated `JCODE_HOME` so this profile's configuration,
  sessions, authentication, and memory never touch a personal `jcode`
  installation.
- You want the shared `native-common` floating skill bundle (`engineersamuel`
  wildcard plus `show-me`) available alongside jcode's own tools.

## Avoid This Profile When

- The task needs OS-level sandboxing or containment — `jcx` is one of the
  five native launchers that remain unsandboxed by design (see
  `docs/native-sandbox-research.md`); jcode gets full host access.
- You need to update jcode mid-session — ordinary launches never update the
  pinned version; use `jcx update` explicitly instead.
- You need native model credentials rather than the local proxy; no API key
  is written, and the managed config always targets `copilot-proxy-rs`.

## Workflow Notes

- Bare `jcx`, `jcx default`, and `jcx run "..."` are equivalent entry points.
- Every launch sets `JCODE_NO_TELEMETRY=1` and passes `--no-update` before
  caller arguments; explicit jcode CLI flags can still override other
  launcher defaults.
- `doctor` and every launch verify proxy health and confirm `gpt-5.6-sol` is
  advertised; launches also restore the managed `config.toml` automatically
  if it is missing or has drifted.
- Setup seeds jcode's first-run threshold and launches repair a lowered
  onboarding counter, so guided onboarding hints do not reappear on later
  runs while other setup preferences are preserved.

## Gotchas

- `trx`'s Herdr compatibility ledger marks `jcx`/`default` as `known-issue:
  A`: an agent-detection timeout (300s) can occur with no pane ever detected
  when delegated through Herdr — this is a Herdr-side detection gap, not
  necessarily a jcode failure.
- `jcx setup` resolves and pins the exact jcode version eligible under `mise`
  policy; ordinary launches never change that pin, so a stale version stays
  in place until `jcx update` is run deliberately.
