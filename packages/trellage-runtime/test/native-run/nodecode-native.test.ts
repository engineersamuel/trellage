import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { planComposition } from "../../src/native-run/compose.ts"
import { buildNodecodeSnapshot } from "../../src/native-run/nodecode-snapshot.ts"
import { digestDirectory } from "../../src/native-run/source.ts"

// Native trial is a version-specific offline test seam, not a launch dependency.
// This test never submits a real turn, copies credentials or visits a user home.
test.skipIf(!process.env.NODECODE_BIN)(
  "production Nodecode cells discover only ordinary skills and dispatch selected manual skills as data",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nodecode-production-cells-"))
    try {
      const source = path.join(root, "source")
      const home = path.join(root, "home")
      const owner = path.join(root, "owner")
      await mkdir(owner)
      for (const [name, text] of [
        [
          "office",
          '---\nname: office\n---\nORDINARY_SENTINEL\nQuotes: "hello", backslash: \\, Unicode: λ\n#.(error "must not execute")',
        ],
        ["i-have-adhd", '---\ndisable-model-invocation: true\n---\nPRIVATE_SENTINEL\n#.(error "must not execute")'],
      ]) {
        await mkdir(path.join(source, name!, "assets"), { recursive: true })
        await writeFile(path.join(source, name!, "SKILL.md"), text!)
        await writeFile(path.join(source, name!, "assets", "template.txt"), "ASSET_SENTINEL")
      }
      const plan = await planComposition(
        {
          harness: "nodecode",
          profiles: ["office"],
          catalog: {
            sources: { fixture: { repository: "example/fixture", alwaysOn: true } },
            instructions: {},
            profiles: {
              office: {
                always: false,
                instructions: [],
                plugins: [],
                skills: [{ source: "fixture", names: ["office", "i-have-adhd"] }],
              },
            },
          },
          adapterPolicy: "test",
          providerPolicy: "offline",
          instructionTexts: {},
        },
        {
          resolver: {
            resolve: async (sourceId, policy) => ({
              sourceId,
              repository: policy.repository,
              selector: { kind: "default" },
              commit: "a".repeat(40),
              directory: source,
              digest: await digestDirectory(source),
            }),
            markGood: async () => {},
          },
        },
      )
      const snapshot = await buildNodecodeSnapshot(owner, plan)
      await mkdir(path.join(home, "cells"), { recursive: true })
      await writeFile(path.join(home, "config.jsonc"), '{"update":{"mode":"off"},"experience":{"enabled":false}}')
      for (const name of ["trellage-knowledge", "nodecode-trellage-manual"])
        await symlink(path.join(snapshot.directory, name), path.join(home, "cells", name))
      await cp(path.join(snapshot.directory, "instructions.md"), path.join(home, "AGENTS.md"))
      await writeFile(path.join(root, "outside.txt"), "outside")
      // Deliberately tamper after verified publication to test runtime realpath containment.
      await symlink(
        path.join(root, "outside.txt"),
        path.join(snapshot.directory, "private", "i-have-adhd", "assets", "escape"),
      )
      await rm(source, { recursive: true })
      const trial = spawnSync(await realpath(process.env.NODECODE_BIN!), ["trial"], {
        cwd: home,
        encoding: "utf8",
        timeout: 90000,
        env: {
          PATH: process.env.PATH,
          LANG: "en_US.UTF-8",
          HOME: home,
          NODECODE_HOME: home,
          XDG_CONFIG_HOME: path.join(root, "config"),
          XDG_DATA_HOME: path.join(root, "data"),
          XDG_CACHE_HOME: path.join(root, "cache"),
        },
        input: String.raw`(handler-case
  (let ((nlk::*cells-directory* (nlk:home "cells/"))
        (config (nle:read-shared-config)) (captured nil) (checks 0))
    (labels ((check (condition) (assert condition) (incf checks))
             (refuses (thunk) (handler-case (progn (funcall thunk) nil) (error () t))))
      (let* ((entry (nlk:knowledge-entry-named "trellage-office" nil :data t))
             (text (and entry (nlk:knowledge-help-text entry))))
        (check (and text (search "ORDINARY_SENTINEL" text)))
        (check (search "must not execute" text))
        (check (search "Managed asset directory:" text)))
      (check (not (nlk:knowledge-entry-named "trellage-i-have-adhd" nil :data t)))
      (check (not (search "PRIVATE_SENTINEL" (help))))
      (let ((rules (cdr (assoc "operator-rules" (nle::read-harness-sections nil) :test #'string=))))
        (check (and rules (search "ORDINARY_SENTINEL" rules)))
        (check (not (search "PRIVATE_SENTINEL" rules))))
      ;; No trellage-manual config section exists: native default starts it.
      (nodecode-trellage-manual:start-cell config)
      (check (nle::find-registered-command "trx-skill"))
      (check (not (find "trx-skill" nle::*tools* :key #'first :test #'equal)))
      (nodecode-trellage-manual:start-cell config)
      (check (= 1 (count "trx-skill" nle::*registered-commands* :key #'nle::slash-command-name :test #'equal)))
      (nle:hook 'nle:submit "trellage-production-test"
        (lambda (next session prompt &rest keys)
          (declare (ignore next)) (push (list session prompt keys) captured) :captured))
      (unwind-protect
        (progn
          (check (search "Submitted" (nle:slash "/trx-skill i-have-adhd help me plan" :session-id "offline-test")))
          (check (= 1 (length captured)))
          (check (equal "offline-test" (first (first captured))))
          (check (search "PRIVATE_SENTINEL" (second (first captured))))
          (check (search "help me plan" (second (first captured))))
          (check (equal "trellage-manual-skill" (getf (third (first captured)) :source)))
          (check (equal "i-have-adhd" (getf (third (first captured)) :source-id)))
          (check (search "not selected" (nle:slash "/trx-skill office request" :session-id "offline-test")))
          (check (search "not selected" (nle:slash "/trx-skill absent request" :session-id "offline-test")))
          (check (search "not selected" (nle:slash "/trx-skill ../escape request" :session-id "offline-test")))
          (check (search "Usage" (nle:slash "/trx-skill i-have-adhd" :session-id "offline-test")))
          (check (= 1 (length captured)))
          (check (equal "ASSET_SENTINEL" (uiop:read-file-string
            (nodecode-trellage-manual::asset-path "i-have-adhd" "assets/template.txt"))))
          (dolist (relative '("../outside.txt" "/tmp/outside.txt" "assets/../../outside.txt" "assets/escape"))
            (check (refuses (lambda () (nodecode-trellage-manual::asset-path "i-have-adhd" relative)))))
          (check (not (search "PRIVATE_SENTINEL" (help))))
          (nodecode-trellage-manual::stop-cell)
          (nodecode-trellage-manual::stop-cell)
          (check (not (nle::find-registered-command "trx-skill")))
          (let ((disabled (nlk:decode-json "{\"trellage-manual\":{\"enabled\":false}}")))
            (nodecode-trellage-manual:start-cell disabled)
            (check (not (nle::find-registered-command "trx-skill"))))
          ;; Eval can call SLASH too: discovery isolation is not authorization.
          (nodecode-trellage-manual:start-cell config)
          (check (search "Submitted" (eval '(nle:slash "/trx-skill i-have-adhd eval can invoke this" :session-id "offline-test"))))
          (check (= 2 (length captured)))
          (format t "PRODUCTION_NATIVE_CHECKS=~d~%" checks)
          1)
        (nle:unhook 'nle:submit "trellage-production-test"))))
  (error (condition) (format t "TRIAL ERROR: ~a~%" condition) -1))`,
      })
      if (trial.status !== 0 || !trial.stdout.includes("nodecode-trial-score 1"))
        throw new Error(`Native trial failed: ${trial.error ?? trial.status}\n${trial.stdout}\n${trial.stderr}`)
      expect(trial.stdout.split(/\r?\n/)).toContain("nodecode-trial-score 1")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  100000,
)
