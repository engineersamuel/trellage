import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { planComposition } from "../../packages/trellage-runtime/src/native-run/compose.ts"
import { digestDirectory } from "../../packages/trellage-runtime/src/native-run/source.ts"
import { publishSnapshot } from "./snapshot.ts"

// Explicit opt-in; the installed native binary is not a workspace dependency.
test.skipIf(!process.env.NODECODE_BIN)(
  "canonical snapshot loads as native knowledge without exposing manual prose",
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "nodecode-integration-spike-"))
    try {
      const source = path.join(root, "source")
      const home = path.join(root, "home")
      const body =
        'ORDINARY_INTEGRATION_SENTINEL\nQuotes: "hello"; backslash: \\; Unicode: λ\n#.(error "must not execute")\n'
      for (const [name, text] of [
        ["office", body],
        ["i-have-adhd", "---\ndisable-model-invocation: true\n---\nPRIVATE_INTEGRATION_SENTINEL"],
      ]) {
        await mkdir(path.join(source, name!), { recursive: true })
        await writeFile(path.join(source, name!, "SKILL.md"), text!)
      }
      const plan = await planComposition(
        {
          harness: "nodecode",
          profiles: ["office"],
          catalog: {
            sources: { fixture: { repository: "example/fixture" } },
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
          adapterPolicy: "spike-1",
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
      const snapshot = await publishSnapshot(path.join(root, "owner"), plan)
      await mkdir(path.join(home, "cells"), { recursive: true })
      await writeFile(path.join(home, "config.jsonc"), '{"update":{"mode":"off"},"experience":{"enabled":false}}')
      await symlink(path.join(snapshot.directory, "trellage-knowledge"), path.join(home, "cells", "trellage-knowledge"))
      // Delete the source to ensure every native reference targets the durable snapshot.
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
        input: `(handler-case (let ((nlk::*cells-directory* (nlk:home "cells/")))
        (let* ((entry (nlk:knowledge-entry-named "trellage-office" nil :data t))
               (text (and entry (nlk:knowledge-help-text entry))))
          (assert (and text (search "ORDINARY_INTEGRATION_SENTINEL" text)))
          (assert (search "must not execute" text))
          (assert (search "Managed asset directory:" text))
          (assert (not (nlk:knowledge-entry-named "trellage-i-have-adhd" nil :data t)))
          (assert (not (search "PRIVATE_INTEGRATION_SENTINEL" (help))))
          5)) (error (condition) (format t "TRIAL ERROR: ~a~%" condition) -1))`,
      })
      if (trial.status !== 0 || !trial.stdout.includes("nodecode-trial-score 5"))
        throw new Error(`Native trial failed: ${trial.error ?? trial.status}\n${trial.stdout}\n${trial.stderr}`)
      expect(trial.stdout.split(/\r?\n/)).toContain("nodecode-trial-score 5")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  100000,
)
