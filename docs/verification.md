# Verification

Run deterministic repository contracts without launching paid agents:

```bash
make test
git diff --check
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
