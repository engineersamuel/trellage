---
schemaVersion: 2
templates:
  persistent-exploratory-investigation: |-
    Use persistent IPython/RLM subagents to investigate {{intent}} across
    turns, retain the evidence, and report the resulting conclusion.
  ask-user-clarification: "{{intent}}"
  ipython-rlm-analysis: |-
    Use Prime's persistent IPython/RLM subagents to analyze {{intent}}
    across turns and retain the findings in the resident session.
---

# Native Prime Agent (`prime`) — `default` profile

`prime` runs Prime Agent directly on the host with an isolated profile, keyless
`copilot-proxy-rs` (Anthropic Messages API) pinned to `claude-opus-5.5`,
persistent IPython/RLM subagents, daemon sessions, and the managed `ask_user`
extension. See `prototypes/trellage-prime-profiles/README.md`.

## Use This Profile When

- You want Prime's persistent IPython/RLM subagents and a resident daemon
  session for long-running or exploratory work.
- You want the managed `ask_user` extension
  (`am-will/prime-agent-plugins`, only that one extension, not the full
  plugin collection) auto-discovered from `extensions/*.ts`.
- You want an isolated profile home (`PRIME_AGENT_CODING_AGENT_DIR`) with its
  own kernel venv, so Prime never writes a half-broken kernel under
  `~/.prime/agent/`.

## Avoid This Profile When

- The host has no network path to a PyPI simple index for kernel bootstrap;
  `prime` falls back from `files.pythonhosted.org` to
  `https://mirrors.aliyun.com/pypi/simple`, but that is the only documented
  fallback.
- The task needs OS-level sandboxing or containment — `prime` is one of the
  seven native launchers that remain unsandboxed by design (see
  `docs/native-sandbox-research.md`); Prime Agent gets full host access.
- One-shot automation is run repeatedly without ever calling `trx shutdown prime default`;
  resident background workers can accumulate on the pinned daemon socket.

## Workflow Notes

- Launch sets `PRIME_AGENT_KERNEL_PYTHON`/`PRIME_AGENT_KERNEL_VENV` and pins
  `--daemon-socket` to the profile's own socket path so resident workers
  inherit the managed kernel paths rather than the client environment.
- Managed `--provider copilot-proxy-rs`, `--model`, `--offline`, and
  `--autonomous` flags are applied before caller arguments; pass `--model
  MODEL` to select another model advertised by the proxy.
- No host Anthropic, OpenAI, or Copilot credential variables are forwarded;
  `ANTHROPIC_*`, `OPENAI_API_KEY`, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and
  `GITHUB_TOKEN` are unset at launch.
- Prefer `-p`/`--print` for one-shot smoke tests instead of an interactive
  session.

## Gotchas

- `trx`'s Herdr compatibility ledger marks `prime`/`default` as `known-issue:
  E`: `"agent_not_ready: not an active named agent"`, with the pane never
  reaching a ready state — check for this before assuming a hang is a Prime
  defect versus a Herdr detection gap.
- The launcher is named `prime` rather than `pax` specifically to avoid
  colliding with macOS `/bin/pax`; `trx` refuses any `prime` binary that does
  not resolve to the owned runtime under
  `~/.local/share/trellage/prx/bin/prx`.
- Long-running sessions can leave Prime background workers on the profile
  daemon socket; run `trx shutdown prime default` to stop them explicitly.
