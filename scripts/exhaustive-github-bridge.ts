import assert from "node:assert/strict"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

import { argsCases, prelude, requireEnv, shellWord } from "./sh-mock.ts"

/** A fixture gh executable, never the host credential store or a network client. */
export const createGithubBridge = async (root: string, home: string, bin: string) => {
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "run through scripts/test-offline.sh")
  assert(path.isAbsolute(root) && path.isAbsolute(home) && path.isAbsolute(bin))
  await mkdir(bin, { recursive: true })
  const callsFile = path.join(root, "github-bridge.jsonl")
  const executable = path.join(bin, "gh")
  const args = ["auth", "token", "--hostname", "github.com"]
  const required = { HOME: home, TRELLAGE_TEST_OFFLINE: "1", GH_PROMPT_DISABLED: "1" }
  await writeFile(
    executable,
    `${prelude("Unexpected fixture GitHub lookup")}join_args "$@"
ok=0
case "$joined" in
${argsCases([args])}
esac
[ "$ok" = 1 ] || fail
${requireEnv(required)}
printf '{"args":%s}\\n' "$(args_json "$@")" >> ${shellWord(callsFile)}
echo fixture-github-token
`,
    { mode: 0o700 },
  )
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
