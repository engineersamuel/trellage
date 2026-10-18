import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** Mock Headlong initialization only; real skill synchronization and final launch construction still run. */
export const createHostAdmission = async (root: string) => {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "run through scripts/test-offline.sh")
  assert(path.isAbsolute(root))
  const home = path.join(root, "headlong")
  const app = path.join(home, "app")
  const identity = path.join(app, ".identities", "ada")
  const directory = path.join(root, "host-admission")
  await mkdir(directory, { recursive: true })
  const callsFile = path.join(directory, "calls.jsonl")
  const program = path.join(directory, "initialize.ts")
  const executable = path.join(directory, "headlong-init")
  const required = {
    TRELLAGE_TEST_OFFLINE: "1", HEADLONG_HOME: home, HEADLONG_APP_DIR: app,
    HEADLONG_IDENTITY_NAME: "ada", HEADLONG_NO_THINKERS: "1", HEADLONG_NO_DASH: "1", HEADLONG_NO_TTY: "1",
  }
  await writeFile(program, `import { appendFileSync, mkdirSync } from "node:fs"
const args = process.argv.slice(2)
const required = ${JSON.stringify(required)}
if (args.length || Object.entries(required).some(([key, value]) => process.env[key] !== value)) {
  process.stderr.write("Unexpected Headlong initialization request\\n")
  process.exit(97)
}
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ operation: "initialize", args }) + "\\n")
mkdirSync(${JSON.stringify(identity)}, { recursive: true })
`)
  await writeFile(executable, `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(program)} "$@"\n`, { mode: 0o700 })
  return {
    home, app, identity, executable, required,
    environment: { TRELLAGE_HEADLONG_HOME: home, TRELLAGE_HEADLONG_APP_DIR: app, TRELLAGE_HEADLONG_INIT_BIN: executable },
    calls: async (): Promise<{ operation: string; args: string[] }[]> => {
      const text = await readFile(callsFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })
      return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
    },
  }
}
