# Verification

Use a current Node.js 24 release with its bundled npm, as CI does. The
repository test packages use Vitest 5, which requires Node.js 22.12 or a newer
supported Node.js release. Test reports and artifacts under `.vitest/` are
ignored.

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

Run the offline `trx guide` UI integration matrix after installing the
launcher dependencies and building `packages/trellage-guide-core`:

```bash
mise run trx-guide-test
```

The [guide UI integration matrix](guide-ui-integration.md) covers 17
keyboard-driven scenarios in the real Ink guide. It includes all five ranked
recommendations, all three pinned lenses, seeded candidate choices and queue
removals, both prompt augmentation paths, prompt edits, and `L` batch launches.
It checks complete rendered prompts, candidate and job counts, and exact
Native, Sandbox, and Herdr commands, including arguments and working directories.

Provider replies, readiness checks, Git inspection, augmentation inputs, and
Herdr responses are fixtures. No harness, repository packer, or worktree
operation runs. The matrix covers UI interaction and command handoff, not
live LLM calls, caching, harness startup, or the outer `trx` shell router.
It runs in the normal launcher suite, using
Vitest's default `forks` pool rather than worker threads.
`node-pty` requires native build tools if a matching prebuilt binary is not
available. Its test dependency is pinned to `1.2.0-beta.15` because `1.1.0`
ships a non-executable spawn helper on macOS ARM64.

Install the repository profile compiler dependencies once to install the Git
hooks:

```bash
npm ci --prefix packages/trellage-cli
npm ci --prefix tests/playwright
```

Each commit runs staged whitespace validation plus profile compiler lint,
format, and type checks in parallel. Each push runs only changed-path checks:
whitespace, launcher unit/type/build checks, profile compiler typechecking, and
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
