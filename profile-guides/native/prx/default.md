---
schemaVersion: 1
capabilities:
  - persistent-ipython-rlm-subagents
  - daemon-session-persistence
  - managed-ask-user-extension
  - keyless-proxy-model-routing
  - isolated-prime-profile-home
bestFor:
  - Long-running or exploratory tasks that benefit from Prime's persistent IPython/RLM subagents and a resident daemon session
  - Work where the agent needs to ask clarifying questions through the managed ask_user extension instead of guessing
  - Tasks that should route through proxy-backed claude-opus-5 without any host Anthropic/OpenAI/Copilot credentials present
avoidFor:
  - Hosts without network access to a PyPI simple index for kernel bootstrap; files.pythonhosted.org unreachable falls back to a mirror, but full offline bootstrap is not supported
  - One-shot automation that assumes background workers exit with the process; long sessions can leave resident workers on the profile daemon socket until prx shutdown runs
  - Tasks that need OS-level sandboxing or containment; prx adds no containment and Prime Agent runs with all host access available to the process
prerequisites:
  - id: mise
    description: mise installed on the host; setup resolves and pins the eligible Prime Agent release, and bootstraps uv if missing (mise use -g uv).
  - id: node-npm
    description: Node.js 22+ and npm on the host for the managed npm-prefixed Prime Agent install.
  - id: uv
    description: uv available to bootstrap the isolated Prime IPython kernel venv.
  - id: proxy-health
    description: copilot-proxy-rs listening on http://127.0.0.1:8080 (Anthropic Messages API) and advertising claude-opus-5.
  - id: cli-tools
    description: curl and jq available on the host for setup, doctor, and update checks.
workflows:
  - id: launch-smoke-test
    description: Confirm the isolated profile launches, the proxy is healthy, and claude-opus-5 responds before starting real work.
    examples:
      - Reply exactly PRX_OK
      - Confirm the proxy is healthy and claude-opus-5 is advertised
    promptTemplate: |
      {{intent}}
  - id: ask-user-clarification
    description: Rely on the managed ask_user extension so the agent pauses to ask a clarifying question instead of guessing on ambiguous instructions.
    examples:
      - This task is ambiguous; ask me before choosing an approach
    promptTemplate: |
      {{intent}}
  - id: ipython-rlm-analysis
    description: Use Prime's persistent IPython/RLM subagents for exploratory data or code analysis that benefits from a resident kernel across turns.
    examples:
      - Load this dataset into the kernel and iteratively explore it across several turns
    promptTemplate: |
      {{intent}}
---

# Native Prime Agent (`prx`) — `default` profile

`prx` runs Prime Agent directly on the host with an isolated profile, keyless
`copilot-proxy-rs` (Anthropic Messages API) pinned to `claude-opus-5`,
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
  `prx` falls back from `files.pythonhosted.org` to
  `https://mirrors.aliyun.com/pypi/simple`, but that is the only documented
  fallback.
- The task needs OS-level sandboxing or containment — `prx` is one of the
  five native launchers that remain unsandboxed by design (see
  `docs/native-sandbox-research.md`); Prime Agent gets full host access.
- One-shot automation is run repeatedly without ever calling `prx shutdown`;
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

- `trx`'s Herdr compatibility ledger marks `prx`/`default` as `known-issue:
  E`: `"agent_not_ready: not an active named agent"`, with the pane never
  reaching a ready state — check for this before assuming a hang is a Prime
  defect versus a Herdr detection gap.
- The launcher is named `prx` rather than `pax` specifically to avoid
  colliding with macOS `/bin/pax`; `trx` refuses any `prx` binary that does
  not resolve to the owned runtime under
  `~/.local/share/trellage/prx/bin/prx`.
- Long-running sessions can leave Prime background workers on the profile
  daemon socket; run `prx shutdown` to stop them explicitly.
