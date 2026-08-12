# Native launcher sandboxing — research and decisions

Status: **`cdx`/`grx` sandboxed natively; `cldx`/`cpx`/`jcx`/`omp`/`prx` remain
unsandboxed; clawk evaluated and not adopted.** Recorded so the finding is not
re-discovered.

Background: Trellage Sandbox profiles (compiled by `packages/trellage-cli`,
built and run via `trellage build`) always execute inside a locked, built
Docker container, so they are implicitly sandboxed regardless of harness
kind. Trellage Native launchers (`cdx`, `cpx`, `cldx`, `grx`, `jcx`, `omp`,
`prx`) run the underlying harness CLI directly on the host. This repo's own
guidance previously stated flatly that "Trellage Native profiles isolate
agent state but are not containers or security boundaries" — this document
records why that statement now has two exceptions (`cdx`, `grx`) and why the
other five remain unsandboxed by design rather than by oversight.

`trellage list --json-full` (Trellage Sandbox) and every native launcher's
`list --json` now carry a `sandbox: boolean` field reflecting this reality.

---

## 1. What was verified (settled facts, not just vendor docs)

Verified directly against the actual invocation code in this repo and the
locally installed CLI binaries — not just aggregator search results, which
proved unreliable for some of the Grok config claims below.

| Harness (launcher) | Native OS-level sandbox exists? | Verified invocation before this change | Verdict |
|---|---|---|---|
| Codex (`cdx`) | **Yes** — `--sandbox {read-only,workspace-write,danger-full-access}`, enforced by Seatbelt (macOS) / Landlock+bubblewrap (Linux). Confirmed via installed `codex-cli 0.147.0 --help` and https://developers.openai.com/codex/agent-approvals-security. | `cdx` passed `--dangerously-bypass-approvals-and-sandbox` (`prototypes/trellage-codex-profiles/bin/cdx`) — sandbox was actively disabled | **Now sandboxed** (this change) |
| Grok (`grx`) | **Yes** — `--sandbox <PROFILE>` (`workspace`, `devbox`, `read-only`, `strict`), enforced by Landlock (Linux, network) / Seatbelt (macOS, filesystem). Confirmed via installed `grok 1.0.0 (stable) --help` and https://docs.x.ai/build/features/sandbox. | `grx` passed no sandbox-related flag at all | **Now sandboxed** (this change) |
| Claude Code (`cldx`) | **Partial** — `/sandbox` mode exists (bubblewrap/Seatbelt-backed Bash sandboxing), but requires enabling per-session and doesn't compose with `--dangerously-skip-permissions` the way `cldx` invokes Claude today | `cldx` invokes `claude --dangerously-skip-permissions --permission-mode bypassPermissions` (full bypass) | Not flipped — see §3 |
| Copilot CLI (`cpx`) | **No** — no built-in OS-level sandbox (seatbelt/seccomp/landlock/container); only a trust-directory + tool-approval prompt layer. Real isolation requires an external container. | No sandbox flags exist to pass | Not flippable natively — see §3 |
| jcode (`jcx`), oh-my-pi (`omp`), Prime (`prx`) | No evidence of built-in OS-level sandboxing found in vendor docs or this repo's invocation code | No sandbox flags | Treated as unsandboxed/unresearched-capability |

## 2. Codex and Grok: what changed

Per explicit product direction: **network access stays allowed**, and **all
permissions are granted within the sandbox boundary** (no per-action approval
prompts) — the filesystem/network sandbox scope is the security control here,
not approval fatigue.

- **`cdx`**: replaced `--dangerously-bypass-approvals-and-sandbox` with
  `--sandbox workspace-write -c sandbox_workspace_write.network_access=true --ask-for-approval never`.
  `workspace-write` restricts writes to the workspace + temp dirs (reads
  elsewhere are still permitted by this Codex sandbox mode); the `-c`
  override re-enables network access, which `workspace-write` blocks by
  default; `--ask-for-approval never` removes approval prompts.
- **`grx`**: added `--sandbox workspace` alongside the existing
  `--permission-mode bypassPermissions --always-approve`. Per xAI's docs,
  `workspace` is the only built-in profile that keeps network access
  allowed while restricting writes to the CWD (+ `~/.grok/` for session
  state, + temp). Permission mode and sandbox are independent layers in
  Grok's model ("permissions gate whether a tool call runs; the sandbox
  limits what an approved call can do"), so the existing bypass/auto-approve
  flags are unaffected by adding the sandbox restriction.

Both launchers' `list --json` now report `sandbox: true`.

## 3. clawk fit-check for the remaining five launchers

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
- **`cpx` (Copilot), `jcx` (jcode), `omp` (oh-my-pi), `prx` (Prime)** are not
  first-class clawk runners (only `claude`, `codex`, `opencode`, `shell`
  are). Integration would go through the generic `shell` runner, losing
  clawk's auth/state auto-wiring for these harnesses and effectively
  hand-rolling per-harness support.
- Costs that don't fit well here: clawk is **pre-1.0** ("expect breaking
  changes... things can and will break" — its own README), macOS-Apple-
  Silicon-first with Linux support explicitly experimental (this repo's CI
  and mixed dev hosts aren't guaranteed to have nested-virt/KVM), and would
  introduce a *second* isolation technology (VM) alongside the existing
  Docker-based Trellage Sandbox — for 4 of the 5 remaining harnesses it
  doesn't even have first-class support.

**Decision: forego clawk for now.** It only cleanly fits one harness
(`cldx`), lacks first-class support for the other four, and is
pre-1.0/platform-limited. Rely on the existing **Trellage Sandbox (Docker
container) harness** for real isolation when `cldx`/`cpx`/`jcx`/`omp`/`prx`
need it — `sandbox: false` is reported for all five in native `list --json`.
A future revisit of clawk-for-`cldx` is reasonable once clawk reaches 1.0 and
gets non-experimental Linux support, but is not scheduled work today.

## 4. Project guide update

The statement "Trellage Native profiles isolate agent state but are not
containers or security boundaries" (previously universal) now has two
exceptions: `cdx` and `grx` enable a real native OS-level sandbox as
described above. `cldx`, `cpx`, `jcx`, `omp`, and `prx` remain exactly as
that statement describes.
