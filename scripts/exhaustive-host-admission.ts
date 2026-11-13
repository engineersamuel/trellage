import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { prelude, requireEnv, shellWord } from "./sh-mock.ts"

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
  const executable = path.join(directory, "headlong-init")
  const required = {
    TRELLAGE_TEST_OFFLINE: "1",
    HEADLONG_HOME: home,
    HEADLONG_APP_DIR: app,
    HEADLONG_IDENTITY_NAME: "ada",
    HEADLONG_NO_THINKERS: "1",
    HEADLONG_NO_DASH: "1",
    HEADLONG_NO_TTY: "1",
  }
  await writeFile(
    executable,
    `${prelude("Unexpected Headlong initialization request")}[ $# = 0 ] || fail
${requireEnv(required)}
printf '{"operation":"initialize","args":[]}\\n' >> ${shellWord(callsFile)}
mkdir -p ${shellWord(identity)}
`,
    { mode: 0o700 },
  )
  return {
    home,
    app,
    identity,
    executable,
    required,
    environment: {
      TRELLAGE_HEADLONG_HOME: home,
      TRELLAGE_HEADLONG_APP_DIR: app,
      TRELLAGE_HEADLONG_INIT_BIN: executable,
    },
    calls: async (): Promise<{ operation: string; args: string[] }[]> => {
      const text = await readFile(callsFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })
      return text
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    },
  }
}
