# Native launcher sandboxing — research and decisions

Status: **composed Grok is sandboxed natively; `cdx` uses Full Access by default.
`cldx`/`cpx`/`fmx`/`jcx`/`omp`/`picx`/`prx` remain unsandboxed; clawk
evaluated and not adopted.** The original Codex sandbox decision is retained
below as history, not as the current launch policy.

Background: Trellage Sandbox profiles (compiled by `packages/trellage-cli`,
built and run via `trellage build`) always execute inside a resolved, built
Docker container, so they are implicitly sandboxed regardless of harness kind.
Trellage Native launchers (`cdx`, `cpx`, `cldx`, `fmx`, `jcx`, `omp`,
`picx`, `prx`) run the underlying harness CLI directly on the host. This
repo's own guidance previously stated flatly that "Trellage Native profiles isolate
agent state but are not containers or security boundaries". The original
sandbox rollout made two exceptions (`cdx`, Grok). Codex now defaults to Full
Access at the user's request, leaving Grok as the only native sandbox exception.

`trellage list --json-full` (Trellage Sandbox) and every native launcher's
`list --json` now carry a `sandbox: boolean` field reflecting this reality.

---

## 1. What was verified during the original sandbox rollout

Verified directly against the actual invocation code in this repo and the
locally installed CLI binaries — not just aggregator search results, which
proved unreliable for some of the Grok config claims below.

| Harness (launcher) | Native OS-level sandbox exists? | Invocation before the original rollout | Decision |
|---|---|---|---|
| Codex (`cdx`) | **Yes** — `--sandbox {read-only,workspace-write,danger-full-access}`, enforced by Seatbelt (macOS) / Landlock+bubblewrap (Linux). Confirmed via installed `codex-cli 0.147.0 --help` and https://developers.openai.com/codex/agent-approvals-security. | `cdx` passed `--dangerously-bypass-approvals-and-sandbox` (`prototypes/trellage-codex-profiles/bin/cdx`) — sandbox was actively disabled | Initially enabled; superseded by Full Access (section 2) |
| Grok (`trx run grok`) | **Yes** — `--sandbox <PROFILE>` (`workspace`, `devbox`, `read-only`, `strict`), enforced by Landlock (Linux, network) / Seatbelt (macOS, filesystem). Confirmed against installed Grok CLI help and https://docs.x.ai/build/features/sandbox. | The retired `grx` launcher originally passed no sandbox-related flag | Enabled in the composed adapter |
| Claude Code (`cldx`) | **Partial** — `/sandbox` mode exists (bubblewrap/Seatbelt-backed Bash sandboxing), but requires enabling per-session and doesn't compose with `--dangerously-skip-permissions` the way `cldx` invokes Claude today | `cldx` invokes `claude --dangerously-skip-permissions --permission-mode bypassPermissions` (full bypass) | Not flipped — see §3 |
| Copilot CLI (`cpx`) | **No** — no built-in OS-level sandbox (seatbelt/seccomp/landlock/container); only a trust-directory + tool-approval prompt layer. Real isolation requires an external container. | No sandbox flags exist to pass | Not flippable natively — see §3 |
| jcode (`jcx`), oh-my-pi (`omp`), Pi (`picx`), Prime (`prx`), Firstmate (`fmx`) | No evidence of built-in OS-level sandboxing found in vendor docs or this repo's invocation code | No sandbox flags | Treated as unsandboxed/unresearched-capability |

## 2. Current defaults and the prior Codex policy

Network access stays allowed for both launchers, but only Grok retains its
native sandbox by default.

- **`cdx`**, including `pstack`, `superpowers`, and `youtube`: uses
  `--dangerously-bypass-approvals-and-sandbox`. This selects Full Access
  (`approval_policy = "never"`, `sandbox_mode = "danger-full-access"`) for
  both authentication paths and both interactive and non-interactive launches.
  Commands run with the host account's permissions, without command approval
  prompts or a Codex OS sandbox. Profile-state isolation is not a security
  boundary. Hook trust remains a separate control.
- **Composed Grok**: uses `--sandbox workspace` alongside
  `--permission-mode bypassPermissions --always-approve`. Per xAI's docs,
  `workspace` is the only built-in profile that keeps network access
  allowed while restricting writes to the CWD (+ `~/.grok/` for session
  state, + temp). Permission mode and sandbox are independent layers in
  Grok's model ("permissions gate whether a tool call runs; the sandbox
  limits what an approved call can do"), so the existing bypass/auto-approve
  flags are unaffected by adding the sandbox restriction.

`cdx list --json` reports `sandbox: false`; `trx run grok --dry-run` reports
the composed Grok sandbox policy. Use Trellage Sandbox when Codex commands require isolation.
Container and comparison Codex sessions keep their Docker boundary. Dedicated
read-only Codex verification probes and the Graph of Loops reviewer retain
their separate read-only policies.

**Previous Codex default (superseded):** `cdx` used
`--sandbox workspace-write -c sandbox_workspace_write.network_access=true`.
Interactive launches used `--ask-for-approval on-request` so the user could
approve protected Git metadata writes; non-interactive launches used
`--ask-for-approval never`. That policy restricted writes to the workspace and
temporary directories. It was not Full Access.

## 3. clawk fit-check for the remaining unsandboxed launchers

Evaluated [clawk](https://github.com/clawkwork/clawk): a per-project
disposable **microVM** (Apple Virtualization.framework on macOS; firecracker
on Linux, explicitly "currently experimental" per its own README), with the
repo virtio-fs-mounted in, a DNS-aware outbound network allow-list enforced
*below* the guest kernel, and nothing else host-mounted. Inside the VM it
deliberately runs `claude --dangerously-skip-permissions` and
`codex --dangerously-bypass-approvals-and-sandbox` — full process-level
bypass is fine there because the VM + network boundary is the actual sandbox,
not the process flags.

**Fit assessment:**

- **`cldx` (Claude)** is the one harness where clawk fits cleanly: `cldx`
  already invokes Claude exactly the way clawk expects to wrap it — no
  conflict, unlike trying to reconcile Claude's own `/sandbox` mode with the
  current bypass invocation.
- **`cpx` (Copilot), `jcx` (jcode), `omp` (oh-my-pi), `picx` (Pi), `prx` (Prime)** are not
  first-class clawk runners (only `claude`, `codex`, `opencode`, `shell`
  are). Integration would go through the generic `shell` runner, losing
  clawk's auth/state auto-wiring for these harnesses and effectively
  hand-rolling per-harness support.
- **`fmx` (Firstmate)** depends on host worktrees plus tmux or Herdr pane
  control. Moving that orchestration into a microVM would be a separate
  contained harness design, not a drop-in Native launcher wrapper.
- Costs that don't fit well here: clawk is **pre-1.0** ("expect breaking
  changes... things can and will break" — its own README), macOS-Apple-
  Silicon-first with Linux support explicitly experimental (this repo's CI
  and mixed dev hosts aren't guaranteed to have nested-virt/KVM), and would
  introduce a *second* isolation technology (VM) alongside the existing
  Docker-based Trellage Sandbox — for 4 of the 5 remaining harnesses it
  doesn't even have first-class support.

**Decision: forego clawk for now.** It only cleanly fits one harness
(`cldx`), lacks first-class support for the other five single-agent
launchers, does not preserve Firstmate's host orchestration model, and is
pre-1.0/platform-limited. Rely on the existing **Trellage Sandbox (Docker
container) harness** for real isolation when
`cldx`/`cpx`/`fmx`/`jcx`/`omp`/`picx`/`prx` need it — `sandbox: false` is
reported for all seven in native `list --json`.
A future revisit of clawk-for-`cldx` is reasonable once clawk reaches 1.0 and
gets non-experimental Linux support, but is not scheduled work today.

## 4. Project guide update

The statement "Trellage Native profiles isolate agent state but are not
containers or security boundaries" now has one exception: composed Grok enables its
native OS-level sandbox. `cdx` uses Full Access by default; `cldx`, `cpx`,
`jcx`, `omp`, `picx`, `prx`, and `fmx` remain unsandboxed as before.

## 5. Grok GitHub authentication

The composed Grok adapter forwards the host's active `github.com` credential by default, using
`GH_TOKEN` only at the final process boundary. Existing `GH_TOKEN` and
`GITHUB_TOKEN` take precedence. `GRX_GH_AUTH_BRIDGE=0` disables automatic
retrieval. Set `TRELLAGE_GROK_GH_AUTH_BRIDGE=0` to disable retrieval.

The bridge changes credential availability, not sandbox access. It adds no
keychain exception, writable Git metadata path, SSH override, or sandbox flag,
and preserves user shell environment filters. The launcher creates no
credential file or secret-bearing command argument. Grok and its children can
use the forwarded credential; automatic storage by an installed shell backend
has not been independently verified.

Host success with sandbox HTTP 401 is consistent with unavailable keychain
access, but does not alone prove that cause. Check the effective `gh`
configuration and API identity without printing credentials. An SSH key
selecting another account and a denied `index.lock` write are separate issues.

## 6. Runtime composition discovery gate

Runtime composition needs **configuration isolation**, not an OS sandbox:
only selected profile capabilities may be discovered automatically, while
repository engineering instructions and mandatory organization policy remain.
A separate native configuration directory is not sufficient evidence.

The initial discovery probes found these limits:

| Runtime | Observation | Gate state |
| --- | --- | --- |
| Copilot CLI `1.0.93-1` | `COPILOT_HOME` contains the selected skill, but `skill list --json` also enables an unselected repository skill. Disabling the literal `*` name does not disable all skills. A newly added repository skill is enabled on the next process start. | Selected-only discovery not established |
| Codex `0.160.1` | `skills/list` still enables unselected repository skills with `skip_host_skill_discovery` enabled, including after `forceReload`. `skills/extraRoots/set` adds roots rather than replacing them. | Selected-only discovery not established |
| Pi `0.80.6` | The resource loader with `noSkills` and explicit additional paths loads only the selected sentinel and retains repository `AGENTS.md`, including after reload. | Skill-loader result only; full startup, plugin, child-process, and resume isolation not established |
| Claude Code | The existing launcher performs preparation before forwarding arguments. No clean, model-free full discovery proof has been completed. | Not established |

These are discovery observations, not model-turn or full isolation proofs.
In Codex, the experimental skip-host feature is conditional on registered
contributors. Its upstream
[host-provider test](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/tests/suite/skills_extension.rs)
explicitly exercises a host provider overriding that opt-out. The existence
of the flag alone is not an isolation guarantee.

Repeat the two blocking discovery probes with installed binaries:

```bash
bun --no-install --no-env-file --config=./bunfig.toml scripts/probe-native-isolation.ts copilot /absolute/path/to/copilot
bun --no-install --no-env-file --config=./bunfig.toml scripts/probe-native-isolation.ts codex /absolute/path/to/codex
```

The probe uses temporary homes and a temporary Git repository, passes no
credentials, disables automatic updates and telemetry where supported, and
makes no model calls. It removes its fixtures when finished. JSON output
includes the runtime version, selected and unselected sentinel names, and
per-stage results. Exit `0` means this narrow discovery check passed; `1`
means it did not; `2` means the probe itself could not run.

Do not add this installed-binary diagnostic to the default static suite or
treat a mocked launcher as an isolation proof. Copilot SDK session controls
do not by themselves prove that the interactive Native CLI obeys the same
settings. Keep the existing launchers and session data intact until every
required adapter passes the complete contract. Do not substitute a one-time
skill-name denylist, weaken the contract, or silently drop a required harness.

### Implementation status

`trx run <harness> [<profile>...]` now composes content-addressed generations
(`packages/trellage-runtime/src/native-run`). Pi launches by default because its
selected-only isolation is proven. Copilot, Claude and Codex are unproven and
launch by default; `--require-proven-isolation` refuses them. Harness arguments such as
`--resume` pass after `--`; sessions persist per composition. Plugins and
auth setup for the unproven harnesses remain open; legacy launchers are untouched.
