# Verification

Run deterministic repository contracts without launching paid agents:

```bash
make test
git diff --check
```

The default publication contract is a one-time local release gate: it verifies the exact two-commit history, branch refs, identities, and absence of remotes and tags. CI uses the durable tree scan while running the same full deterministic suite because an ordinary Actions checkout has different temporary refs and a configured remote:

```bash
make test PUBLICATION_CONTRACT_ARGS=--tree-only
```

Tree-only mode skips only those point-in-time Git topology assertions. Privacy, ignored and forbidden paths, repository identity, package and license metadata, obvious-secret scans, and generic-only content checks remain mandatory.

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
