#!/usr/bin/env bash
set -euo pipefail
root="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/fake-bin"
cat > "$fixture/fake-bin/mise" <<'MISE'
#!/usr/bin/env bash
[[ "$1" == latest ]] || exit 99
[[ "${TEST_LATEST_FAIL:-0}" == 0 ]] || exit 1
printf '1.2.3\n'
MISE
chmod +x "$fixture/fake-bin/mise"
export PATH="$fixture/fake-bin:$PATH"
for spec in omp:omp picx:picx prime:prx; do
  package="${spec%:*}"
  launcher="${spec#*:}"
  runtime="$fixture/$launcher"
  mkdir -p "$runtime/bin"
  cp "$root/prototypes/trellage-$package-profiles/bin/$launcher" "$runtime/bin/$launcher"
  cp "$root/prototypes/trellage-$package-profiles/catalog.json" "$runtime/catalog.json"
  "$runtime/bin/$launcher" harness-version > "$fixture/result.json"
  jq -e '.installed == null and .latest == "1.2.3" and .latestKnown == true' "$fixture/result.json" >/dev/null
  printf '1.2.2\n' > "$runtime/installed-version"
  TEST_LATEST_FAIL=1 "$runtime/bin/$launcher" harness-version > "$fixture/result.json"
  jq -e '.installed == "1.2.2" and .latest == null and .latestKnown == false and (.latestDiagnostic | length > 0)' "$fixture/result.json" >/dev/null
  printf '%s version reporting: OK\n' "$launcher"
done

mkdir -p "$fixture/agx/bin"
cp "$root/prototypes/trellage-agency-profiles/bin/agx" "$fixture/agx/bin/agx"
cp "$root/prototypes/trellage-agency-profiles/catalog.json" "$fixture/agx/catalog.json"
cat > "$fixture/fake-bin/agency" <<'AGENCY'
#!/usr/bin/env bash
[[ "$1" == --version ]] || exit 99
printf 'agency 1.2.3\n'
AGENCY
chmod +x "$fixture/fake-bin/agency"
"$fixture/agx/bin/agx" harness-version > "$fixture/result.json"
jq -e '.installed == "1.2.3" and .latest == null and .latestKnown == false' "$fixture/result.json" >/dev/null
printf 'agx version reporting: OK\n'
