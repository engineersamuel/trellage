---
schemaVersion: 2
templates:
  recall-prior-context: Use jcode's semantic memory to recall prior context for {{intent}}.
  browser-driven-task: Use jcode's Firefox browser automation to complete {{intent}}.
  coordinated-swarm-delivery: |-
    Use jcode's coordinated agent swarm to deliver {{intent}} while keeping
    the final integration and verification in the main task.
---

# Native jcode (`jcode`) — `default` profile

`jcode` runs jcode directly on the host with one isolated `default` profile,
routed through keyless `copilot-proxy-rs` and defaulting to `gpt-5.6-sol` with
`medium` reasoning. See `prototypes/trellage-jcode-profiles/README.md`.

## Use This Profile When

- You want jcode's semantic memory, Firefox browser automation, persistent
  sessions, and coordinated agent swarms without managing an API key.
- You want an isolated `JCODE_HOME` so this profile's configuration,
  sessions, authentication, and memory never touch a personal `jcode`
  installation.
- You want the shared `native-common` floating skill bundle (`engineersamuel`
  wildcard, `show-me`, and manually activated `i-have-adhd`) available
  alongside jcode's own tools.

## Avoid This Profile When

- The task needs OS-level sandboxing or containment — `jcode` is one of the
  seven native launchers that remain unsandboxed by design (see
  `docs/native-sandbox-research.md`); jcode gets full host access.
- You need to update jcode mid-session — ordinary launches never update the
  pinned version; use `trx upgrade jcode default` explicitly instead.
- You need native model credentials rather than the local proxy; no API key
  is written, and the managed config always targets `copilot-proxy-rs`.

## Workflow Notes

- Use `jcx skill i-have-adhd "PROMPT"` for a one-shot request with this output
  skill. Its managed copy stays outside JCode's automatic skill discovery;
  `/i-have-adhd` is not registered in JCode. See the native JCode README for
  explicit use in an existing interactive session.

- Bare `jcode`, `trx run jcode default`, and `jcx run "..."` are equivalent entry points.
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

- `trx`'s Herdr compatibility ledger marks `jcode`/`default` as `known-issue:
  A`: an agent-detection timeout (300s) can occur with no pane ever detected
  when delegated through Herdr — this is a Herdr-side detection gap, not
  necessarily a jcode failure.
- `trx setup jcode default` resolves and pins the exact jcode version eligible under `mise`
  policy; ordinary launches never change that pin, so a stale version stays
  in place until `trx upgrade jcode default` is run deliberately.
