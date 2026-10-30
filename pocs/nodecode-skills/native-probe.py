#!/usr/bin/env python3
"""Offline Nodecode API spike; only disposable homes are read/written.

Uses the installed binary's INTERNAL `trial` entrypoint (not a public CLI API).
No model/provider request is made. Python 3 and nodecode are required.
"""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def lisp_string(text):
    return '"' + str(text).replace('\\', '\\\\').replace('"', '\\"') + '"'


def put(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def knowledge(directory, name, entries):
    put(directory / (name + ".asd"),
        '(defsystem ' + lisp_string(name) + '\n'
        '  :class nodecode.kernel:layer :depends-on ("nodecode")\n'
        '  :properties ((:knowledge . t)) :components ())\n')
    for key, body in entries.items():
        put(directory / (key + ".lisp"),
            '(define-skill ' + key + ' "Fixture procedure"\n  ' +
            lisp_string(body) + ')\n')


def run_trial(binary, home, label, forms, expected):
    report = home / (label + ".report")
    error = home / (label + ".error")
    source = f'''(handler-case
      (let ((nlk::*cells-directory* (nlk:home "cells/")) (passed 0))
        (flet ((check (truth label)
                 (unless truth (error "failed: ~a" label))
                 (incf passed)
                 (with-open-file (s {lisp_string(report)} :direction :output
                                    :if-exists :append :if-does-not-exist :create)
                   (format s "PASS ~a~%" label))))
          {forms}
          passed))
      (error (condition)
        (with-open-file (s {lisp_string(error)} :direction :output
                           :if-exists :supersede :if-does-not-exist :create)
          (format s "~a~%" condition))
        -1))'''
    put(home / (label + ".input.lisp"), source)
    env = {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": str(home), "NODECODE_HOME": str(home),
        "XDG_CACHE_HOME": str(home / "cache"),
        "XDG_CONFIG_HOME": str(home / "config"),
        "XDG_DATA_HOME": str(home / "data"),
    }
    result = subprocess.run([binary, "trial"], input=source, text=True,
                            capture_output=True, env=env, cwd=home, timeout=90)
    if report.exists():
        print(report.read_text(), end="")
    marker = f"nodecode-trial-score {expected}"
    if result.returncode or marker not in result.stdout.splitlines():
        details = error.read_text() if error.exists() else "no detailed error"
        raise RuntimeError(f"{label}: {details}\n{result.stdout}\n{result.stderr}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nodecode", default="nodecode")
    parser.add_argument("--keep", action="store_true", help="retain disposable evidence")
    args = parser.parse_args()
    binary = shutil.which(args.nodecode)
    if not binary:
        parser.error("nodecode executable not found")
    binary = str(Path(binary).resolve())
    version = subprocess.run([binary, "--version"], capture_output=True,
                             text=True, check=True).stdout.strip()
    print(version)
    root = Path(tempfile.mkdtemp(prefix="trellage-native-probe-"))
    home = root / "home"
    home.mkdir()
    try:
        put(home / "config.jsonc", json.dumps({"update": {"mode": "off"}}))
        put(home / "AGENTS.md", "COMPOSED-INSTRUCTIONS-V1\n")
        put(home / "workspace/AGENTS.md", "PROJECT-INSTRUCTIONS\n")
        (home / "workspace/.git").mkdir()
        knowledge(home / "cells/user-memory", "user-memory",
                  {"user-note": "USER-LEARNING-KEEP"})
        put(home / "cells/user-learning/user-learning.asd",
            '(defsystem "user-learning" :class nodecode.kernel:layer '
            ':depends-on ("nodecode") :components ((:file "learned")))\n')
        put(home / "cells/user-learning/learned.lisp",
            '(in-package #:nodecode.evolved)\n'
            '(defun user-learned-fixture () "USER-FUNCTION-KEEP")\n')
        before = {p.relative_to(home): p.read_bytes()
                  for p in (home / "cells").rglob("*") if p.is_file()}
        cell_name = "trellage-knowledge"
        v1 = home / "managed/snapshots/v1" / cell_name
        v2 = home / "managed/snapshots/v2" / cell_name
        knowledge(v1, cell_name, {
            "trellage-ordinary": "ORDINARY-V1\nAsset root: " + str(v1.parent / "assets"),
            "trellage-always": "ALWAYS-V1",
            "trellage-code-looking": '(progn (error "must not execute"))\n#.(error "must not read-eval")',
        })
        knowledge(v2, cell_name, {
            "trellage-ordinary": "ORDINARY-V2\nAsset root: " + str(v2.parent / "assets"),
        })
        # Same length/mtime defeats an in-place memo invalidation shortcut. Snapshot
        # paths must distinguish the versions even within one filesystem second.
        first = v1 / "trellage-ordinary.lisp"
        second = v2 / "trellage-ordinary.lisp"
        assert first.stat().st_size == second.stat().st_size
        os.utime(second, ns=(first.stat().st_atime_ns, first.stat().st_mtime_ns))
        # Raw forms also must never execute just because a knowledge cell exists.
        def sentinel(name):
            return '(with-open-file (s ' + lisp_string(home / name) + \
                ' :direction :output :if-exists :supersede :if-does-not-exist :create)' + \
                ' (write-string "UNEXPECTED-EVALUATION" s))'
        put(v1 / "raw-code.lisp", sentinel("raw-code-executed") + '\n')
        put(v1 / "reader-eval.lisp", '#.(progn ' + sentinel("reader-eval-executed") + ' nil)\n')
        put(v1.parent / "assets/large.txt", "COMPLETE-ASSET\n" * 1000)
        put(home / "managed/private/i-have-adhd/SKILL.md", "MANUAL-ONLY-CONTENT\n")
        (home / "cells" / cell_name).symlink_to(v1, target_is_directory=True)
        run_trial(binary, home, "initial", '''
          (check (some (lambda (c) (and (string= (nlk::cell-name c) "trellage-knowledge")
                                       (eq (nlk::cell-kind c) :knowledge)
                                       (eq (nlk::cell-state c) :loaded)))
                       (nlk:cells)) "boot classifies generated cell as knowledge")
          (check (search "ORDINARY-V1" (nlk:knowledge-help-text
                    (nlk:knowledge-entry-named "trellage-ordinary" nil :data t)))
                 "selected ordinary skill readable through native knowledge API")
          (check (nlk:knowledge-entry-named "trellage-always" nil :data t)
                 "selected always fixture discoverable")
          (check (search "must not read-eval" (nlk:knowledge-help-text
                    (nlk:knowledge-entry-named "trellage-code-looking" nil :data t)))
                 "code-looking prose remains readable data")
          (check (not (probe-file (nlk:home "raw-code-executed")))
                 "raw executable form in knowledge cell never ran")
          (check (not (probe-file (nlk:home "reader-eval-executed")))
                 "raw reader-eval form never ran during knowledge indexing")
          (check (not (nlk:knowledge-entry-named "i-have-adhd" nil :data t))
                 "private manual fixture absent from knowledge discovery")
          (check (not (find-symbol "TRELLAGE-ORDINARY" :nodecode.evolved))
                 "knowledge read does not intern its name into live package")
          (check (nlk:knowledge-entry-named "user-note" nil :data t)
                 "user knowledge survives managed cell addition")
          (check (string= (user-learned-fixture) "USER-FUNCTION-KEEP")
                 "user executable learning loads alongside managed knowledge")
          (check (search "COMPOSED-INSTRUCTIONS-V1"
                         (cdr (assoc "operator-rules" (read-harness-sections nil) :test #'string=)))
                 "home AGENTS.md reaches native request section assembly")
          (nlk:write-file-atomically (nlk:home "AGENTS.md") "COMPOSED-INSTRUCTIONS-V2")
          (check (search "COMPOSED-INSTRUCTIONS-V2"
                         (cdr (assoc "operator-rules" (read-harness-sections nil) :test #'string=)))
                 "instruction edit visible on next section read")
          (nlk:write-file-atomically (nlk:home "AGENTS.md") (make-string 65537 :initial-element #\\x))
          (check (not (assoc "operator-rules" (read-harness-sections nil) :test #'string=))
                 "oversized composed instructions rejected whole")
          (delete-file (nlk:home "AGENTS.md"))
          (check (not (assoc "operator-rules" (read-harness-sections nil) :test #'string=))
                 "removed instruction file withdraws request section")
          (nlk:open-store :path (nlk:home "probe.db"))
          (nlk:create-session :id "native-probe-session" :cwd (namestring (nlk:home "workspace/")))
          (nlk:set-harness-section "native-probe-session" "user-owned" "USER-SESSION-KEEP")
          (let ((sections (read-harness-sections "native-probe-session")))
            (check (search "trellage-always" (cdr (assoc "index" sections :test #'string=)))
                   "selected skills reach actual pinned request index")
            (check (not (search "i-have-adhd" (cdr (assoc "index" sections :test #'string=))))
                   "private manual skill absent from actual pinned request index")
            (check (search "PROJECT-INSTRUCTIONS" (cdr (assoc "instructions" sections :test #'string=)))
                   "project instructions independently reach request sections"))
          (sb-posix:symlink (namestring (nlk:home "managed/snapshots/v2/trellage-knowledge/"))
                            (namestring (nlk:home "cells/next")))
          (sb-posix:rename (namestring (nlk:home "cells/next"))
                           (namestring (nlk:home "cells/trellage-knowledge")))
          (check (search "ORDINARY-V2" (nlk:knowledge-help-text
                    (nlk:knowledge-entry-named "trellage-ordinary" nil :data t)))
                 "atomic symlink retarget updates live knowledge reads")
          (check (not (nlk:knowledge-entry-named "trellage-always" nil :data t))
                 "deselected always fixture removed in same running process")
          (check (> (length (nlk:read-text (nlk:home "managed/snapshots/v1/assets/large.txt"))) 8192)
                 "previous snapshot complete asset remains readable")
          (check (search "trellage-always"
                         (cdr (assoc "index" (read-harness-sections "native-probe-session") :test #'string=)))
                 "existing conversation index stays pinned after managed deselection")
          (nlk:mark-index-refresh "native-probe-session")
          (check (not (search "trellage-always"
                         (cdr (assoc "index" (read-harness-sections "native-probe-session") :test #'string=))))
                 "explicit native index refresh removes stale managed names")
          (nlk:close-store)
        ''', 22)
        run_trial(binary, home, "restart", '''
          (nlk:open-store :path (nlk:home "probe.db"))
          (check (nlk:session-exists-p "native-probe-session")
                 "durable session survives managed reconciliation and restart")
          (check (string= "USER-SESSION-KEEP" (nlk:get-harness-section "native-probe-session" "user-owned"))
                 "user-owned durable session section preserved")
          (check (= 1 (count "trellage-knowledge" (nlk:cells) :key #'nlk::cell-name :test #'string=))
                 "relaunch has exactly one managed cell")
          (check (search "ORDINARY-V2" (nlk:knowledge-help-text
                    (nlk:knowledge-entry-named "trellage-ordinary" nil :data t)))
                 "relaunch sees updated selected ordinary skill")
          (check (not (nlk:knowledge-entry-named "trellage-always" nil :data t))
                 "relaunch retains deselection")
          (check (string= (user-learned-fixture) "USER-FUNCTION-KEEP")
                 "user executable learning survives reconciliation and restart")
          (check (nlk:knowledge-entry-named "user-note" nil :data t)
                 "user knowledge survives reconciliation and restart")
          (sb-posix:unlink (namestring (nlk:home "cells/trellage-knowledge")))
          (check (not (nlk:knowledge-entry-named "trellage-ordinary" nil :data t))
                 "removing managed registration removes live knowledge discovery")
          (check (nlk:knowledge-entry-named "user-note" nil :data t)
                 "managed removal leaves user knowledge discoverable")
          (nlk:close-store)
        ''', 9)
        run_trial(binary, home, "removed", '''
          (check (not (find "trellage-knowledge" (nlk:cells) :key #'nlk::cell-name :test #'string=))
                 "removed managed cell absent on next boot")
          (check (string= (user-learned-fixture) "USER-FUNCTION-KEEP")
                 "user executable learning remains after managed removal")
        ''', 2)
        assert all((home / path).read_bytes() == text for path, text in before.items())
        print("PASS user-owned fixture files byte-identical across all phases")
        print("PASS native probe: 34 checks; zero model calls")
    finally:
        if args.keep:
            print("Disposable evidence:", root)
        else:
            shutil.rmtree(root)


if __name__ == "__main__":
    main()
