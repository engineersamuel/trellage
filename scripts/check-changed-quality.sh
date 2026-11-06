#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  printf 'changed quality checks: not inside a Git worktree\n' >&2
  exit 1
}
cd "$repo_root"

changed_files=()
base_ref="${QUALITY_BASE_SHA:-}"
base_commit=''
if [[ -z "$base_ref" ]] && git rev-parse --verify 'origin/main^{commit}' >/dev/null 2>&1; then
  base_ref='origin/main'
fi

if [[ -n "$base_ref" && "$base_ref" != '0000000000000000000000000000000000000000' ]]; then
  if ! git cat-file -e "$base_ref^{commit}" 2>/dev/null; then
    git fetch --no-tags --depth=1 origin "$base_ref"
  fi
  base_commit="$(git merge-base "$base_ref" HEAD)"
  while IFS= read -r -d '' file; do
    changed_files+=("$file")
  done < <(git diff --name-only -z --diff-filter=ACMR "$base_commit...HEAD")
fi

while IFS= read -r -d '' file; do
  changed_files+=("$file")
done < <(git diff --name-only -z --diff-filter=ACMR HEAD)

while IFS= read -r -d '' file; do
  changed_files+=("$file")
done < <(git ls-files --others --exclude-standard -z)

lint_files=()
format_files=()
shell_files=()
markdown_files=()
baseline_json="$(mktemp "${TMPDIR:-/tmp}/check-changed-quality-baseline.XXXXXX")"
current_json="$(mktemp "${TMPDIR:-/tmp}/check-changed-quality-current.XXXXXX")"
baseline_keys="$(mktemp "${TMPDIR:-/tmp}/check-changed-quality-baseline-keys.XXXXXX")"
current_keys="$(mktemp "${TMPDIR:-/tmp}/check-changed-quality-current-keys.XXXXXX")"
trap 'rm -f -- "$baseline_json" "$current_json" "$baseline_keys" "$current_keys"' EXIT

for file in "${changed_files[@]}"; do
  case "$file" in
    packages/*|bin/*|scripts/*)
      case "$file" in
        *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) lint_files+=("$file") ;;
      esac
      case "$file" in
        *.ts|*.tsx) format_files+=("$file") ;;
      esac
      ;;
  esac

  case "$file" in
    *.sh) shell_files+=("$file") ;;
  esac

  case "$file" in
    README.md|AGENTS.md|docs/*|packages/trellage-*/*)
      case "$file" in
        *.md|*.mdx)
          [[ "$file" == docs/goals/* ]] || markdown_files+=("$file")
          ;;
      esac
      ;;
  esac
done

if ((${#lint_files[@]})); then
  node_modules/.bin/oxlint --deny-warnings -c .eslintrc.json "${lint_files[@]}"
fi

if ((${#format_files[@]})); then
  node_modules/.bin/oxfmt --check --config .prettierrc.json "${format_files[@]}"
fi

if ((${#shell_files[@]})); then
  for file in "${shell_files[@]}"; do
    first_line=''
    IFS= read -r first_line <"$file" || :
    if [[ "$first_line" == '#!'* ]]; then
      shellcheck -- "$file"
    else
      shellcheck --shell=bash -- "$file"
    fi
  done
fi

if ((${#markdown_files[@]})); then
  typos "${markdown_files[@]}"
  for file in "${markdown_files[@]}"; do
    status=0
    rumdl check --output-format json "$file" >"$current_json" || status=$?
    if ((status > 1)); then
      printf 'rumdl failed for %s with exit code %d\n' "$file" "$status" >&2
      exit "$status"
    fi

    if [[ -n "$base_commit" ]] && git cat-file -e "$base_commit:$file" 2>/dev/null; then
      status=0
      git show "$base_commit:$file" | rumdl check --stdin --stdin-filename "$file" --output-format json >"$baseline_json" || status=$?
      if ((status > 1)); then
        printf 'rumdl baseline check failed for %s with exit code %d\n' "$file" "$status" >&2
        exit "$status"
      fi
    else
      printf '[]\n' >"$baseline_json"
    fi

    jq -r '.[] | [.rule, .message] | @tsv' "$baseline_json" | sort >"$baseline_keys"
    jq -r '.[] | [.rule, .message] | @tsv' "$current_json" | sort >"$current_keys"
    new_findings="$(comm -13 "$baseline_keys" "$current_keys")"
    if [[ -n "$new_findings" ]]; then
      printf 'new Markdown lint findings in %s:\n%s\n' "$file" "$new_findings" >&2
      exit 1
    fi
  done
fi
