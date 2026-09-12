# Verification

Use Bun 1.3.3 and prepare the source workspace from the repository root:

```bash
scripts/install-source-runtime.sh --prepare
```

Preparation installs frozen workspace dependencies through the host registry,
restores the canonical lock, corrects only validated owned bin targets, and
records `.trellage-source-ready.json`. Rerun preparation when source or
dependency metadata changes. A raw `bun install --frozen-lockfile` is not a
substitute: it does not record readiness and can leave declared bins with
unsafe permissions.

First-party source and test workers run under Bun. Type checks use `noEmit`;
no application bundle or `dist` is required. External agent and browser tools
can still require Node.js. Test reports and artifacts under `.vitest/` are
ignored.

Positive installation fixtures must start from a complete source workspace
prepared through the shared installer. Do not substitute handpicked source
files or fabricate a readiness receipt. Apply missing-readiness, stale-source,
symlink, ownership, and unsafe-mode mutations after fixture setup when testing
those refusals. Normal launches and read-only commands must still reject an
unprepared or unsafe runtime without installing or repairing it implicitly.

Run repository contracts without launching paid agents:

```bash
make test
git diff --check
```

`make test` runs the compiler fingerprint performance contract in a separate
serial phase after the parallel targets finish. It is not part of the parallel
`launcher` target: concurrent suite activity can distort its wall-clock
measurement. The contract still requires an unchanged SHA-256 digest and a
cached-worktree fingerprint time strictly below 900 ms. Run it directly with
`make profile-compiler-fingerprint`, without another test suite running.

`prototypes/.npmignore` excludes temporary `.contract-fixture.*` and
`.contract-work` directories from npm packages. The publication contract checks
these exclusions so package inspection can run alongside native profile tests
without scanning their changing fixture files.

Run the offline `trx guide` UI integration matrix after source preparation:

```bash
mise run trx-guide-test
```

The [guide UI integration matrix](guide-ui-integration.md) covers 31
keyboard-driven scenarios in the real Ink guide. It includes all five ranked
recommendations, all three pinned lenses, seeded candidate choices and queue
removals, both prompt augmentation paths, prompt edits, parked readiness,
approved-goal flows, and `L` batch launches.
It checks complete rendered prompts, candidate and job counts, and exact
Native, Sandbox, and Herdr commands, including arguments and working directories.

Provider replies, readiness checks, Git inspection, augmentation inputs, and
Herdr responses are fixtures. No harness, repository packer, or worktree
operation runs. The matrix covers UI interaction and command handoff, not
live LLM calls, caching, harness startup, or the outer `trx` shell router.
It runs source fixtures in child processes, not generated bundles. On macOS
and Linux, Python 3's standard-library POSIX PTY support supplies the terminal
transport through `tests/helpers/posix-pty.py`; the test workers and UI
children remain Bun processes. No `node-pty` addon or UI bundler is required.
The launcher uses Vitest's forks pool with at most two workers.

The source PTY adapter applies the shared no-cache environment before starting
Python and its Bun child, including when a fixture replaces HOME and the rest
of its environment. Initial editor input waits for both the semantic screen
and the terminal's current parsed input-enable mode. An earlier enable marker
that has since been revoked is not readiness. Existing five-second waits,
native input handling, and style-only queue-selection assertions remain in
place.

Install repository dependencies and the development Git hooks explicitly:

```bash
scripts/install-source-runtime.sh --prepare
bash scripts/install-lefthook-hook.sh
npm ci --prefix tests/playwright
```

Each commit runs staged whitespace validation plus profile compiler lint,
format, and type checks in parallel. Each push runs only changed-path checks:
whitespace, launcher source tests and type checks, profile compiler typechecking, and
shell syntax. These jobs run concurrently and should complete in seconds;
GitHub Actions remains authoritative for broad deterministic and lifecycle
contracts.

Run full GitHub Actions contract parity explicitly before high-risk pushes:

```bash
make test
```

The default publication contract is the durable tree scan used by both local
verification and CI. The one-time sanitized-history release audit also checks
commit identities, exact history and branch refs, and the absence of remotes
and tags:

```bash
make publication-history-audit
```

Discover the shared TODO browser matrix after installing its locked dependencies:

```bash
cd tests/playwright && npm ci && cd ../..
./tests/playwright_matrix.sh
```

Live Docker verification is explicit because it builds images, invokes coding agents, and mutates retained contestant resources:

```bash
make compare HARNESS=harnesses/todo-side-by-side/harness.json
```

The resulting `comparison.json` records prompt parity and contestant pass/fail status. It intentionally does not select a winner.
