# Nodecode skills: knowledge + manual-dispatch spikes

## Recommendation

Proceed with **B + C**, subject to the lifecycle work below:

- **B — managed native knowledge:** publish ordinary selected skills as a
  Trellage-owned, data-only knowledge cell. Copy complete skill trees into
  durable snapshots and include their stable asset directories in knowledge.
  Keep user knowledge, learned Lisp and conversations outside managed ownership.
- **C — explicit manual dispatch:** keep manual-only skills in a private store,
  outside native knowledge discovery. Use one small Trellage-owned command bridge
  to read a selected skill and submit it as text. Never install upstream plugins,
  hooks, extensions or executable cells to implement skill discovery.
- Consume the **canonical composition plan**, including explicit profiles,
  eligible always profiles and invocation metadata. Do not introduce a second
  selection/policy parser or source allowlist.

This directory is a prototype, **not production Nodecode integration**. It changes
no router, adapter, installed profile or normal Nodecode home. Native probes use
synthetic fixtures and disposable homes, with updates disabled and no model calls.

## What is here

| File                                   | Purpose                                                                                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot.ts`                          | Canonical-plan artifact publisher; provenance/policy manifest, complete assets, generated knowledge cell, private manual store and instruction artifact. |
| `snapshot.test.ts`                     | Selection, no-always reconciliation, policy, provenance, assets, failure, containment and competing-publisher contracts.                                 |
| `integration.test.ts`                  | Loads the publisher's actual generated cell using installed Nodecode; opt-in.                                                                            |
| `native-probe.py`                      | Real native knowledge, instruction loading, index refresh, durable-session and user-learning probes.                                                     |
| `native-findings.md`                   | Native API evidence and 34 offline checks.                                                                                                               |
| `manual-bridge.lisp`                   | Generic `/trx-skill SKILL PROMPT` proof of concept with a synthetic selected-skill allowlist.                                                            |
| `manual-check.lisp`, `manual-probe.sh` | 36 native command/discovery/submission assertions; submission intercepted before inference.                                                              |
| `manual-findings.md`                   | Native command APIs, behavior and limitations.                                                                                                           |

The snapshot publisher and native manual bridge are separate experiments. The
bridge does **not** yet consume the publisher's manifest. The integration test
connects the publisher to native knowledge, not the manual submission workflow.
The publisher retains `alwaysOn` in its manifest but does not implement automatic
instruction injection for those skills; knowledge discoverability alone does not
satisfy that policy. Production wiring must implement and test this separately.

## Verified architecture and important limits

1. **Native knowledge works as data.** Generated Lisp string literals preserve
   skill prose; upstream code-looking content is not executed. Native discovery
   recognizes a knowledge-only ASDF cell. A metadata-only manual flag does not
   prevent native discovery, so manual content must be excluded structurally.
2. **Assets survive generation cleanup.** Full trees (including large nested
   assets and executable mode bits) live under
   `managed/nodecode-skills/snapshots/<manifest-hash>/`, not a generation home.
   Tests do not execute skill scripts or establish Office dependency compatibility.
3. **Snapshot identity must include provenance and selection.** Composition IDs
   identify a harness and normalized explicit profile stack, not a workspace,
   model, always-profile resolution or source revision. Normal and `--no-always`
   launches can share the same persistent home. The prototype hashes its manifest
   rather than treating the composition/generation ID as a sufficient receipt.
4. **Publication has a narrow atomic boundary.** A staging tree is validated
   before an atomic `current` symlink replacement. A second publisher fails closed
   while a lock exists; errors before publication leave the previous pointer.
   Prior snapshots remain readable. This is not power-loss durability, a host
   filesystem sandbox, stale-lock recovery, session leasing or garbage collection.
   Snapshots are immutable by convention, not OS-enforced read-only: republishing
   detects modified content, but a host-authority process can still mutate it.
5. **Current selection and active conversations are different lifetimes.** Fresh
   native lookup sees a retargeted cell, but an existing conversation retains its
   pinned knowledge index until `nlk:mark-index-refresh`, `/index reload`, eviction
   or a fresh conversation. A process restart alone does not establish refresh.
   Selection removal cannot erase content already retained in conversation/learning.
6. **Instructions are a separate owned surface.** Home `AGENTS.md` loads as
   `operator-rules`; project instructions load independently. Oversized home rules
   are rejected whole (65,537 characters in the probe). `instructions.md` is only
   an artifact here: production needs an ownership-aware merge that preserves user
   rules. Cell registration and home instruction updates are not one transaction.
7. **Command dispatch is feasible, not enforced user-only execution.** A command
   return merely displays text; `nle:submit` is required to start/queue a turn.
   The bridge registers no model tool and exposes no private knowledge, but
   model-side eval can call `nle:slash` directly. Manual provisioning is a discovery
   boundary, not authorization against an agent with host authority.
8. **Native API evidence is version-specific.** Probes ran on Nodecode
   `0.1.1+6d58aa70b`. Its internal `trial` entrypoint and request-assembly functions
   are testing seams, not supported production automation interfaces. No paid
   inference, TUI gesture or real gateway submission was tested.

## Production integration seam (read-only investigation)

In `packages/trellage-runtime/src/native-run/`:

- `compose.ts` provides the canonical plan. Preserve `manualOnly`/`alwaysOn` from
  the actual plan; do not reconstruct invocation policy from a generation manifest
  that omits those flags.
- `run.ts` calls adapter `beforeLaunch` on real launches, including generation
  reuse. That is the appropriate reconciliation seam to investigate next.
- `writeAdapterFiles` is generation materialization, not per-launch reconciliation.
  Its staging home is not the final persistent home and can be discarded. Wiring
  only that hook would miss reused generations and selection changes.
- Generation leases retain generation artifacts; they do not mutually exclude
  launches sharing the persistent home or lease external skill snapshots.

Before rollout, choose and test active-session refresh/pinning semantics, shared-home
concurrency, manifest-backed manual dispatch, ownership-aware instruction merging,
registration rollback, stale-lock recovery and snapshot retention/GC. Reuse the
existing configured source refresh/cache behavior; this prototype supplies an
in-memory fixture resolver and does not prove live floating-source refresh.

If hard user-only authorization is required, **do not ship the native slash bridge
as that boundary**. A separate ingress design needs trusted origin checks; simply
moving the command to a host CLI would not block model-side shell access.

## Validation results

On the installed release noted above:

- Snapshot and native integration: **10 tests passed, 49 assertions**.
- Native knowledge/instructions/lifecycle: **34 checks passed**.
- Native manual command/submission seam: **36 assertions passed**.
- Isolated strict TypeScript check and repository-config Oxfmt check passed.
- Full repository `make test` passed with prototype source files held fixed
  (followed only by README clarifications). An earlier run failed two CLI matrix
  source-stability guards while prototype files were still being edited.

## Reproduce

From the trusted repository root, with source runtime dependencies prepared using
`scripts/install-source-runtime.sh --prepare`:

```sh
# Static tests; native integration is skipped without NODECODE_BIN.
mise exec -- bun --no-env-file test pocs/nodecode-skills

# Actual generated knowledge -> installed Nodecode, still offline/no inference.
NODECODE_BIN="$(command -v nodecode)" mise exec -- bun --no-env-file test pocs/nodecode-skills
python3 pocs/nodecode-skills/native-probe.py
bash pocs/nodecode-skills/manual-probe.sh

mise exec -- bun --no-env-file node_modules/typescript/bin/tsc --noEmit -p pocs/nodecode-skills/tsconfig.json
mise exec -- bun --no-env-file node_modules/oxfmt/bin/oxfmt --config .prettierrc.json --check pocs/nodecode-skills
make test
```

The native Python probe accepts `--nodecode PATH`; the manual probe accepts
`NODECODE_BIN`. Native probes delete their disposable homes by default. The Python
probe's `--keep` intentionally retains evidence for diagnosis.
