# Plan 002: Replace named Native launchers with harness-based trx commands

Status: IMPLEMENTED — verification limitations recorded below. Priority P1. Effort L (multiple increments). Risk HIGH (runtime,
authentication, sessions, and fleet lifecycle). Category: migration.
Planned against HEAD `20230dd`, 2026-10-07, **including the existing uncommitted
and untracked composition work**. The planning evidence below is historical;
implementation is now present; verification results are recorded below.

## Implementation checkpoint

All nine launcher families now have canonical routes. OMP's native Copilot
profile is `trx run omp default`; its former Qwen route remains
`trx run omp local`. Installers register owned private backends and retire only
owned public aliases, preserving existing runtime and session state.

`config.toml` supplies skill policy for Native, Sandbox and comparison builds.
Unpinned sources attempt refresh on every profile load; pins stay stable until
explicitly changed. Failed refreshes may reuse only validated matching content
with a warning. `trx skills update --upgrade-pins` persists pin upgrades
atomically; cache receipts are derived data.

Persistent native backends admit one composed session per harness/preset to
protect the running session's selected skill view. Different presets remain
independent. Firstmate retains its existing per-instance fleet locks.

Migration contracts pass across full suites and focused reruns, including all
35 Firstmate instance cases. The full repository suite is not green: the host
Herdr missing-socket timing check takes 12 seconds against a strict limit below
10 seconds. The installed-host profile matrix also still targets the old `trx`;
the candidate fixture matrix passes. Detailed evidence is recorded in
`.superpowers/sdd/002-unify-native-launchers/progress.md`.
No commits, host launcher installation, live model probes or Azure runs have
been performed for this implementation.

## Inventory first

Nine named launchers remain, covering 20 catalog profile pairs. Grok is already
migrated to `trx run grok PROFILE` (confirmed by the user); its legacy source
deletions are staged in this worktree. Proposed commands
below are destinations, not claims of current behavior equivalence.

| Launcher | Catalog profiles | Proposed launch destination | Current migration gap |
| --- | --- | --- | --- |
| `agx` | `trellage-azure` | `trx run agency azure` | No Agency adapter; expose the preset as `azure`, preserving Agency and Azure MCP restrictions. |
| `cdx` | `pstack`, `superpowers`, `youtube` | `trx run codex PROFILE` | Adapter exists; plugin workflows, common skills, environment and defaults need parity. |
| `cldx` | `default`, `office`, `office-charts` | `trx run claude PROFILE` | Adapter exists; default/plan model policy and document plugins need parity. |
| `cpx` | `awesome`, `compound-engineering`, `hve`, `plannotator`, `superpowers`, `tufte-vdqi` | `trx run copilot PROFILE` | Adapter exists; full plugins, agents, hooks and Guide HVE workflows need parity. |
| `fmx` | `default`, `pstack-workers` | `trx run firstmate PROFILE` | No adapter; pinned overlay, fleet instances and orchestration services required. |
| `jcx` | `default` | `trx run jcode default` | No adapter; managed runtime, JCode configuration and manual skills required. |
| `omp` | `copilot`, `local` | `trx run omp default` | Oh My Pi is a Pi distribution; add its `omp` adapter and `default` preset, accounting for both legacy provider configurations. |
| `picx` | `default` | `trx run pi default` | Pi adapter exists but replaces the legacy ten-extension set with a different workflow. |
| `prx` | `default` | `trx run prime default` | No adapter; managed Python kernel, daemon and shutdown lifecycle required. |
| `grx` (already migrated) | Historical: `superpowers` | `trx run grok PROFILE` | Complete per user confirmation; retain regression coverage, not another migration phase. |

Use `agency` and `omp` as canonical IDs in the new registry; existing
catalog/TUI identifiers differ (`agency`, `agency-copilot`, `omp`, `oh-my-pi`).
Normalize once at the compatibility boundary. Oh My Pi is a Pi distribution:
reuse shared Pi behavior where compatible while retaining its own `omp` runtime
and distribution-specific capabilities. Agency remains distinct from plain
Copilot. Expose Agency's old `trellage-azure` preset as `azure`; its internal
Agency profile/config name may remain `trellage-azure` where required.
OMP's public entry is `omp default`; the old `copilot` and `local` entries are
migration inputs, not required new public profile names. Record their provider,
authentication and state disposition explicitly without silently discarding one.
**Resolved by user:** `trx run omp default` uses native GitHub Copilot by
default. Bind it to the legacy `copilot` provider configuration and owned state
(`~/.omp/profiles/trellage-copilot-native`), preserving its authentication order
and discovered model catalog. Missing Copilot authentication must produce an
actionable error, never automatic fallback to local Qwen or the composed Pi proxy.
This intentionally changes the default from legacy bare `omp`, which used local
Qwen; document the change in migration help. Preserve the old local home
(`~/.omp/profiles/trellage-qwen-local`) separately, without importing its credentials
or sessions into `default`. The explicit local-provider access route remains an
implementation design item in the parity manifest; choosing a Copilot default
does not authorize deleting local state or silently retiring local access.
Preserve `tufte-vdqi`; the example config's `tufte`
is not a complete catalog migration.

## What this worktree already provides

- New `packages/trellage-runtime/src/native-config.ts` parses Native sources,
  profiles and instructions alongside environment configuration.
- New `packages/trellage-runtime/src/native-run/` provides source resolution,
  content-addressed generations, five adapters, launch argument translation,
  leases, selection history, models and composition-owned persistent state.
- New `packages/trellage-launcher/src/run-select-*` provides the interactive
  `trx run` selector. The shell router dispatches supported composed harnesses
  before discovering all legacy launchers (`prototypes/trellage-router/bin/trx:994`).
- Grok is already migrated to `trx run grok PROFILE`. Legacy launcher
  source/catalog/install/uninstall and guide content are staged for removal;
  downstream lists, rebuilds and Azure acceptance were adjusted.
- Only Pi advertises proven selected-skill isolation. Copilot, Claude, Codex
  and Grok remain explicitly unproven; Grok still enables its OS sandbox.
- Other worktree changes include source-runtime readiness, environment-reader
  sharing, Sandbox runtime changes and Guide UI changes. They are not all
  launcher migration work and must not be bundled into deletion mechanically.

## Resolved skill policy: config.toml is the source of truth

The user explicitly replaces the former `skills.json`/mandatory implicit bundle
policy: consolidate skill sources, version selectors, selections and profile
defaults into `config.toml`. Update AGENTS.md, docs and contracts in the
implementation; the old policy conflict is resolved, not a remaining approval.
This planning turn does not edit those implementation files.

- One effective TOML configuration owns skill intent. Retire `skills.json` as a
  separately maintained source of authority. Migrate its sources, selections,
  exclusions, required-skill validation, wildcard/executable permissions and
  manual-invocation metadata without losing them in a format-only conversion.
- Consolidation includes Native, Sandbox and comparison skill consumers. Reuse
  a shared resolver/cache, with one comparison snapshot per build operation.
  Runtime receipts and generated build snapshots record resolved commits; they
  are evidence/cache, not another editable source of desired versions.
- Ship a complete starter TOML and initialize it without manual copying. Do not
  overwrite an existing config or its environment settings. Existing common
  content becomes explicit TOML profiles/defaults, not an invisible extra bundle.
  `--no-always` skips configured always-on profiles. Skill-level manual invocation
  metadata and JCode's private skill placement still apply when those skills are
  selected; an always-on profile does not make every contained skill automatic.

### Version and refresh contract

| Source selection | When a profile loads | Explicit maintenance |
| --- | --- | --- |
| Exact commit | Reuse verified content for that commit; fetch that exact commit if absent | Upgrade only through a deliberate pin-change operation |
| Exact tag | Resolve and record its commit; reuse that binding, never silently follow a moved tag | Upgrade by selecting a new tag or an explicit replacement commit |
| No tag or commit | Attempt to resolve the latest default-branch commit on every load, then fetch/validate if changed | `trx skills update` also refreshes its cache |

Remove the current 300-second source TTL from profile-loading semantics. Resolve
each selected source once per load (deduplicate stacked profiles); check again
on the next load even if seconds apart. "Latest" means default-branch HEAD,
not an inferred release tag. Profile loading means launch preparation, including
resume and the existing materializing `--dry-run`; merely listing catalog choices
or moving through selector options must not fetch. Check again on a subsequent
launch, not during a running conversation. Pinning applies to source versions,
not generated content digests or harness executable versions.

Recommended failure policy: if an unpinned refresh fails, report it and use only
a validated last-good cache; without one, stop. Report the resolved revision and
fallback status. Never publish partially fetched/invalid content. Pinned sources
never fall back to a different revision. Preserve prior generations used by
running sessions. This keeps the user's "try to update every load" intent while
supporting offline reuse; a successful launch is not proof a refresh succeeded.

### trx skills update

Recommended command contract (new switches are proposed, not implemented):

- `trx skills update`: refresh all configured unpinned sources, validate/warm
  pinned caches at their exact revisions, and report results. Do not silently
  edit pins. Fail the maintenance command when requested refresh work fails,
  while preserving usable prior caches.
- `trx skills update --check`: report available unpinned changes and candidate
  pin upgrades without changing config or active bindings.
- `trx skills update --upgrade-pins`: deliberately upgrade pins as well as
  refreshing floating sources, persisting the concrete replacements in TOML.
  Commit pins can advance to default-branch HEAD while remaining commit pins.
  For tag pins, use a determinable stable release/tag ordering; if ambiguous,
  require an explicit target rather than guessing. Never convert a pin to
  floating implicitly. Report old/new selectors and resolved commits.

Fetch and validate replacement content before atomically editing pin fields.
Preserve comments, unrelated config, file permissions and concurrent user edits;
abort on a changed config rather than overwriting it. A failed upgrade leaves
the configured pin and published cache intact. Explicit new-target syntax and
source scoping should be settled in the implementation ticket, not guessed by
the executor. Shared source pins affect every profile referencing that source;
show those affected profiles in check/update output.

## Review: migration requirements

No separate originating PRD was supplied. This review uses the requested complete
migration and existing catalog contracts; gaps below are removal blockers, not
claims that the current incremental work promised completion.

- `native-run/adapters.ts:663` registers only Pi, Copilot, Claude, Codex and Grok.
  Five launcher families therefore have no composed implementation.
- `native-run/compose.ts:129` rejects plugins for the selected harness. The sample
  config explicitly contains skills only; names matching old profiles do not
  preserve agents, hooks, MCP servers or full plugin contents.
- `native-config.ts:75` has no launch-preset/provider/orchestration contract.
  OMP provider choices and Firstmate worker policy are not merely skill bundles.
- `guide-launch.ts:394`, `:593`, `:607`, `:662` and `admin-model.ts:32` key behavior
  off launcher aliases. `trellage-guide-core/src/index.ts:168` also binds goal
  controllers to aliases. Router list/admin/guide still discover legacy binaries.
- New state links preserve conversations across *new composition generations*;
  they do not import old profile homes. An existing user's resume continuity
  must be tested separately. No installed old-wrapper cleanup was found in the
  router installer or rebuild script; deleting tracked files cannot remove it.
- Firstmate and Prime have non-launch lifecycle APIs. `trx run` alone is not a
  replacement for them. Firstmate must retain explicit setup, instance-bound
  approvals, ownership, receipts and idle-fleet coordination.

## Target contract

Public launching: `trx run HARNESS PROFILE [ADDITIONAL_PROFILE...] [OPTIONS] -- ARGS`.
Keep zero-profile runs and the selector where already supported. Ship catalog
profiles as built-ins; normal use must not require copying an example TOML file.
Merge user additions without overwriting their existing environment configuration.

Separate a harness-specific launch preset from additive skills/instructions.
Conflicting provider settings must fail before launch; OMP exposes `default`
rather than requiring the legacy `local`/`copilot` profile split. Additive profile
order must not change semantics. Keep existing names
scoped by harness, so unrelated `default` presets do not collide.

Lifecycle operations need destinations, but command consolidation does not
require designing a new management CLI in advance. Reuse `trx list`,
`trx inventory`, `trx admin`, `trx skills update` and `trx upgrade` first.
Extend `trx upgrade` for harness-scoped maintenance rather than introducing a
competing `trx update` command. The following is an operation coverage checklist;
new spellings are provisional until that family's vertical slice needs them:

```text
trx list [--json]
trx setup HARNESS [PROFILE]
trx doctor HARNESS [PROFILE]
trx inventory HARNESS PROFILE --json
trx repair HARNESS [PROFILE]
trx upgrade HARNESS [PROFILE] [--check]
trx harness-version HARNESS [--json]
trx skills update
trx skill jcode i-have-adhd PROMPT
trx instances firstmate ACTION ...
trx prepare firstmate PROFILE ...
trx submit firstmate PROFILE ...
trx receipt firstmate PROFILE ...
trx shutdown prime PROFILE
```

These are proposed APIs, not implemented commands. Preserve existing `trx upgrade`
and Admin operations as frontends to the same services. Translate all legacy
flags explicitly, including `--all`, Firstmate `--instance`, JSON contracts and
headless prompt/resume forms. Advertise unsupported capabilities truthfully.

Start the shared harness registry with canonical ID, catalog/presets, launch
adapter and capability metadata. Add provisioning, maintenance and orchestration
interfaces only when a concrete family needs them; do not build a universal
lifecycle abstraction before the first migration. UI and router consume it. Extract existing
lifecycle implementations into private services; temporary private shell helpers
are acceptable. The final implementation must not shell out to public aliases.
Use public package exports and Effect for application logic where practical;
follow the Schema contracts in `native-config.ts` and injectable launch/source
dependencies in `native-run/run.ts`.

Built-ins must resolve by `(harness, profile)`; additive user profiles retain
their declared meaning. A user/built-in name collision must produce an actionable
error instead of silently changing an existing user's configuration. Define an
explicit selection/override mechanism before accepting such collisions. Update
the selector's current global profile list to offer compatible profiles for the
selected harness and clear incompatible selections when the harness changes.
Profile content and defaults must come from the effective TOML configuration;
the registry provides harness capabilities, not a second hardcoded skill catalog.
`--no-always` skips the configured baseline as specified above.

Persistent identity is distinct from a content generation. Existing profile
homes and Firstmate instance UUIDs remain authoritative initially. OMP provider
bindings must keep the two old homes distinct even though both use the public
`default` preset. Never merge their credentials or sessions. Model/effort changes
may continue to share a conversation where the existing contract allows it.
Record provider/state binding in saved selections and exact resume commands if
it becomes selectable. Generation leases are garbage-collection liveness
records, not exclusive migration or fleet locks; preserve backend admission
rules and obtain a separate exclusive migration lock when changing bindings.

## Scope and boundaries

In scope: Native runtime/launcher/guide-core/conversation contracts, router,
legacy Native prototype backends, profile-guides/native, skills manager integration,
install/rebuild scripts, Native/Azure/headless/TUI verification and associated docs.
The user's consolidation also brings `skills.json`, shared skill readers,
Sandbox/comparison skill staging and their policy documentation into scope.
State identity references in saved Guide/conversation data require compatibility
reading even after old command generation stops.

Out of scope: rewriting Sandbox profile locks/images, changing paid model policy,
unrelated dirty edits, replacing Firstmate's orchestration implementation, deleting
user credentials or sessions, or executing Azure/live inference during planning.
Do not relocate all state as part of changing public commands.

## Ordered implementation

### 1. Establish a complete parity manifest and baseline

Create a checked fixture mapping all 20 current profile pairs to destination ID,
arguments, environment, provider/model/plan defaults,
skills/plugins/extensions/MCPs, state paths, headless capabilities and lifecycle
operations. Read each `prototypes/trellage-*-profiles/catalog.json`, README and
contract. Preserve catalog behavior, not just profile labels.

Add tests using `packages/trellage-runtime/test/native-run/run.test.ts` and its
fixture helpers: temporary homes, fake binaries, local Git sources, no paid calls.
Require every legacy catalog entry and its material capabilities to have exactly
one migration disposition: retain, equivalent replacement, or explicitly approved
retirement. Existing behavior is the default, not a requirement to copy internal
implementation details or revive an intentionally retired feature. Include
the Agency rename and OMP consolidation. Keep regression coverage for
the already-migrated `trx run grok PROFILE` route.
For Pi, map each of the ten old extensions against the new distribution's
capabilities before deciding whether it needs an extension. Retain the behavior
unless replacement or retirement is established; do not blindly install ten
extensions into a different Pi version.

Verify: `make test` exits 0 before implementation; record pre-existing failures
instead of hiding them. Run `bun --no-env-file test packages/trellage-runtime/test/native-config.test.ts packages/trellage-runtime/test/native-run`
after every composition increment. Expect zero failures.

### 2. Decouple discovery and establish the minimum registry/policy contract

Implement the resolved TOML-only skill policy and every-load unpinned refresh,
preserving manual-only metadata and harness-specific placement. Convert all
`skills.json` consumers before removing that file; a temporary converter must
not leave two independently editable catalogs in the finished system. Add registry
and built-in preset resolution; extend adapter capabilities without modeling
every harness as an arbitrary unvalidated settings bag. Preserve environment
loading/Varlock behavior currently performed by legacy launchers. Implement
explicit missing-runtime diagnostics. Catalog listing must not execute or require
every installed wrapper. Uninstalled harnesses remain discoverable as not set up;
runtime readiness is evaluated for the selected operation. Introduce a temporary
legacy backend bridge for unmigrated families, without making migrated families
depend on the public wrappers. Do not rewrite unrelated legacy backends yet.

Test first-use TOML initialization, existing-config preservation, conflicting
presets, unsupported plugins, source failure, verified offline fallback, manual
skills and environment injection. Test consecutive loads within 300 seconds,
one fetch per shared source per load, pinned stability, moved tags, explicit pin
upgrade persistence, ambiguous tag targets, concurrent config edits and failed
upgrade rollback. Verify Sandbox/comparison staging uses the same configured
sources without importing host credentials or adding implicit source lists.
Verify focused tests above plus `make floating-skills-contract source-runtime`.
Add `make native-profile-router` as a gate with one legacy wrapper absent and
with only one harness provisioned: list, inventory for that harness, Admin catalog
construction and upgrade dry-run must work. Test selector availability separately
from runtime readiness. This gate must pass before any wrapper is removed.

### 3. Prove one complete slice with Agency, then migrate remaining families

First slice: `trx run agency azure`. Extract the existing `agx` behavior into a
private backend, keeping its state root, internal `trellage-azure` name and Azure
policy intact. Connect its canonical catalog/selector/Guide/Admin routes, setup
and maintenance operations, then retire only the owned public `agx` wrapper.
Use fake Agency/Azure commands for this offline proof; no live Azure login or
MCP round trip is implied. Its single profile and lack of plugin migration make
it a smaller first proof than Copilot or Firstmate.

Verify: `make native-agency-profile native-profile-router launcher` and
`mise run trx-guide-test`, with an installed-upgrade fixture where `agx` is absent
but unrelated legacy families remain. Confirm equivalent argv, environment,
Azure tool restrictions and unchanged state location. If this slice requires a
general plugin engine or a fleet abstraction, narrow the design before proceeding.

Then take each remaining family through the same sequence: backend/adapter,
profile parity, callers, mixed-install test, wrapper retirement. Sections 4–6
below are per-family checklists, not a requirement to finish every adapter before
switching any callers or demonstrating a deletion.

Migrate Claude, Codex, Copilot and Pi profile contracts individually.
Keep the completed Grok route working, including proxy-only authentication,
native sandbox and no auth-file mutation; do not reopen its migration.
Claude preserves normal/plan defaults and document plugins. Codex preserves
Full Access and pstack/Superpowers plugin behavior. Copilot preserves full
plugin contents, HVE agent selection and headless restrictions. Pi preserves
the chosen extension preset, managed install/update semantics and sessions.

Implement actual plugin/MCP/extension contributions for each required adapter;
do not label a skills-only substitute as migrated. Test effective generated
configuration and fake process argv/environment against the parity manifest.

Verify: focused composition tests and `make native-codex-catalog native-codex-pstack native-copilot-profiles native-claude-profile native-picx-profile native-profile-router`.
Keep legacy characterization checks until their new equivalents pass.

### 4. Missing-adapter checklist for the per-family slices

Agency is the first slice above. Afterward, prefer simple single-profile work
(JCode) before OMP consolidation, Prime lifecycle and Firstmate fleets. Existing
adapter families can proceed independently once their plugin/policy gates are
resolved. Firstmate stays last; OMP's native-Copilot default is decided.

- JCode: managed binary/home, provider/failover settings, memory/session state,
  and explicit manual skill invocation outside automatic discovery.
- OMP: expose the Pi distribution through `trx run omp default`, using native
  Copilot by default and sharing Pi infrastructure where compatible. Preserve native Copilot auth/catalog
  and local provider settings, all model roles, community skills and
  version-specific headless policy. Resolve the upstream
  executable from the managed receipt, never recursively through old `omp`.
- Agency: expose `trx run agency azure`; translate to the internal Agency profile
  as needed. Preserve actual `agency copilot --profile-only`, repository `agency.toml`, exact
  Azure MCP/tool restrictions and inherited Azure auth; no implicit login.
- Prime: managed Node/Python runtime identity, kernel setup, daemon/socket
  ownership, stale-process recovery, clarification and explicit shutdown.
- Firstmate: pinned revision/overlay, supervisor and worker homes, distinct
  worker policy, instances, planning/creation approvals, inbox/receipts and
  shared-writer admission. Keep explicit setup and existing task namespaces.

Verify: focused composition tests plus `make native-jcode-profile native-omp-profile native-agency-profile native-prime-profile native-firstmate-profile`.
Extend each contract to call the new public route with the same fixture backend.

### 5. Consumer/state checklist required within each family slice

Switch `trx` picker/list/guide/admin/inventory/upgrade, Guide goal/review launch
paths, version scheduling, profile-guide IDs, capture/evidence identities,
Herdr compatibility, headless/TUI matrices and Azure bootstrap/acceptance.
Use harness capabilities instead of scattered alias checks. Read historical
`native:ALIAS/PROFILE` data through an explicit mapping; write canonical IDs.

Keep existing owned state roots initially. Where composed harness homes must
change, supply an idempotent, ownership-checked migration with collision checks,
rollback records and session continuity tests. Do not follow arbitrary symlinks,
merge conflicting authentication, or write into active fleets/daemons. Old state
remains until a separately reviewed cleanup. Grok is already migrated and is not
an outstanding state/wrapper migration task in this plan.

If state bindings change, stage and validate the binding while the old binding
remains authoritative, then publish one atomic commit record under the migration
lock. Define retry behavior before/after that commit. Rollback restores routing
and ownership references, not stale copies of mutable conversation data. Do not
roll back across a changed upstream state format without an explicit compatibility
proof. A generation lease alone cannot authorize this operation.

Test old/new installs, session resume after update, saved Guide requests, two
worktrees/fleets, interrupted migration, custom user files and offline execution.
Verify: `make launcher profile-guide-contract conversation-source native-profile-router headless-matrix-static-test native-tui-matrix-test azure-fresh-install-contract`
and `mise run trx-guide-test`, all exit 0.

### 6. Wrapper-retirement checklist required within each family slice

After each family's parity/caller gates pass, stop installing its named binary.
Remove owned installed wrappers using positive ownership markers, preserve
unowned executables and user data, and test repeat installation. Remove legacy
`trx run ALIAS PROFILE` routing after a bounded compatibility transition; do not
leave a permanent second launch implementation. Historical data readers may stay.
Retain upstream harness binaries such as `codex`, `claude` and actual OMP.

Do not call the existing uninstall scripts for wrapper retirement: OMP's
uninstaller deletes its managed runtime root, including the receipt-selected
upstream executable. Add a narrow ownership-checked wrapper unlink operation.
Keep private services, runtime receipts and installed harnesses needed by `trx`.
Verify the retained upstream executable after unlinking the wrapper. Account for
the intentional `omp` name overlap: compatibility dispatch must translate old
profiles explicitly and must not route canonical `omp default` through the old
launcher path.

Bound the transition by artifacts: compatibility routing may exist only while
an in-repo caller or supported upgrade fixture still uses it. The final deletion
change removes it after those consumers migrate, with help documenting canonical
commands. If a longer external-script transition is wanted, specify its release
boundary explicitly; this plan does not presume one.

Remove obsolete prototype entrypoints/catalog duplication only after private
backend extraction. Update rebuild/hooks/package contents/docs and replace old
test targets with equivalent capability contracts before removing target names.
Fresh install must require only `trx` plus selected harness prerequisites.

Verify: final `make test`, `bun run check`, CLI `bun run lint` and
`bun run format:check`, `mise run trx-guide-test`, static matrix and fresh-install
contracts all pass. Search remaining aliases and classify every occurrence as
historical compatibility, fixture or migration documentation; no executable
consumer may depend on an alias on PATH.

## Completion and delivery gates

- All 20 legacy pairs have tested migration dispositions and accurate capability
  metadata, including `agency azure` and `omp default`; built-in profiles work
  without a hand-copied config. The completed `grok PROFILE` route still passes
  its regression tests. The destination profile count need not remain 20.
- A fixture PATH containing no named wrappers supports all new launch and
  management routes. No install/rebuild/hook recreates those wrappers.
- Every intermediate mixed installation works with each migrated wrapper absent:
  catalog/list, Admin, inventory and upgrade dry-run do not require it or another
  uninstalled harness. Retained upstream runtimes still execute after cleanup.
- OMP tests cover both populated old homes, provider selection and resume without
  credential/session merging. Migration tests cover concurrent admission,
  interrupted commit/retry, active-fleet refusal and recovery without lost writes.
- `trx run omp default` selects native Copilot even when the local proxy is
  available. Missing Copilot credentials do not switch providers. Existing
  Copilot sessions remain resumable and the old local home is untouched.
- Existing sessions, fleet identities, receipts, authentication and user-owned
  content survive upgrade; unowned same-name binaries remain untouched.
- Guide/Admin/automation produce canonical commands; old saved data still reads.
- No retained skill defaults, manual invocation semantics, plugin contributions
  or native sandbox policies disappear silently. TOML is the sole skill-intent
  authority for every consumer; no independent `skills.json` catalog remains.
- Every profile load checks unpinned sources for latest content; pinned revisions
  remain stable until explicitly changed. Pin upgrades persist atomically and
  failures preserve previous config/cache. Listing profiles never refreshes them.
- Live isolation, inference, and Azure evidence remain distinct from static
  checks. Run paid probes only with explicit intent. For full fresh-host proof,
  use `docs/goals/azure-fresh-install.md` and its evidence/cleanup contract.
- Do not commit/push/merge as part of this planning request. After an authorized
  merge, refresh profiles with `mise run rebuild-profiles` per repository policy.

## Drift and stop conditions

Before implementation inspect `git diff HEAD` and untracked files as well as
`git diff 20230dd..HEAD -- packages prototypes scripts tests`; a commit-only
comparison misses this plan's WIP baseline. Reconcile concurrent edits.
Stop a family's deletion if parity lacks a supported destination, state ownership
is ambiguous, a fleet is active, or preserving a capability requires an undecided
product change. Do not weaken tests to make the deletion pass.

Review focus was Native migration and its direct consumers. This is not a full
audit of unrelated dirty changes, a live harness certification, or fresh-host proof.

## Verification performed during planning

Using the installed pinned Bun 1.4.2:
`bun --no-env-file test packages/trellage-runtime/test/native-config.test.ts packages/trellage-runtime/test/native-run`
passed **66 tests, 0 failures, 155 assertions across 4 files**. This proves the
focused composition/config tests pass, not legacy behavioral parity. Full
`make test`, Guide integration, live models and Azure were not run in this review.
Only this plan and the plan index were written.

## Pressure test and revisions (2026-10-07)

Verdict: **Partially justified**. High confidence in the migration direction and
the source-backed blockers; moderate confidence in the proposed order until the
first end-to-end family fixture passes. The original roadmap was too broad to
treat as one implementation ticket. Sections 1–3 now define the initial work;
sections 4–6 are repeatable per-family checklists. Split executable tickets at
those boundaries, each with exact files and its own acceptance commands.

| Claim | Type | Primary evidence / counterevidence | Status |
| --- | --- | --- | --- |
| A passing launch adapter makes a wrapper removable | Assumption | Router `bin/trx:1102` discovers every wrapper; `:251` aborts when one is missing | Contradicted; mixed-install discovery is now an earlier gate |
| Existing uninstall scripts can retire commands | Assumption | OMP `uninstall.sh:54` removes the runtime root; `bin/omp:514` resolves the upstream executable below it | Contradicted; use wrapper-only cleanup |
| Composition leases make state migration safe | Assumption | `native-run/lease.ts:25` writes independent per-PID liveness records; no exclusive admission | Unsupported; preserve backend locks and add migration exclusion |
| `omp default` fully specifies the new behavior | Assumption | OMP README has distinct local and native-Copilot routes; `compose.ts:47` identifies state by harness/profiles | Default resolved by user: native Copilot; bind its existing home and verify separate local access/state |
| All ten Pi extensions must be reinstalled | Inference | Legacy catalog lists them, but the composed distribution differs | Not established; compare capabilities before retaining packages |
| Agency is the cheapest complete first slice | Judgment | One catalog preset, existing backend, no plugin composition requirement; real Azure behavior still needs separate live proof | Reasonable, unproven until the offline slice passes |

Two independent read-only reviewers considered both the strongest case for the
plan (preserved lifecycle/state ownership) and against it (too many simultaneous
API/config/state changes). Both recommended discovery-first rollout, explicit
OMP identity, narrow wrapper cleanup and real migration locking. One proposed
Agency as the first complete slice; the other emphasized reducing new CLI verbs
and avoiding unnecessary feature duplication. The revised plan adopts both.
This agreement is design advice, not substitute runtime evidence.

The user subsequently resolved the skill-policy decision: TOML is the source of
truth, unpinned sources attempt refresh on every profile load, and explicit
maintenance can upgrade pins. The contract above supersedes the earlier policy
recommendation. OMP's default is resolved as native Copilot; explicit local access
still needs a concrete migration mapping. Grok remains completed
per user direction and is not reopened by these questions.

Cheapest falsifier: remove only `agx` from a fixture installation after wiring
the canonical route. If `trx list --json`, Admin catalog construction, upgrade
dry-run, Agency launch or an unrelated harness fails, the first slice is not
complete and no further wrapper should be deleted. Additional critical tests:
two populated OMP homes, resume after provider selection, interruption on both
sides of migration commit, retained runtime execution and active-fleet refusal.

This pressure test used local source evidence and independent agent deliberation;
no external product claim needed web research. Only the plan was revised. The
66-test result above belongs to the earlier review; no application tests were
rerun for these documentation-only revisions. Markdown diff checks passed.
