# Verification

Use Bun 1.4.2 and prepare the source workspace from the repository root:

```bash
scripts/install-source-runtime.sh --prepare
```

Preparation installs frozen workspace dependencies through the host registry,
restores the canonical lock, corrects only validated owned bin targets, and
records `.trellage-source-ready.json`. Rerun preparation when source or
dependency metadata changes. A raw `bun install --frozen-lockfile` is not a
substitute: it does not record readiness and can leave declared bins with
unsafe permissions.

Preparation stores Bun package downloads in
`<git-common-dir>/trellage/bun-install-cache`, so all worktrees of one
repository share them. A new worktree then installs from this cache in seconds
instead of downloading every package again. Bun verifies each cached package
against the lockfile integrity. Set `BUN_INSTALL_CACHE_DIR` to use a different
cache. Roots that are not a Git worktree top level use a temporary cache that
preparation deletes after the install.

`mise run rebuild-profiles` reinstalls the retained Native backends and `trx`;
their installers manage separate installed runtimes.

The OMP contract runs under a 600-second supervisor. Child stdout and stderr go
to a private log file, so a paused caller cannot block skill setup by leaving
its output pipe unread. Log replay waits at most two seconds; failed or
undelivered logs remain in the caller's temporary directory as
`trellage-omp-contract-*.log`. Successful, fully delivered logs are deleted.
The supervisor cleans up owned process groups and fixture directories on exit.
Fixture synchronization waits fail after 30 seconds with the missing release
path. `make native-omp-profile` includes regressions for unread output, timeout,
detached-child cleanup, signal cancellation, and missing release files.

Router reinstall preflight distinguishes replacement from execution.
An owned runtime with unchanged published sources and dependency manifests can
be replaced even when its file-metadata or dependency inventory has drifted.
The installer stages a fresh frozen runtime before publication; it does not
rewrite the old receipt to approve drifted files for execution. Changed sources,
unowned paths, unsafe permissions, and escaping links still block replacement.

CI caches Bun and npm package downloads by runner platform, pinned runtime
versions, and lockfile contents. The cache excludes installed dependencies and
the readiness receipt, so each job still prepares its source workspace from the
current checkout. Tests that explicitly override `BUN_INSTALL_CACHE_DIR` remain
isolated from this CI cache by design. CI saves the download cache immediately
after successful dependency installation, before the test suites run, so a
later test failure does not discard a usable dependency cache.
Pull requests run `make test-pr` on Linux and the source/PTY suites on macOS,
with a 15-minute job timeout on each platform. The PR gate checks shell syntax,
repository identity and harness configuration, compiler lint and formatting,
all workspace TypeScript checks and tests, source startup, and profile guides.
Its checks run sequentially and stop at the first failing command. This keeps
the gate independent of slower installer, Docker, and native lifecycle suites.

Pushes to `main` run the complete `make test` suite, including those integration
contracts, with a 90-minute Linux timeout. The CI workflow can also be dispatched
manually on a branch to run the full suite before merging a high-risk change.
Browser contract dependencies are installed only for full-suite runs. Both
lanes retain the `deterministic-contracts` check name required by branch protection.
The fast gate reduces regression risk; it does not cover every integration
failure that the full post-merge suite can detect.

Keep `bun.lock` committed during development. Use normal `bun install`,
`bun add`, `bun update`, and `bun remove` commands with the mise-pinned Bun.
Root lifecycle hooks reject other package-manager versions and prepare source
runtime readiness automatically; no separate dependency-management command is
needed. Internal frozen preparation disables lifecycle scripts to avoid recursion.
Do not bypass the hooks with `--ignore-scripts`.

Bun runs lifecycle hooks after some dependency work, so the version check is
not a guarantee against earlier writes by an unsupported package manager.
The mise version pin and clean CI checks provide additional protection.
Commit manifest and lockfile changes together. Do not share `node_modules`
between worktrees.

Both CI platforms require an empty dependency tree before frozen preparation
and reject changes to the lockfile or workspace manifests after preparation.

Source fingerprints and staging exclude generated Native profile state
(`cache`, `mise`, `mise-config`, `rust-prefix`, `installed-version`, and
`runtime-identity.json`) directly inside `prototypes/trellage-*-profiles`,
plus JCode's generated `version` file. Tool installation links in those
directories are not source inputs. Links in source files remain invalid.

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

Run the PR regression gate without launching paid agents:

```bash
make test-pr
```

Run the full repository contracts:

```bash
make test
git diff --check
```

Local offline test optimization runs can record their protocol, first-change ordering,
and outstanding verification in `test-performance.json`. This generated report is
ignored by Git and is not shipped with the repository. Incomplete measurements
must be marked explicitly and do not establish a speedup.
The default suite includes `cli-matrix-contract`: inventory drift checks, Cartesian
generator checks, guide parser regressions against independently declared
mode conflicts and input classes, and audited guide model fixtures for every
catalog profile, both optimization outcomes, and matching with both backends.
It also runs detached router help checks, real run-selector navigation,
cancellation, and launch checks, and real guide entrypoint checks for JSON, previews, interactive
modes, and a synthetic next-steps conversation.
Process fixtures use private homes and audited model mocks; they require a clean
audit receipt after normal exit. Run
`python3 scripts/test-offline.py -- bun tests/exhaustive/guide-process-regression.ts --all-terminal-widths`
to repeat the process checks at 69, 70, and 100 columns.
Run the corresponding `tests/exhaustive/run-selector-regression.ts --all-terminal-widths`
command through the same offline wrapper for 35 selector cases. These include
model and effort propagation through the real parser and clean Pi adapter,
dry-run without a child, and natural exit with the mocked child's status.
The run executor checks actual Bash dispatch before invoking runtime behavior.
Selector combinations currently use a fixed Pi clean selection and exercise
cancellation and launch at all three widths, plus detached rejection. Option
overrides, literal forwarded flags, and expected usage rejection are checked
through real parsing and runtime behavior. The full selector harness/profile
selection product remains part of the unfinished domain audit.
Root `-h`, `--help`, and `help` are combined with every command option state.
These cases run the actual router with the alias before `run` or `guide` and
assert that no Bun entrypoint starts. Inventory checks reject new root flags or
help aliases until their coverage is declared.
These checks do not constitute the complete
Cartesian command execution required from the separate exhaustive workload.
`make test-exhaustive` runs the process regressions at all three terminal widths,
then both complete declared Cartesian products without range limits.
Each run writes unique evidence under `.test-performance/exhaustive-*/`.
Completion requires exact declared and executed counts, matching source identities,
and successful child receipts; a partial range never counts as completion.
Executors check tracked and nonignored source inputs at checkpoints and completion
and refuse source symlinks. Keep source inputs unchanged during a run. The
`test-performance.json` evidence output, installed dependencies, and ignored
generated files are outside that source identity.
The current declaration contains 281,568,563,797,248 run cases and 31,762,612,224,000 guide
cases. Full execution has not completed, and the global-option, syntax, and
process-context domain audit remains open. This target is separate from the
default developer suite and is not yet evidence that exhaustive verification passed.
Run model, effort, and skill domains include separated and inline values, repeated
and duplicate occurrences, empty earlier occurrences, missing values, and values
shaped like flags. Scalar options retain their last value; skill selections
accumulate and validate every occurrence.
Run boolean flags include repeated occurrences. Both orders of the isolation
flags and all six orders of continue, resume picker, and explicit resume ID
are crossed with earlier states; the last flag wins.
Launch assertions check translated resume arguments, including Codex's `exec`
placement and Copilot's forwarded planning flag. External harnesses own
conversation lookup; these offline fixtures do not run their conversation stores.
JSON guide requests include 15 stdin classes, covering valid text boundaries,
malformed streams, schema errors, and invalid intent. Explicit CLI intent bypasses
stdin. The default suite checks all 60 input/override/matching-or-generation
combinations in process and four through stdin pipes; the exhaustive target runs
all 60 pipe cases as well. Invalid requests must fail before model-client access.
The command matrix also varies JSON profile, model, effort, workflow, goal, and original
intent independently of CLI options. Workflow IDs come from the profile guides
and are checked against the actual catalog. A workflow requires an effective
profile. Generation preserves original intent or rejects it without truncation:
the field accepts 60,000 UTF-16 units, but generated prompts have an 8,000-unit
limit including framing and the specification. The maintained request-resolution
checks cover 16,384 override combinations and 920 goal/original-intent combinations;
86 real service cases check command effects, including every declared goal workflow,
both goal controllers, unsupported selections, protected objectives, and launch transport.
The exhaustive preconditions expand this to 1,029 cases with all 23 goal fixtures.
Those goal states also cross every command axis in the declared Cartesian matrix.
Neither complete command product has been executed; interactive goal refinement and
the remaining syntax/process-context audit are still pending.
`make test` runs inside inherited network isolation (macOS Seatbelt or Linux
seccomp). TCP access, including host provider proxies, is unavailable;
Unix fixture sockets remain available. The wrapper removes inherited `HERDR_*`
context so tests cannot implicitly address the host agent's control socket or
pane. It also removes inherited `XDG_CONFIG_HOME`, `XDG_DATA_HOME`,
`XDG_STATE_HOME`, `XDG_CACHE_HOME`, and `TRELLAGE_CONFIG` so fixture homes do
not share host configuration or mutable state. Fixtures establish their own
context inside the isolated command; explicit test package-cache settings remain
available.
Both `make test` and `make test-exhaustive` first run the isolation canaries
outside the restriction, where they can create local TCP listeners to verify
that isolated children cannot reach them. These canaries never contact providers.
Unexpected default LLM client construction
fails under explicit test configuration and leaves a violation receipt, so catching
that error cannot silently turn the run green. `make offline-llm-contract` checks
the isolation with local canaries and no provider traffic.

Linux requires `libseccomp.so.2` (Ubuntu package `libseccomp2`). The wrapper
installs an inherited syscall filter that denies socket families other than
`AF_UNIX` and disables `io_uring_setup`, which could otherwise create network
sockets without a socket syscall. Filter setup fails closed. Tests retain the
caller's UID/GID and filesystem ownership view, including root-owned ancestors.
The former user namespace approach was blocked by Ubuntu 24.04 AppArmor and,
even when permitted, remapped root-owned ancestors to an unmapped UID. No
AppArmor setting changes or privileged test execution are needed. `make test-pr`
also runs the isolation and ownership canaries so setup regressions are caught
before merge.

Tests require Python 3.11 or newer on `PATH`. Run `make test-prepare` once after changing locked dependencies to populate
`.test-performance/package-cache` using the repository's frozen source preparer
and the configured package feed, and install the separately locked Playwright
test dependencies with `npm ci`. This is setup, measured separately from warm
tests. Fixtures still execute the frozen installer and receive independent
dependency files; they reuse downloaded package bytes through
`TRELLAGE_TEST_PACKAGE_CACHE`. Tests never fall back to an unrestricted network.
Preparation installs into a source-only copy: staging an already prepared
workspace can reuse `node_modules` without filling the download cache.
`make test` checks a fresh offline installation before starting the parallel
contracts, so an incomplete cache fails immediately. Lint, formatting, and root
TypeScript checks also run in the full suite.

Codex uses the shared Native source installer and composition adapter. Its
installation coverage lives in `packages/trellage-runtime/test/runtime.test.ts`;
launch and instruction behavior live in `test/native-run/run.test.ts` under the
same package. These tests use local fixtures and do not install or invoke a
paid Codex session. OMP process tests observe fixture process exit before checking
for late writes, instead of sleeping after already completed cleanup.

Use `python3 scripts/test-performance.py --reference REFERENCE --candidate CANDIDATE
--package-cache CACHE --inventory test-performance.json --output NEW_REPORT.json`
to collect five alternating warm pairs. Both trees must have prepared dependencies;
keep their source files unchanged throughout the run. The runner refuses failed,
incomplete, changed-source, or contended samples. Acceptance requires an improvement
greater than both 5% of the reference median and three times the larger MAD
(median absolute deviation). Retain the output JSON and adjacent raw logs.

Run the same command with `--phase clean-start --pairs 1` and a new output path
for separate fresh-checkout measurements. Each sample uses a new local source
snapshot, separately timed frozen dependency preparation, then its first test run.
Package and operating-system caches remain warm; these are not machine-cold or
dependency-cold measurements. The snapshots and their mise trust entries remain
for inspection; untrust each snapshot before deleting it.

Supplemental coverage tools live in `scripts/exhaustive-*` and
`scripts/verify-*`. `make test-exhaustive-plan` lists their independent domains
and commands. `make test-exhaustive-supplemental` runs these scopes, retaining
reports under `results/exhaustive-TIMESTAMP/`; it exits 2 even if implemented
scopes pass while full behavior products remain unimplemented. It does not
replace the canonical `make test-exhaustive` target. Select individual scopes
with `bash scripts/test-offline.sh --native-sources python3 scripts/test-exhaustive.py
--scope NAME --output NEW_DIRECTORY`. The shell wrapper supplies deterministic
local source repositories and delegates isolation and violation reporting to
the canonical Python wrapper.

These supplemental scopes cover argument parsing, root dispatch, composition,
clean launches, model/effort/resume propagation, literal command arguments,
review services, and continuation admission/preparation/launch. Strict mocks
reject unexpected provider or command operations; verifiers reject partial
ranges as complete coverage. Full products have not completed. The expanded
review scope previously exceeded its 3,600,000 ms timeout after storing 31 of
42 expected generations; it is not a passing handoff proof. Linux execution of
the supplemental process fixtures remains unvalidated.

`scripts/benchmark-tests.py` offers alternating warm or fresh-worktree runs
with competing-workload detection, source identities, raw logs, and recipe
inventory reconciliation. Historical batch `warm-clonefile-11` measured a
21.80643614681186% gain: reference median 1,631.5310965839308 seconds, candidate
median 1,275.7523097919766 seconds, and MADs 10.688214833033271 and
1.355008624959737 seconds. Each side had one warmup and five measured samples;
all 12 runs passed 54 recipe invocations across 46 targets. The gain of
355.7787867919542 seconds exceeded the 81.57655482919654-second threshold.
These figures describe archived sources before the upstream suite changes,
not this combined revision. Clean-start and reversed confirmation, complete
exhaustive coverage, and five qualifying no-improvement attempts remain pending.
No plateau or router optimization is claimed. Generated benchmark JSON is not
shipped; supporting archives remain outside the repository.

Each recipe in `make test` emits `[test-timing]` start and end records with its
target name, elapsed seconds, and exit status. Targets with multiple recipe
lines emit a pair for each line. Failed targets are reported immediately, even
while Make waits for other parallel work to finish. To time a single target,
run `make TEST_TIMING=1 <target>`.

`make test` runs the source workspace fingerprint performance contract in a separate
serial phase after the parallel targets finish. It is not part of the parallel
`launcher` target: concurrent suite activity can distort its wall-clock
measurement. The contract still requires an unchanged SHA-256 digest and a
cached-worktree fingerprint time strictly below 900 ms. Run it directly with
`make profile-compiler-fingerprint` (source workspace fingerprint), without another test suite running.

The timing-sensitive phase also runs serially. Codex, Grok, OMP, Claude,
native TUI, and Headlong entry contracts run without competing with
source installation and UI test workloads. Fixture startup waits must be
separate from the behavior being measured: cancellation deadlines start only
after readiness, and blocked services stay blocked until the test explicitly
releases them. A slow fixture must not look like a cancellation or lock failure.

The review-skill 1,024-entry boundary test uses a fixed clock while retaining
its 1,025-entry rejection and cleanup assertions. Separate deadline tests advance
their clocks. The 4,096-file artifact test allows 30,000 ms for filesystem work
under load while still capturing every file and rejecting file 4,097.

`prototypes/.npmignore` excludes temporary `.contract-fixture.*` and
`.contract-work` directories from npm packages. The publication contract checks
these exclusions so package inspection can run alongside native profile tests
without scanning their changing fixture files.

Run the offline `trx guide` UI integration matrix after source preparation:

```bash
mise run trx-guide-test
```

The [guide UI integration matrix](guide-ui-integration.md) covers
keyboard-driven scenarios in the real Ink guide. It includes all five ranked
recommendations, the Council, Research, HVE RPI, and customer Discovery lenses,
seeded candidate choices and queue removals, prompt augmentation, the local
customer brief and approval boundary, prompt edits, parked readiness,
approved-goal flows, and `L` batch launches.
It checks complete rendered prompts, candidate and job counts, and exact
Native and Herdr commands, including arguments and working directories.

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

The pre-push workspace checks clear Git's repository-local environment variables
inside their test subshell. Nested Git fixtures must not inherit the hook's
repository or index. `tests/source_startup_contract.sh` verifies this boundary
and confirms that the caller repository remains unchanged.

Each commit runs staged whitespace validation plus profile compiler lint,
format, and type checks in parallel. Each push runs only changed-path checks:
whitespace, launcher source tests and type checks, profile compiler typechecking, and
shell syntax. These jobs run concurrently and should complete in seconds;
GitHub Actions remains authoritative for broad deterministic and lifecycle
contracts.

The installed `post-commit`, `post-merge`, and `post-rewrite` hooks prepare the
active Trellage worktree and compare its source receipt with
`~/.local/share/trellage/.native-stack-sources`. A changed receipt atomically
reinstalls every retained Native backend and `trx`; an unchanged receipt skips
the reinstall. The receipt advances only after the complete Native stack succeeds,
so a partial failure is retried by the next hook. The global `trx` used from
other repositories therefore follows the most recently committed, merged, or
rewritten Trellage worktree. Uncommitted harness work remains opt-in through
`TRELLAGE_TRX_SOURCE_ROOT` and `TRELLAGE_TRX_NATIVE_SOURCE`.

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
