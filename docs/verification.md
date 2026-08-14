# Verification

Run deterministic repository contracts without launching paid agents:

```bash
make test
git diff --check
```

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
