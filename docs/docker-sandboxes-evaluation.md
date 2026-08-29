# Docker Sandboxes (`sbx`) — evaluation and decision

Status: **Not adopted. Trellage Sandbox stays on hardened Docker containers.** The blocking defect
is template provenance, not product maturity, so `sbx` reaching 1.0 or GA is explicitly *not* a
revisit trigger on its own. Recorded so the finding is not re-discovered, in the same spirit as
[`native-sandbox-research.md`](native-sandbox-research.md), which records the parallel decision to
forego clawk.

Evaluated 2026-08-26 against `sbx` 0.39.0 (released 2026-08-19) and Trellage at `24ac8d2`.
Trellage later moved normal development profiles to floating stable inputs.
The pinning details below describe the evaluated commit and the retained
release-snapshot mode; the template-provenance decision is unchanged.

---

## 1. What `sbx` is

Docker Sandboxes is a standalone CLI (`sbx`) that runs a coding agent inside a per-agent microVM.
It does not require Docker Desktop or Docker Engine on the host. Announced 2026-01-30 for macOS and
Windows; broader launch around 2026-04. Docker's own documentation carries no product-wide "GA"
label, though individual integrations are marked GA. The CLI is free including for commercial use;
the paid tier is org-level governance (network/filesystem/MCP policy, audit).

Requirements: macOS 14+ **Apple silicon only**, Windows 11 with Windows Hypervisor Platform, or
Ubuntu 24.04+ with KVM and the user in the `kvm` group. Nested virtualization is required when the
host is itself a VM.

Five isolation layers, per Docker's documentation:

1. **Hypervisor/microVM** — dedicated Linux kernel per sandbox. The agent runs as a non-root user
   *with sudo*; Docker states "the hypervisor boundary is the isolation control, not in-VM privilege
   separation".
2. **Network** — per-sandbox network stack, all egress through a host-side policy proxy. Presets
   Open / Balanced (default-deny plus common dev services) / Locked Down. Direct UDP and ICMP are
   blocked; DNS resolves through a policy-enforced internal resolver. Policies are global across all
   sandboxes, current and future.
3. **Private Docker Engine** per sandbox. Caveat: local stdio MCP servers registered through the MCP
   gateway run **on the host**, outside the VM.
4. **Workspace** — the default is a read-write direct mount, with no boundary between the agent's
   edits and the host filesystem. `--clone` gives the agent a private in-VM clone and a read-only
   host repo, but protects against modification only, not inspection.
5. **Credentials** — API keys are never stored in the VM; a host-side forward proxy injects auth
   headers on outbound requests.

Customization is via **Templates** (a prebuilt image) or **Kits** (`spec.yaml` applied at runtime:
install/startup commands, files, env, `permissions.network.allow/deny`, proxy-managed credential
injection, agent instructions). Kits can be cosign-signed, and policy can require signed kits.

## 2. Decision

Do not adopt `sbx` — not as a runtime backend, not as a template target, not as a partial hedge.

## 3. Why — the blocking defect

A custom `sbx` template must be built **`FROM docker/sandbox-templates:<agent>`**
(https://docs.docker.com/ai/sandboxes/customize/templates/). That base is Docker's image, referenced
by a mutable tag Docker controls, and it ships Docker's own copy of the agent harness. Docker's docs
show only tag references for `sbx run --template`; digest references are not documented as
supported.

This is irreconcilable with Trellage's explicit release guarantees. Development profiles use
approved floating stable selectors and keep their exact resolved state in a local receipt. An
explicit release snapshot records the resolved base-image digest, exact apt package versions and
checksums, harness release, source commits, and final OCI digest. A locked build stamps
`SOURCE_DATE_EPOCH` and verifies that snapshot. Handing the image to `sbx` is not a runtime
substitution; the `FROM` direction is inverted, so Trellage's image would have to become a layer
*on top of* Docker's mutable tag. That rebases stage one, voids `lock.image.final_digest` and
`ci-verify`, and transfers harness selection to whatever Docker ships in its base image.

Kits are worse for this purpose, and Docker says so plainly: "the signature covers `spec.yaml` and
the kit's `files/` content, but not mutable dependencies such as image tags or content downloaded by
install and startup commands. Pin those dependencies by digest or checksum when they must remain
immutable." There is no lockfile, no resolver, no digest-pinning machinery. On reproducible builds —
the property Trellage is actually built around — the profile compiler is more mature than the product
under evaluation.

## 4. Supporting reasons

- **`.sbxenv.yaml` is an agent-to-host execution path by design.** Commands in it run **on the host**
  before the sandbox starts, and the file is agent-writable in the default read-write mount mode.
  This is a regression against a launcher that unsets every credential environment variable at
  startup (`prototypes/trellage/trellage:68-92`) and pipes the GitHub token over stdin into a
  noexec/nosuid/nodev tmpfs rather than into any mount, image layer, or container env (`:1445-1465`).
- **A second isolation technology.** This is the same objection already recorded against clawk in
  `native-sandbox-research.md`, and it still applies.
- **A portability regression.** The current sandbox runs against any `unix://` Docker endpoint.
  `sbx` requires Apple silicon on macOS or KVM group membership on Linux. Whether the maintainer's
  actual hosts satisfy this was never checked and remains open.
- **Version maturity is not the issue.** `sbx` answers two of the four objections raised against
  clawk — it supports ten agents out of the box (Claude Code, Codex, Copilot, Cursor, Docker Agent,
  Droid, Gemini, Kiro, OpenCode, Shell) and has official non-experimental Linux support — but the
  provenance defect above is orthogonal to the version number.

## 5. Revisit triggers

Reopen this decision if any of the following is observed. `sbx` reaching 1.0 or GA is deliberately
absent from this list.

- Docker documents **both** digest-referenced templates (`sbx run --template <repo>@sha256:…`
  accepted and honored) **and** templates built from a base other than
  `docker/sandbox-templates:<agent>`. This restores the Templates-only substitution path.
- Docker ships a **network-policy-only mode** — the host-side default-deny proxy usable against an
  ordinary Docker container, without adopting the microVM runtime. This would make vendoring the one
  genuinely superior component possible without swallowing the stack.
- Docker adds a **kit resolver and lockfile** with transitive digest pinning.
- Trellage adds a profile that executes untrusted third-party code rather than official vendor CLIs.
  The threat model grounding this decision assumes the guest is a vendor CLI, so this invalidates it
  and puts hypervisor isolation back on its own merits.
- A container-escape vulnerability affecting Trellage's specific hardened configuration
  (`--cap-drop ALL --read-only --user 10001:10001 --security-opt no-new-privileges`) is exploited in
  the wild against agent workloads.

One cheap open experiment worth running before filing this as settled: whether
`sbx run --template <repo>@sha256:…` accepts a digest at all. A negative result closes the last
theoretical integration path permanently; a positive result partially reopens the first trigger
above. Estimated at under an hour.

## 6. The finding that outlived the question

The evaluation surfaced a defect in Trellage that has nothing to do with `sbx`:

**Trellage has no egress filtering.** `--network` is either the stock `bridge` or the external
`copilot-proxy-rs_default` bridge; grepping the runtime code for `iptables|nftables|egress|firewall`
returns zero hits. `copilot-proxy-rs_default` is a model-routing network, not a containment
boundary — containers on it have full outbound internet. `README.md:871` currently claims isolation
rests on "project-scoped networks and volumes, hardened containers, and loopback-only port
publication", which does not disclose this.

This is worth fixing on its own merits, and `sbx`'s hypervisor is not what fixes it. Three
constraints on any such work, recorded so they are not rediscovered:

- **Cost is weeks, not days.** A genuine containment boundary needs hostname-based allow-listing
  (CDN-fronted APIs and registries rotate IPs, so L3 CIDR rules rot silently), SNI inspection to
  enforce policy without full TLS interception, per-profile policy across the eleven profiles, and CI
  coverage requiring privileged network-namespace tests. An initial 3-5 day estimate was revised to
  2-3 weeks on those grounds. A cheaper stopgap (block the metadata IP, block raw non-443 egress,
  leave DNS open) is still days of work — but must be documented as a partial mitigation, never as
  "egress filtering". A half-working allow-list is worse than none, because it changes the claimed
  risk posture while remaining bypassable.
- **A proxy-based plan does not cover every profile.** `copilot-proxy-rs` lives in a separate
  repository, so extending it into an allow-listing gateway means cross-repo work and a
  version-compatibility surface between two repos. It is also the network for only three of the five
  profile groups: `packages/trellage-cli/src/application.ts:1733` places `copilot` and `pi` kinds on
  the stock `bridge`, so `copilot-hve` and `pi-oh-my-pi` would gain no egress control from it. Decide
  and document what happens to those two before designing around the proxy.
- **Some profiles need broad web access to do their job.** `claude-research`, `claude-blog`, and
  `claude-social-media` use WebSearch and WebFetch as their primary function. Default-deny may be
  structurally incompatible with them, which forces per-profile policy and enlarges the design.

**The frequency of this risk is unmeasured.** There is no record of a Trellage container ever making
an unwanted outbound connection. The case for the work rests on a zero-hit grep, not on an observed
incident. The cheap way to resolve that — and to decide L3 versus L7 on evidence rather than
argument — is to record every distinct destination hostname, resolved IP, and port leaving a running
sandbox across several days of ordinary use, covering one `copilot-proxy-rs_default` profile and one
stock-`bridge` profile, since their egress paths differ. A short, IP-stable destination list makes an
L3 allow-list sufficient; a long or churning one makes it unbuildable and sends the work to an
SNI-aware L7 proxy.

A related gap found alongside it: `prototypes/trellage/tests/host_command_contract.sh` — 4,896 lines
and 72 test functions asserting the exact docker argv, including the mount table, label set, and
network count — is not a `make test` target (`Makefile:7-8`). CI reaches only its headless subset via
`make headless-matrix`; the full suite runs only through the opt-in live `smoke.sh`. The same applies
to `image_contract.sh`, the `runtime_*_contract.sh` suites, and
`resource_cleanup_behavior_contract.sh`. Safety assertions that do not run in CI are not safety.

## 7. Recorded dissent

One line of argument did not survive into the decision above and is preserved because it may prove
correct: that egress control is an enforceable invariant or it is absent, with no middle ground that
formalizes as "mostly filtered", and that accepting a stopgap as if it discharges the obligation is a
category error — it defers it rather than discharging it. On that reading the 2-3 week L7 cost is
bounded and one-time and should be paid now rather than later with interest. If a stopgap ships and
the full boundary never follows, this dissent was right.

Related and unretracted: an L3 packet filter cannot allow-list hostnames under CDN IP churn. That
mechanism was accepted by the participants who nonetheless preferred L3 on proportionality grounds.
The preference for starting at L3 is therefore a cost judgment, not a claim that L3 is sufficient,
and should not be recorded as the latter.

## 8. Provenance of this record

Produced by a five-member `/council` deliberation (Aristotle, Ada, Feynman, Torvalds, Taleb) over
three rounds, with identities masked during cross-examination and two adversarial counterfactuals
assigned against the emerging consensus. All five members rejected adoption; three retracted their
own initial integration proposals once the template-provenance constraint in §3 was established. The
strict confidence-weighted tally was a tie between "reject and probe first" and "reject and start on
egress" — the two differ only by the sub-hour experiment in §5, not on the decision itself.

Facts in §1 were read from docs.docker.com on 2026-08-26; facts in §3, §4, and §6 were verified
against this repository at `24ac8d2`. The panel ran on a single model provider, so its unanimity is
weaker evidence than unanimity across independent providers would be.
