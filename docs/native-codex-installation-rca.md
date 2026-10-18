# Native Codex installation contract: slow-run analysis

## Findings

The long run was not evidence of a model call or one hung Codex launch.
`tests/blocks/installation.sh` repeatedly exercises installer/uninstaller transactions
across normal installs, migrations, failure injection, Fish configuration variants,
and TERM/INT/HUP publication boundaries.

Each invocation of the real installer stages two source runtimes: native environment
and floating skills. Previously both contained the full application workspace,
including all agent/UI development dependencies. This checkout's dependency payload
measured **12,144 files / 273.3 MiB per staged copy**. Copies, owned-tree validation,
source receipts, topology snapshots, and cleanup were repeated across the matrix.
Reusing downloaded dependencies did not remove this repeated filesystem work.

A second issue made cancellation misleading: `scripts/test-command.py` started a
new session for the recipe but waited without a deadline. An outer harness timeout
could stop the caller while the isolated installation test continued. Extending the
outer timeout therefore did not fix the test or reliably clean up its workers.

## Changes

- The transaction contract now builds a focused, fixture-owned source workspace.
  It uses the real Codex installer/uninstaller, their required common files, the real
  workspace validator and receipt writer, and actual Varlock/TOML package files.
  It excludes unrelated harness/UI dependencies and source modules.
- The fixture has its own workspace-only lockfile and declared dependency graph;
  it does not fetch packages, change production manifests, or introduce a production
  validation bypass. No transaction assertions or signal/failure cases were removed.
- Full dependency/bootstrap and agent execution integration remain covered by the
  existing source-runtime and Codex catalog/auth/config/lifecycle contracts. The
  transaction fixture does not claim to test the entire application's dependencies.
- Direct and make-driven installation-contract runs have a **120-second deadline**.
  The runner reports a timeout with exit status **124**, sends TERM to the owned
  recipe group, allows **0.5 seconds** to settle, then sends KILL and reaps the child.
  External cancellation also gets bounded group cleanup.
- Progress identifies the current rollback/signal case. The installation contract
  runs in the timing-sensitive serial phase of `make test`, avoiding competition
  with other filesystem-heavy fixtures.

## Verification

- The deadline test uses a process that ignores TERM; it verifies timeout status,
  bounded return, and no running child afterward.
- Invalid deadline inputs are rejected before executing the recipe.
- Existing exit-status, signal-forwarding, stdout, and make-jobserver tests pass.
- The focused source fixture passes the real readiness validator and checks copied
  installer/Varlock bytes against the originals.
- First reduced run: stopped at **120.514 seconds** during HUP cases, with group
  cleanup rather than an orphaned worker.
- After removing unrelated source trees: the complete unchanged transaction matrix
  passed in **112.951 seconds**, below the same 120-second deadline.

Do not respond to a future timeout by increasing this limit. Inspect the last
reported case, fixture size, and source-runtime work first. A timeout remains a
failure, not permission to skip assertions.
