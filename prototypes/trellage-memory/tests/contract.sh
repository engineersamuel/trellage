#!/usr/bin/env bash
set -euo pipefail

readonly repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd -P)"
readonly helper="${repo_root}/prototypes/trellage-memory/deja-memory"
readonly installer="${repo_root}/prototypes/trellage-memory/install-deja.sh"
readonly readme="${repo_root}/prototypes/trellage-memory/README.md"
readonly rebuild_script="${repo_root}/scripts/rebuild-profile-images.sh"
readonly contract_work="${repo_root}/prototypes/trellage-memory/.contract-work.${BASHPID:-$$}.${RANDOM}"
readonly fake_log="${contract_work}/fake-deja.log"

fail() {
  printf 'deja memory contract: FAIL: %s\n' "$1" >&2
  exit 1
}

for expected in \
  'Trellage installs one pinned Deja 0.17.0 runtime per OS user.' \
  'Manual `trx memory sync` and `trellage memory sync --profile NAME` use the same' \
  'Native launcher uninstall intentionally retains this shared runtime.' \
  '.weavekit/deja-shared'; do
  grep -Fq -- "$expected" "$readme" \
    || fail "README lacks Deja policy text: $expected"
done

awk '
  /^install_native_stack\(\) \{/ { in_native_stack = 1; next }
  in_native_stack && /refresh_shared_deja_runtime/ { refresh_line = NR }
  in_native_stack && /for pkg in/ { launcher_loop_line = NR; exit }
  END { exit !(refresh_line && launcher_loop_line && refresh_line < launcher_loop_line) }
' "$rebuild_script" \
  || fail 'rebuild script does not refresh shared Deja before native launchers'
grep -Fqx '      TRELLAGE_MEMORY=off ./install.sh' "$rebuild_script" \
  || fail 'rebuild script does not suppress duplicate native Deja refreshes'

platform() {
  case "$(uname -s):$(uname -m)" in
    Linux:aarch64|Linux:arm64) printf '%s\n' 'linux_arm64' ;;
    Linux:x86_64|Linux:amd64) printf '%s\n' 'linux_amd64' ;;
    Darwin:arm64|Darwin:aarch64) printf '%s\n' 'darwin_arm64' ;;
    Darwin:x86_64|Darwin:amd64) printf '%s\n' 'darwin_amd64' ;;
    *) fail 'unsupported test platform' ;;
  esac
}

mode() {
  if stat -c '%a' "$1" >/dev/null 2>&1; then
    stat -c '%a' "$1"
  else
    stat -f '%Lp' "$1"
  fi
}

release_sha() {
  case "$1" in
    linux_arm64) printf '%s\n' 'e6b21fdd9953b8428bd9464fc1cd6c9bbb1ad9396db31727a96903f60598b0e1' ;;
    linux_amd64) printf '%s\n' '1d176d47d3a6990dbb74a91086a6a9099fe7c3461e4d196718ef8a7d51570d78' ;;
    darwin_arm64) printf '%s\n' '17daa4e2036191ce87e41b47154785ae3b59c537fe89c1606eb476ba540799b4' ;;
    darwin_amd64) printf '%s\n' 'a45650cf5041da49cd318577ce674be919b414d6994aab5615c529df31c349b2' ;;
  esac
}

batch_count() {
  find "$1" -type f -name 'deja-sync-*.jsonl' | wc -l | tr -d '[:space:]'
}

make_fake_deja() {
  local home="$1" binary_dir

  binary_dir="${home}/.local/share/trellage/deja/0.17.0/$(platform)"
  mkdir -p "$binary_dir" "${home}/.local/state"
  chmod 700 \
    "$home" \
    "${home}/.local" \
    "${home}/.local/share" \
    "${home}/.local/share/trellage" \
    "${home}/.local/share/trellage/deja" \
    "${home}/.local/share/trellage/deja/0.17.0" \
    "$binary_dir"
  cat > "${binary_dir}/deja" <<'EOF'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "${FAKE_LOG:?}"

emit_batch() {
  local directory="$1" name="$2" payload="$3" invalid="$4"

  if [[ "$invalid" == '1' ]]; then
    printf '%s' '{"invalid":' > "${directory}/${name}"
  else
    [[ -n "$payload" ]] || payload='{"default":true}'
    printf '%s\n' "$payload" > "${directory}/${name}"
  fi
}

[[ "${FAKE_STDOUT_NOISE:-0}" != 1 ]] || printf 'deja: fake stdout noise\n'

case "$1:${2:-}" in
  index:) exit "${FAKE_INDEX_STATUS:-0}" ;;
  sync:import)
    for batch in "$3"/deja-sync-*.jsonl; do
      [[ -f "$batch" && ! -L "$batch" ]] || continue
      printf 'import batch %s %s\n' "$(basename "$batch")" "$(<"$batch")" \
        >> "${FAKE_LOG:?}"
    done
    exit "${FAKE_IMPORT_STATUS:-0}"
    ;;
  install:--auto)
    printf 'install recall %s\n' "${DEJA_RECALL-unset}" >> "${FAKE_LOG:?}"
    exit "${FAKE_INSTALL_STATUS:-0}"
    ;;
  sync:export)
    sleep "${FAKE_EXPORT_DELAY:-0}"
    name="${FAKE_EXPORT_NAME:-deja-sync-export.jsonl}"
    emit_batch "$3" "$name" "${FAKE_EXPORT_PAYLOAD:-}" \
      "${FAKE_EXPORT_INVALID:-0}"
    if [[ -n "${FAKE_EXPORT_SECOND_NAME:-}" ]]; then
      emit_batch "$3" "$FAKE_EXPORT_SECOND_NAME" \
        "${FAKE_EXPORT_SECOND_PAYLOAD:-}" "${FAKE_EXPORT_SECOND_INVALID:-0}"
    fi
    exit "${FAKE_EXPORT_STATUS:-0}"
    ;;
esac
EOF
  chmod 700 "${binary_dir}/deja"
}

make_history_deja() {
  local home="$1" binary

  make_fake_deja "$home"
  binary="${home}/.local/share/trellage/deja/0.17.0/$(platform)/deja"
  cat >"$binary" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

history="${HOME}/.deja-history"
local_records="${history}/local.jsonl"
imported_records="${history}/imported.jsonl"
indexed_records="${history}/index.jsonl"
automatic_records="${history}/automatic.jsonl"
mkdir -p "$history"
chmod 700 "$history"
printf '%s %s %s\n' "${FAKE_PROJECT:?}" "$1" "${2:-}" >>"${FAKE_LOG:?}"

append_unique() {
  local source="$1" line

  [[ -f "$source" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    grep -Fqx "$line" "$imported_records" 2>/dev/null \
      || printf '%s\n' "$line" >>"$imported_records"
  done <"$source"
}

case "$1:${2:-}" in
  sync:import)
    for batch in "$3"/deja-sync-*.jsonl; do
      [[ -f "$batch" && ! -L "$batch" ]] || continue
      append_unique "$batch"
    done
    ;;
  index:)
    {
      [[ ! -f "$local_records" ]] || cat "$local_records"
      [[ ! -f "$imported_records" ]] || cat "$imported_records"
    } | awk '!seen[$0]++' >"$indexed_records"
    ;;
  install:--auto)
    [[ "${DEJA_RECALL-}" == safe ]] || exit 92
    : >"$automatic_records"
    [[ ! -f "$indexed_records" ]] \
      || grep -F "\"project\":\"${FAKE_PROJECT}\"" "$indexed_records" \
        >"$automatic_records" || true
    ;;
  sync:export)
    [[ ! -f "$local_records" ]] \
      || cp "$local_records" "$3/deja-sync-history.jsonl"
    ;;
  mcp:recall)
    [[ "${3:-}" == --project && -n "${4:-}" && -f "$indexed_records" ]] || exit 64
    grep -F "\"project\":\"${4}\"" "$indexed_records"
    ;;
  *) exit 64 ;;
esac
EOF
  chmod 700 "$binary"
}

run_helper() {
  HOME="$current_home" PATH="${contract_work}/fake-bin:${PATH}" \
    FAKE_LOG="$fake_log" bash "$helper" "$@"
}

mkdir -p "$contract_work/homes" "$contract_work/fake-bin"
trap 'rm -rf "$contract_work"' EXIT

for value in \
  'https://github.com/vshulcz/deja-vu/releases/download/v0.17.0' \
  'deja-vu_0.17.0_linux_arm64.tar.gz' \
  'e6b21fdd9953b8428bd9464fc1cd6c9bbb1ad9396db31727a96903f60598b0e1' \
  '4364290' \
  'deja-vu_0.17.0_linux_amd64.tar.gz' \
  '1d176d47d3a6990dbb74a91086a6a9099fe7c3461e4d196718ef8a7d51570d78' \
  '4796137' \
  'deja-vu_0.17.0_darwin_arm64.tar.gz' \
  '17daa4e2036191ce87e41b47154785ae3b59c537fe89c1606eb476ba540799b4' \
  '4509436' \
  'deja-vu_0.17.0_darwin_amd64.tar.gz' \
  'a45650cf5041da49cd318577ce674be919b414d6994aab5615c529df31c349b2' \
  '4852970'; do
  grep -Fq "$value" "$installer" || fail "missing canonical artifact value: $value"
done

installer_home="${contract_work}/homes/installer"
mkdir -m 700 "$installer_home"
make_fake_deja "$installer_home"
installer_platform="${installer_home}/.local/share/trellage/deja/0.17.0/$(platform)"
printf '%s\n' "$(release_sha "$(platform)")" > "${installer_platform}/.archive-sha256"
chmod 600 "${installer_platform}/.archive-sha256"
cat > "${contract_work}/fake-bin/curl" <<'EOF'
#!/usr/bin/env bash
exit 99
EOF
chmod 700 "${contract_work}/fake-bin/curl"
cat > "${contract_work}/fake-bin/deja" <<'EOF'
#!/usr/bin/env bash
printf 'ambient binary used\n' >> "${FAKE_LOG:?}"
exit 99
EOF
chmod 700 "${contract_work}/fake-bin/deja"
HOME="$installer_home" PATH="${contract_work}/fake-bin:${PATH}" bash "$installer" >/dev/null
HOME="$installer_home" PATH="${contract_work}/fake-bin:${PATH}" bash "$installer" >/dev/null
installed_helper="${installer_home}/.local/share/trellage/deja/deja-memory"
[[ -f "$installed_helper" && ! -L "$installed_helper" && -x "$installed_helper" ]] \
  || fail 'installer did not create a regular executable helper'
[[ "$(mode "$(dirname "$installed_helper")")" == '700' ]] \
  || fail 'installer did not secure the helper directory'
HOME="$installer_home" FAKE_LOG="$fake_log" bash "$installed_helper" status \
  | grep -Fx 'memory: enabled; exchange: absent; binary: ready' >/dev/null

download_home="${contract_work}/homes/download"
download_log="${contract_work}/fake-curl.log"
mkdir -m 700 "$download_home"
cat > "${contract_work}/fake-bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

: "${FAKE_CURL_LOG:?}"
printf '%s\n' "$@" >>"$FAKE_CURL_LOG"
output=
while (($# > 0)); do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "$output" ]]
case "${FAKE_CURL_MODE:?}" in
  short) printf x >"$output" ;;
  same-size)
    case "$(uname -s):$(uname -m)" in
      Linux:aarch64|Linux:arm64) size=4364290 ;;
      Linux:x86_64|Linux:amd64) size=4796137 ;;
      Darwin:arm64|Darwin:aarch64) size=4509436 ;;
      Darwin:x86_64|Darwin:amd64) size=4852970 ;;
      *) exit 64 ;;
    esac
    python3 - "$output" "$size" <<'PY'
import pathlib
import sys

pathlib.Path(sys.argv[1]).write_bytes(b"\0" * int(sys.argv[2]))
PY
    ;;
  *) exit 64 ;;
esac
EOF
chmod 700 "${contract_work}/fake-bin/curl"
if FAKE_CURL_LOG="$download_log" FAKE_CURL_MODE=short HOME="$download_home" \
  PATH="${contract_work}/fake-bin:${PATH}" bash "$installer" \
  >"${contract_work}/download-short.out" 2>"${contract_work}/download-short.err"; then
  fail 'installer accepted a short artifact'
fi
grep -Fqx 'deja installer: download size verification failed' \
  "${contract_work}/download-short.err" \
  || fail 'short artifact did not fail size verification'
if FAKE_CURL_LOG="$download_log" FAKE_CURL_MODE=same-size HOME="$download_home" \
  PATH="${contract_work}/fake-bin:${PATH}" bash "$installer" \
  >"${contract_work}/download-digest.out" 2>"${contract_work}/download-digest.err"; then
  fail 'installer accepted an artifact with the wrong checksum'
fi
grep -Fqx 'deja installer: download checksum verification failed' \
  "${contract_work}/download-digest.err" \
  || fail 'wrong artifact checksum was accepted'
grep -Fqx "https://github.com/vshulcz/deja-vu/releases/download/v0.17.0/deja-vu_0.17.0_$(platform).tar.gz" \
  "$download_log" || fail 'installer did not request the exact pinned artifact URL'
[[ ! -e "${download_home}/.local/share/trellage/deja/0.17.0/$(platform)/deja" ]] \
  || fail 'failed artifact verification created a managed binary'

current_home="${contract_work}/homes/main"
mkdir -m 700 "$current_home"
make_fake_deja "$current_home"
: > "$fake_log"
exchange="${current_home}/.local/state/trellage/deja/exchange"

TRELLAGE_MEMORY=off HOME="$current_home" FAKE_LOG="$fake_log" bash "$helper" prepare \
  | grep -Fx 'memory: off' >/dev/null
[[ ! -e "$exchange" && ! -s "$fake_log" ]] || fail 'off mode accessed memory state'
TRELLAGE_MEMORY=off HOME=relative FAKE_LOG="$fake_log" bash "$helper" finalize \
  | grep -Fx 'memory: off' >/dev/null
TRELLAGE_MEMORY=off HOME=relative FAKE_LOG="$fake_log" bash "$helper" status \
  | grep -Fx 'memory: off' >/dev/null
if TRELLAGE_MEMORY=off HOME="$current_home" FAKE_LOG="$fake_log" \
  bash "$helper" run -- bash -c 'exit 42'; then
  fail 'off-mode wrapper accepted a failing command'
else
  [[ "$?" -eq 42 ]] || fail 'off-mode wrapper changed command status'
fi
[[ ! -e "$exchange" && ! -s "$fake_log" ]] || fail 'off mode used the binary or exchange'

stdout_probe="${contract_work}/stdout-probe"
FAKE_STDOUT_NOISE=1 run_helper prepare >"$stdout_probe" 2>/dev/null \
  || fail 'prepare failed while probing stdout'
[[ ! -s "$stdout_probe" ]] || fail 'prepare wrote Deja output to stdout'
FAKE_STDOUT_NOISE=1 run_helper finalize >"$stdout_probe" 2>/dev/null \
  || fail 'finalize failed while probing stdout'
[[ ! -s "$stdout_probe" ]] || fail 'finalize wrote Deja output to stdout'
FAKE_STDOUT_NOISE=1 run_helper run -- printf 'harness stdout\n' \
  >"$stdout_probe" 2>/dev/null \
  || fail 'run failed while probing stdout'
[[ "$(<"$stdout_probe")" == 'harness stdout' ]] \
  || fail 'run mixed Deja output into harness stdout'
: > "$fake_log"

run_helper prepare >/dev/null 2>&1
grep -Fx 'index' "$fake_log" >/dev/null || fail 'prepare did not index'
grep -F 'sync import ' "$fake_log" >/dev/null \
  || fail 'prepare did not import a private exchange snapshot'
if grep -F "sync import ${exchange}" "$fake_log" >/dev/null; then
  fail 'prepare passed unvalidated exchange entries to Deja'
fi
grep -Fx 'install --auto --no-index' "$fake_log" >/dev/null \
  || fail 'prepare did not use no-index install'
grep -Fx 'install recall safe' "$fake_log" >/dev/null \
  || fail 'prepare did not force safe automatic recall'
[[ -z "$(grep -n -F 'sync import ' "$fake_log" | head -n 1 | cut -d: -f1)" ]] \
  && fail 'prepare did not import before reindexing'
import_line="$(grep -n -F 'sync import ' "$fake_log" | head -n 1 | cut -d: -f1)"
index_line="$(grep -n -Fx 'index' "$fake_log" | tail -n 1 | cut -d: -f1)"
[[ "$import_line" -lt "$index_line" ]] \
  || fail 'prepare did not reindex after import'
! grep -Fqx 'ambient binary used' "$fake_log" \
  || fail 'prepare used an ambient Deja binary'
[[ "$(mode "$exchange")" == '700' ]] || fail 'exchange directory is not 0700'
[[ "$(mode "${current_home}/.local/state/trellage/deja/staging")" == '700' ]] \
  || fail 'staging directory is not 0700'

printf '%s' '{"bad":' > "${exchange}/deja-sync-invalid.jsonl"
: > "$fake_log"
chmod 600 "${exchange}/deja-sync-invalid.jsonl"
printf '%s\n' '{"valid":true}' > "${exchange}/deja-sync-valid.jsonl"
chmod 600 "${exchange}/deja-sync-valid.jsonl"
printf '%s\n' '[]' > "${exchange}/deja-sync-array.jsonl"
chmod 600 "${exchange}/deja-sync-array.jsonl"
printf '%s\n' '{"unsafe":true}' > "${exchange}/deja-sync-unsafe.jsonl"
chmod 644 "${exchange}/deja-sync-unsafe.jsonl"
printf '%s' '{"torn":true}' > "${exchange}/deja-sync-torn.jsonl"
chmod 600 "${exchange}/deja-sync-torn.jsonl"
printf '%s' '{"temporary":' > "${exchange}/deja-sync-temporary.jsonl.partial"
chmod 600 "${exchange}/deja-sync-temporary.jsonl.partial"
run_helper prepare >/dev/null 2>&1
grep -Fx 'import batch deja-sync-valid.jsonl {"valid":true}' "$fake_log" >/dev/null \
  || fail 'prepare did not import a valid batch'
if grep -E 'import batch .*("bad"|"unsafe"|temporary|torn|\[\])' "$fake_log" >/dev/null; then
  fail 'prepare passed malformed, unsafe, or temporary batches to Deja'
fi
[[ "$(mode "${exchange}/deja-sync-unsafe.jsonl")" == '644' ]] \
  || fail 'prepare changed an unsafe batch instead of skipping it'
run_helper prepare >/dev/null 2>&1 \
  || fail 'repeated import of valid batches was not idempotent'
[[ -f "${exchange}/deja-sync-valid.jsonl" \
  && "$(mode "${exchange}/deja-sync-valid.jsonl")" == '600' ]] \
  || fail 'idempotent import changed a valid batch'

printf '%s\n' '{"bad":' > "${exchange}/deja-sync-invalid.jsonl"
run_helper prepare >/dev/null 2>&1 || fail 'invalid JSON blocked valid batch import'
printf '%s\n' '{"linked":true}' > "${contract_work}/linked-batch"
ln -s "${contract_work}/linked-batch" "${exchange}/deja-sync-link.jsonl"
run_helper prepare >/dev/null 2>&1 || fail 'a symbolic-link batch blocked valid import'
rm -f "${exchange}"/deja-sync-*.jsonl \
  "${exchange}/deja-sync-temporary.jsonl.partial"
chmod 777 "$exchange"
[[ "$(run_helper status)" == *'exchange: unsafe'* ]] \
  || fail 'status accepted a writable exchange directory'
run_helper prepare >/dev/null
[[ "$(mode "$exchange")" == '700' ]] \
  || fail 'prepare did not secure the exchange directory'
rm -rf "${current_home}/.local/state/trellage"
mkdir -p "${current_home}/.local/state/trellage"
ln -s "${contract_work}/unsafe-target" "${current_home}/.local/state/trellage/deja"
if run_helper prepare >/dev/null 2>&1; then
  fail 'prepare accepted a symbolic-link parent'
fi
rm -rf "${current_home}/.local/state/trellage"
chmod 777 "${current_home}/.local/state"
: > "$fake_log"
if run_helper prepare >/dev/null 2>&1; then
  fail 'prepare accepted a writable exchange parent'
fi
[[ ! -s "$fake_log" ]] || fail 'prepare called Deja with a writable exchange parent'
chmod 700 "${current_home}/.local/state"

: > "$fake_log"
FAKE_EXPORT_PAYLOAD='{"batch":"same"}' FAKE_EXPORT_NAME='deja-sync-same.jsonl' \
  run_helper finalize >/dev/null
[[ "$(batch_count "$exchange")" == '1' ]] || fail 'finalize did not publish a batch'
published_batch="$(find "$exchange" -type f -name 'deja-sync-*.jsonl')"
[[ "$(mode "$published_batch")" == '600' ]] || fail 'published batch is not 0600'
if grep -F 'sync export ' "$fake_log" | grep -F -- '--full' >/dev/null; then
  fail 'finalize did not make an incremental export'
fi
FAKE_EXPORT_PAYLOAD='{"batch":"same"}' FAKE_EXPORT_NAME='deja-sync-same.jsonl' \
  run_helper finalize >/dev/null
[[ "$(batch_count "$exchange")" == '1' ]] || fail 'SHA-256 deduplication failed'

FAKE_EXPORT_INVALID=1 FAKE_EXPORT_NAME='deja-sync-invalid-export.jsonl' \
  FAKE_EXPORT_SECOND_NAME='deja-sync-valid-export.jsonl' \
  FAKE_EXPORT_SECOND_PAYLOAD='{"batch":"valid-export"}' \
  run_helper finalize >/dev/null 2>&1
[[ "$(batch_count "$exchange")" == '2' ]] \
  || fail 'an invalid exported batch blocked a valid exported batch'

rm -rf "${current_home}/.local/state/trellage"
run_helper prepare >/dev/null
printf '%s\n' '{"old":true}' > "${exchange}/deja-sync-collision.jsonl"
chmod 600 "${exchange}/deja-sync-collision.jsonl"
FAKE_EXPORT_PAYLOAD='{"new":true}' FAKE_EXPORT_NAME='deja-sync-collision.jsonl' \
  run_helper finalize >/dev/null
[[ "$(batch_count "$exchange")" == '2' ]] || fail 'collision-safe publication lost a batch'
grep -Fx '{"old":true}' "${exchange}/deja-sync-collision.jsonl" >/dev/null \
  || fail 'collision-safe publication overwrote a batch'

rm -rf "${current_home}/.local/state/trellage"
run_helper prepare >/dev/null
rm -f "${exchange}"/*
HOME="$current_home" FAKE_LOG="$fake_log" FAKE_EXPORT_PAYLOAD='{"parallel":true}' \
  FAKE_EXPORT_NAME='deja-sync-parallel.jsonl' FAKE_EXPORT_DELAY='1' \
  bash "$helper" finalize >/dev/null &
first_finalize=$!
HOME="$current_home" FAKE_LOG="$fake_log" FAKE_EXPORT_PAYLOAD='{"parallel":true}' \
  FAKE_EXPORT_NAME='deja-sync-parallel.jsonl' FAKE_EXPORT_DELAY='1' \
  bash "$helper" finalize >/dev/null &
second_finalize=$!
wait "$first_finalize" || fail 'first concurrent finalize failed'
wait "$second_finalize" || fail 'second concurrent finalize failed'
[[ "$(batch_count "$exchange")" == '1' ]] || fail 'concurrent publication was not deduplicated'

rm -rf "${current_home}/.local/state/trellage"
run_helper prepare >/dev/null
rm -f "${exchange}"/*
HOME="$current_home" FAKE_LOG="$fake_log" FAKE_EXPORT_PAYLOAD='{"parallel":1}' \
  FAKE_EXPORT_NAME='deja-sync-parallel.jsonl' FAKE_EXPORT_DELAY='1' \
  bash "$helper" finalize >/dev/null &
first_finalize=$!
HOME="$current_home" FAKE_LOG="$fake_log" FAKE_EXPORT_PAYLOAD='{"parallel":2}' \
  FAKE_EXPORT_NAME='deja-sync-parallel.jsonl' FAKE_EXPORT_DELAY='1' \
  bash "$helper" finalize >/dev/null &
second_finalize=$!
wait "$first_finalize" || fail 'first distinct concurrent finalize failed'
wait "$second_finalize" || fail 'second distinct concurrent finalize failed'
[[ "$(batch_count "$exchange")" == '2' ]] \
  || fail 'concurrent exporters lost distinct batches'

status_output="$(run_helper status)"
[[ "$status_output" != *parallel* && "$status_output" != *deja-sync-* ]] \
  || fail 'status exposed memory content'
if FAKE_INDEX_STATUS=1 run_helper run -- bash -c 'exit 37' >/dev/null 2>&1; then
  fail 'run wrapper accepted a failed harness'
else
  [[ "$?" -eq 37 ]] || fail 'run wrapper changed failed harness status'
fi
if run_helper run -- bash -c 'kill -TERM "$$"' >/dev/null 2>&1; then
  fail 'run wrapper accepted a signaled harness'
else
  [[ "$?" -eq 143 ]] || fail 'run wrapper changed harness signal status'
fi

history_state="${contract_work}/history-state"
history_a="${contract_work}/homes/history-a"
history_b="${contract_work}/homes/history-b"
history_log="${contract_work}/history-deja.log"
history_a_record='{"project":"project-a","memory":"cross-project record"}'
history_b_record='{"project":"project-b","memory":"current-project record"}'
mkdir -m 700 "$history_state" "$history_a" "$history_b"
make_history_deja "$history_a"
make_history_deja "$history_b"
mkdir -m 700 "${history_a}/.deja-history" "${history_b}/.deja-history"
printf '%s\n' "$history_a_record" >"${history_a}/.deja-history/local.jsonl"
printf '%s\n' "$history_b_record" >"${history_b}/.deja-history/local.jsonl"
chmod 600 \
  "${history_a}/.deja-history/local.jsonl" \
  "${history_b}/.deja-history/local.jsonl"
: >"$history_log"

history_run() {
  local home="$1" project="$2"
  shift 2
  HOME="$home" TRELLAGE_MEMORY_STATE_HOME="$history_state" \
    FAKE_PROJECT="$project" FAKE_LOG="$history_log" bash "$helper" "$@"
}

history_run "$history_a" project-a finalize >/dev/null \
  || fail 'project A export failed'
history_exchange="${history_state}/trellage/deja/exchange"
[[ "$(batch_count "$history_exchange")" == 1 ]] \
  || fail 'project A export did not publish one batch'
history_run "$history_b" project-b prepare >/dev/null \
  || fail 'project B import and reindex failed'
history_import_line="$(grep -n -Fx 'project-b sync import' "$history_log" | cut -d: -f1)"
history_index_line="$(grep -n -Fx 'project-b index ' "$history_log" | cut -d: -f1)"
[[ "$history_import_line" =~ ^[0-9]+$ && "$history_index_line" =~ ^[0-9]+$ \
  && "$history_import_line" -lt "$history_index_line" ]] \
  || fail 'project B did not reindex after import'
[[ "$(<"${history_b}/.deja-history/imported.jsonl")" == "$history_a_record" ]] \
  || fail 'project B did not retain the imported record'
[[ "$(<"${history_b}/.deja-history/automatic.jsonl")" == "$history_b_record" ]] \
  || fail 'safe automatic recall included another project'
history_recall="$(HOME="$history_b" FAKE_PROJECT=project-b FAKE_LOG="$history_log" \
  "${history_b}/.local/share/trellage/deja/0.17.0/$(platform)/deja" \
  mcp recall --project project-a)"
[[ "$history_recall" == "$history_a_record" ]] \
  || fail 'explicit MCP-style cross-project recall did not return project A'
history_run "$history_b" project-b prepare >/dev/null \
  || fail 'repeated project B import failed'
[[ "$(wc -l <"${history_b}/.deja-history/imported.jsonl" | tr -d '[:space:]')" == 1 ]] \
  || fail 'repeated project B import duplicated a record'
history_run "$history_b" project-b finalize >/dev/null \
  || fail 'project B export failed'
[[ "$(batch_count "$history_exchange")" == 2 ]] \
  || fail 'project B export did not add exactly one local batch'
history_b_batch="$(grep -rlFx "$history_b_record" "$history_exchange")"
[[ -n "$history_b_batch" && ! -L "$history_b_batch" ]] \
  || fail 'project B local export is unavailable'
! grep -Fqx "$history_a_record" "$history_b_batch" \
  || fail 'project B re-exported an imported record'

real_home="${contract_work}/homes/real"
profile_home="${contract_work}/homes/profile"
real_xdg="${contract_work}/real-xdg"
mkdir -m 700 "$real_home" "$profile_home" "$real_xdg"
make_fake_deja "$real_home"
TRELLAGE_REAL_HOME="$real_home" TRELLAGE_REAL_XDG_STATE_HOME="$real_xdg" \
  HOME="$profile_home" FAKE_LOG="$fake_log" bash "$helper" prepare >/dev/null
[[ -d "${real_xdg}/trellage/deja/exchange" ]] \
  || fail 'real XDG state was not selected before profile HOME'
[[ ! -e "${profile_home}/.local/state/trellage" ]] \
  || fail 'profile HOME received the shared exchange'

printf 'deja memory contract: PASS\n'
