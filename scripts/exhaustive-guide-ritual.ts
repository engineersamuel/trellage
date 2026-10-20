import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { GuideHeadlessArgs } from "../packages/trellage-launcher/src/guide-api.ts"
import { shippedRituals } from "../packages/trellage-launcher/src/ritual-catalog.ts"

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
export const assertGuideRitualProcess = async (args: GuideHeadlessArgs, argv: readonly string[], id: string) => {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "use scripts/test-offline.sh")
  assert(process.platform === "darwin" || process.platform === "linux", "ritual process fixture requires POSIX")
  assert(args.ritual && argv.length > 0, id)
  const root = await mkdtemp(path.join(os.tmpdir(), "trellage-ritual-process-"))
  try {
    const bin = path.join(root, "bin"),
      home = path.join(root, "home")
    await mkdir(bin)
    await mkdir(home)
    const clipboard = path.join(root, "clipboard"),
      calls = path.join(root, "calls.jsonl")
    const mock = path.join(root, "clipboard.ts")
    await writeFile(
      mock,
      `import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
const command = process.argv[2], args = process.argv.slice(3)
appendFileSync(process.env.FIXTURE_CLIPBOARD_CALLS!, JSON.stringify({command,args})+"\\n")
const write = command === "pbcopy" || command === "wl-copy"
const expected = command === "wl-paste" ? ["--no-newline"] : []
if (!["pbcopy","pbpaste","wl-copy","wl-paste"].includes(command!) || JSON.stringify(args)!==JSON.stringify(expected)) process.exit(97)
if (write) writeFileSync(process.env.FIXTURE_CLIPBOARD_FILE!, readFileSync(0))
else process.stdout.write(readFileSync(process.env.FIXTURE_CLIPBOARD_FILE!))
`,
    )
    for (const command of ["pbcopy", "pbpaste", "wl-copy", "wl-paste"])
      await writeFile(
        path.join(bin, command),
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(mock)} ${quote(command)} "$@"\n`,
        { mode: 0o700 },
      )
    const command = [
      process.execPath,
      "--no-install",
      "--no-env-file",
      fileURLToPath(new URL("../packages/trellage-launcher/src/cli.tsx", import.meta.url)),
      "guide",
      fileURLToPath(new URL("../profile-guides", import.meta.url)),
      path.join(root, "prompt-master"),
      ...argv,
    ]
    const environment = {
      HOME: home,
      PATH: bin,
      TRELLAGE_ENVIRONMENT: "off",
      TRELLAGE_TEST_OFFLINE: "1",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      FIXTURE_CLIPBOARD_FILE: clipboard,
      FIXTURE_CLIPBOARD_CALLS: calls,
      TERM: "xterm-256color",
      NO_COLOR: "1",
    }
    const interactive = !args.ritualPrint && !args.ritualCopy
    const requested = shippedRituals.find((ritual) => ritual.id === args.ritualId)
    const selected = requested ?? shippedRituals[0]!
    const result = interactive
      ? spawnSync("python3", ["-I", fileURLToPath(new URL("./exhaustive-terminal.py", import.meta.url))], {
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          input: JSON.stringify({
            command,
            cwd: root,
            env: environment,
            steps: [
              {
                wait: [
                  "Prompt library",
                  selected.title,
                  "Enter copy",
                  ...(args.ritualId !== undefined && requested === undefined
                    ? [`No prompt named ${args.ritualId}.`]
                    : []),
                ],
                keys: "v",
              },
              { wait: [selected.prompt.split("\n")[0]!], keys: "\r" },
              { wait: ["Copied. Paste it into the current agent."], keys: "q" },
            ],
          }),
        })
      : spawnSync(command[0]!, command.slice(1), {
          cwd: root,
          encoding: "utf8",
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          env: environment,
        })
    assert.equal(result.error, undefined, id)
    assert.equal(result.signal, null, `${id}: ${result.stderr}`)
    const ritual = interactive ? selected : requested
    const recorded = await readFile(calls, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return ""
      throw error
    })
    if (ritual === undefined) {
      assert.equal(result.status, 2, id)
      assert.equal(result.stdout, "", id)
      assert.equal(result.stderr, `trellage-launcher: No prompt named ${args.ritualId}.\n`, id)
      assert.equal(recorded, "", id)
      return "unknown-ritual" as const
    }
    assert.equal(result.status, 0, `${id}: ${result.stderr}`)
    assert.equal(result.stderr, "", id)
    if (args.ritualPrint) {
      assert.equal(result.stdout, ritual.prompt.endsWith("\n") ? ritual.prompt : `${ritual.prompt}\n`, id)
      assert.equal(recorded, "", id)
      return "ritual-print" as const
    }
    if (interactive) assert.deepEqual(JSON.parse(result.stdout), { exitCode: 0, stepsCompleted: 3 }, id)
    else assert.equal(result.stdout, "Copied. Paste it into the current agent.\n", id)
    assert.equal(await readFile(clipboard, "utf8"), ritual.prompt, id)
    assert.deepEqual(
      recorded
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      process.platform === "darwin"
        ? [
            { command: "pbcopy", args: [] },
            { command: "pbpaste", args: [] },
          ]
        : [
            { command: "wl-copy", args: [] },
            { command: "wl-paste", args: ["--no-newline"] },
          ],
      id,
    )
    return interactive ? ("ritual-ui" as const) : ("ritual-copy" as const)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
