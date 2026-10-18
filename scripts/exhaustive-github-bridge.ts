import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

/** A fixture gh executable, never the host credential store or a network client. */
export const createGithubBridge = async (root: string, home: string, bin: string) => {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "run through scripts/test-offline.sh")
  assert(path.isAbsolute(root) && path.isAbsolute(home) && path.isAbsolute(bin))
  await mkdir(bin, { recursive: true })
  const callsFile = path.join(root, "github-bridge.jsonl")
  const program = path.join(root, "github-bridge.ts")
  const executable = path.join(bin, "gh")
  const args = ["auth", "token", "--hostname", "github.com"]
  const required = { HOME: home, TRELLAGE_TEST_OFFLINE: "1", GH_PROMPT_DISABLED: "1" }
  await writeFile(
    program,
    `import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
const required = ${JSON.stringify(required)}
if (JSON.stringify(args) !== ${JSON.stringify(JSON.stringify(args))} || Object.entries(required).some(([key, value]) => process.env[key] !== value)) {
  process.stderr.write("Unexpected fixture GitHub lookup\\n"); process.exit(97)
}
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ args }) + "\\n")
console.log("fixture-github-token")
`,
  )
  await writeFile(executable, `#!/bin/sh\nexec ${shellWord(process.execPath)} ${shellWord(program)} "$@"\n`, {
    mode: 0o700,
  })
  return {
    executable,
    args,
    required,
    calls: async (): Promise<{ args: string[] }[]> => {
      const content = await readFile(callsFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })
      return content
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    },
  }
}
