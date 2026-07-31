#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "${ROOT}"

input="$(cat)"
file_path="$(jq -r '.tool_input.file_path // .file_path // empty' <<<"${input}")"

if [[ -z "${file_path}" ]]; then
  printf '{}\n'
  exit 0
fi

case "${file_path}" in
  /*) candidate_path="${file_path}" ;;
  *)
    while [[ "${file_path}" == ./* ]]; do
      file_path="${file_path#./}"
    done
    candidate_path="${ROOT}/${file_path}"
    ;;
esac

normalized_path=""
if normalized_dir="$(cd "$(dirname "${candidate_path}")" 2>/dev/null && pwd -P)"; then
  normalized_path="${normalized_dir}/$(basename "${candidate_path}")"
fi

repo_relative=""
if [[ "${normalized_path}" == "${ROOT}/"* ]]; then
  repo_relative="${normalized_path#"${ROOT}/"}"
fi

if [[ "${repo_relative}" == packages/trellage-cli/*.ts || "${repo_relative}" == packages/trellage-cli/**/*.ts ]]; then
  diagnostics="$("${ROOT}/packages/trellage-cli/node_modules/.bin/oxlint" -c "${ROOT}/.eslintrc.json" "${repo_relative}" 2>&1)" || {
    jq -n --arg diagnostics "${diagnostics}" '{decision: "block", reason: $diagnostics}'
    exit 0
  }
elif ! diagnostics="$(git diff --check -- "${repo_relative:-${file_path}}" 2>&1)"; then
  jq -n --arg diagnostics "${diagnostics}" '{decision: "block", reason: $diagnostics}'
  exit 0
fi

printf '{}\n'
