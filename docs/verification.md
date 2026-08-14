# Verification

Run deterministic repository contracts without launching paid agents:

```bash
make test
git diff --check
```

`make test` includes the Deja helper contract and the static sandbox memory
contract. They use fake binaries and Docker command fixtures; they do not call
a model or paid service.

When a locked profile image is available locally, run the focused no-model
noexec-tmpfs bridge regression explicitly:

```bash
DEJA_TMPFS_BRIDGE_CONTRACT=1 DEJA_TMPFS_BRIDGE_ONLY=1 \
  bash prototypes/trellage/tests/image_contract.sh
```

Check the installed native profile matrix separately:

```bash
make profile-matrix
make profile-matrix-test
```

Static matrix verification checks the exact shared Deja 0.17.0 runtime and
runs safe prepare/finalize lifecycle checks for statically passing managed Codex
homes. It does not
call a model, but can update those owner-local Deja indexes and exchange
batches. Use `make profile-matrix PROFILE_MATRIX_ARGS=--live` only when paid
model calls are intended.

Install the locked profile compiler dependencies once to install the repository
Git hooks:

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

Run exact GitHub Actions parity explicitly before high-risk pushes:

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
