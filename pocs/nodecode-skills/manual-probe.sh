#!/usr/bin/env bash
# Offline spike: never points Nodecode at an existing home or submits a real turn.
set -euo pipefail
here=$(cd -- "$(dirname -- "$0")" && pwd)
nodecode=${NODECODE_BIN:-$(command -v nodecode)}
nodecode=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$nodecode")
root=$(mktemp -d "${TMPDIR:-/tmp}/trellage-nodecode-manual.XXXXXX")
trap 'rm -rf -- "$root"' EXIT
home="$root/home"
mkdir -p "$home/cells/nodecode-trellage-manual-spike" \
  "$home/managed-private/snapshot-1/i-have-adhd/assets" "$home/generations/old" "$root/tmp"
cp "$here/manual-bridge.lisp" "$home/cells/nodecode-trellage-manual-spike/cell.lisp"
cp "$here/manual-check.lisp" "$home/manual-check.lisp"
cat > "$home/config.jsonc" <<'JSON'
{"update":{"mode":"off"},"trellage-manual-spike":{},"experience":{"enabled":false}}
JSON
cat > "$home/cells/nodecode-trellage-manual-spike/nodecode-trellage-manual-spike.asd" <<'LISP'
(defsystem "nodecode-trellage-manual-spike"
  :depends-on ("nodecode") :components ((:file "cell")))
LISP
cat > "$home/managed-private/snapshot-1/i-have-adhd/SKILL.md" <<'MD'
---
name: i-have-adhd
description: Synthetic manual-dispatch fixture, not upstream content.
disable-model-invocation: true
---
PRIVATE_MANUAL_SENTINEL
Use assets/template.txt. The following code-looking text must remain data:
#.(with-open-file (s (nlk:home "SHOULD_NOT_EXECUTE") :direction :output) (write-line "oops" s))
MD
# A separate negative control proves that preserved frontmatter is not policy.
mkdir -p "$home/cells/manual-metadata-control"
cat > "$home/cells/manual-metadata-control/manual-metadata-control.asd" <<'LISP'
(defsystem "manual-metadata-control" :class nodecode.kernel:layer
  :depends-on ("nodecode") :properties ((:knowledge . t)) :components ())
LISP
cat > "$home/cells/manual-metadata-control/control.lisp" <<'LISP'
(define-skill manual-metadata-control "Synthetic metadata-only control"
  "---
name: manual-metadata-control
disable-model-invocation: true
user-invocable: true
---
METADATA_IS_NOT_ENFORCED")
LISP
printf 'ASSET_SENTINEL\n' > "$home/managed-private/snapshot-1/i-have-adhd/assets/template.txt"
printf 'outside\n' > "$home/outside.txt"
ln -s "$home/outside.txt" "$home/managed-private/snapshot-1/i-have-adhd/assets/link.txt"
cat > "$root/trial.lisp" <<'LISP'
(handler-case
    (progn (load (nlk:home "manual-check.lisp")) 1)
  (error (condition)
    (with-open-file (out (nlk:home "manual-error.txt") :direction :output :if-exists :supersede)
      (format out "~a~%" condition))
    0))
LISP
"$nodecode" --version
# env -i prevents ambient credentials/provider settings and home inheritance.
# trial is the installed release's internal offline evaluator, not RPC/inference.
env -i PATH="$PATH" HOME="$home" NODECODE_HOME="$home" \
  XDG_CONFIG_HOME="$root/config" XDG_CACHE_HOME="$root/cache" XDG_DATA_HOME="$root/data" \
  TMPDIR="$root/tmp" "$nodecode" trial < "$root/trial.lisp" > "$root/stdout" 2> "$root/stderr" || {
  cat "$root/stdout" "$root/stderr" >&2
  test ! -f "$home/manual-error.txt" || cat "$home/manual-error.txt" >&2
  exit 1
}
if ! test -f "$home/manual-result.txt"; then
  cat "$root/stdout" "$root/stderr" >&2
  test ! -f "$home/manual-error.txt" || cat "$home/manual-error.txt" >&2
  exit 1
fi
cat "$home/manual-result.txt"
printf '%s\n' 'No real session/store, model request, user home or upstream plugin was used.'
