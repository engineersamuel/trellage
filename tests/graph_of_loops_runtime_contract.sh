#!/usr/bin/env bash
set -euo pipefail

# Graph of Loops runtime contract tests.
# No pip install, no private venv, no network calls.
# Uses only stdlib unittest. Requires Python 3.11+.

cd "$(dirname "$0")/.."

fail() {
  printf 'graph-of-loops runtime contract: FAIL: %s\n' "$1" >&2
  exit 1
}

RUNTIME_DIR="packages/trellage-cli/assets/graph-of-loops"
TEST_MODULE="tests/fixtures/graph-of-loops/test_runtime_contracts.py"
export PYTHONDONTWRITEBYTECODE=1

[[ -d "$RUNTIME_DIR/trellage_graph" ]] \
  || fail "runtime package not found at $RUNTIME_DIR/trellage_graph"
[[ -f "$TEST_MODULE" ]] \
  || fail "test module not found at $TEST_MODULE"

# -- Verify schemas exist --
for schema in graph-plan node-envelope codex-review repository-proof; do
  [[ -f "$RUNTIME_DIR/schemas/${schema}.schema.json" ]] \
    || fail "schema missing: ${schema}.schema.json"
done

# -- Verify the Trellage-owned role prompt --
[[ -f "$RUNTIME_DIR/roles/trellage-graph-planner.md" ]] \
  || fail "role prompt missing: trellage-graph-planner.md"
[[ -f "$RUNTIME_DIR/serena_config.yml" ]] \
  || fail "locked Serena configuration is missing"

# -- Verify importable --
PYTHONPATH="$RUNTIME_DIR:${PYTHONPATH:-}" \
  python3 -c "from trellage_graph import __version__; print(f'version: {__version__}')" \
  || fail "trellage_graph is not importable"

# -- Verify bundled validator (no jsonschema pip dependency) --
PYTHONPATH="$RUNTIME_DIR:${PYTHONPATH:-}" \
  python3 -c "from trellage_graph._schema_validator import validate; print('bundled validator OK')" \
  || fail "bundled schema validator is not importable"

# -- CLI smoke: validate-plan --
PYTHONPATH="$RUNTIME_DIR:${PYTHONPATH:-}" \
  python3 -m trellage_graph validate-plan --plan tests/fixtures/graph-of-loops/valid-plan.json \
  || fail "CLI validate-plan failed on valid plan"

PYTHONPATH="$RUNTIME_DIR:${PYTHONPATH:-}" \
  python3 -m trellage_graph validate-plan --plan tests/fixtures/graph-of-loops/cycle-plan.json \
  && fail "CLI validate-plan should reject cycle plan" || true

# -- Run contract tests with stdlib unittest --
printf '\n=== Running contract tests (stdlib unittest) ===\n'
PYTHONPATH="$RUNTIME_DIR:${PYTHONPATH:-}" \
  python3 -m unittest "$TEST_MODULE" -v 2>&1 \
  || fail "contract tests failed"

printf '\ngraph-of-loops runtime contract: PASS\n'
