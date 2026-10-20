import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { adapters } from "@trellage/runtime/native-run"
import { assertCliSourcesUnchanged, loadCliDomains } from "./exhaustive-cli-domains.ts"

assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "run through scripts/test-offline.sh")
const router = await readFile(new URL("../prototypes/trellage-router/bin/trx", import.meta.url), "utf8")
const start = router.indexOf("mode=''\n")
const end = router.indexOf('command -v jq >/dev/null', start)
assert(start >= 0 && end > start, "cannot isolate root dispatch before runtime setup")
const dispatch = router.slice(start, end)
const runBranch = dispatch.split("  run)\n")[1]?.split("  --profile|")[0]
assert(runBranch, "cannot locate run dispatch")
const selectorPattern = runBranch.match(/\n      (--[^\n]+)\)\n        mode='compose-select'/)?.[1]
assert(selectorPattern, "cannot find run selector entry flags")
const selectorFlags = selectorPattern.split("|")
const knownHarnesses = Object.keys(adapters)
const help = ["-h", "--help", "help"]
const { run, sourceHashes } = await loadCliDomains()
// Dispatch reads the harness word, never the profile: the default stack plus one profile is enough.
const profiles = run.find(domain => domain.name === "profiles")!.values.filter(value => ["omitted", "base"].includes(value.id))
const flags = run.filter(domain => domain.name.startsWith("--")).map(domain => domain.name)
const prefixes = [undefined, ...new Set([...knownHarnesses, ...help, ...flags, "--resume=session-123", "unknown-harness"])]
const suffixes = [[], ["--help"], ["--", "space value", "", "*"]]
const temporary = await mkdtemp(path.join(os.tmpdir(), "trellage-dispatch-matrix-"))
const script = path.join(temporary, "dispatch.sh")
let executed = 0
const outcomes: Record<string, number> = {}
const ids = createHash("sha256")
const source = [
  "set -euo pipefail",
  'die() { printf "%s\\n" "$1" >&2; exit 1; }',
  'usage() { printf "root-help\\n"; }',
  'guide_usage() { printf "guide-help\\n"; }',
  dispatch,
  'printf "%s\\0" "$mode"',
  'case "$mode" in compose|compose-select) if ((${#compose_args[@]})); then printf "%s\\0" "${compose_args[@]}"; fi ;; esac',
].join("\n")
try {
  await writeFile(script, source)
  for (let prefixIndex = 0; prefixIndex < prefixes.length; prefixIndex++) {
    const prefix = prefixes[prefixIndex]
    for (let profileIndex = 0; profileIndex < profiles.length; profileIndex++) {
      for (let suffixIndex = 0; suffixIndex < suffixes.length; suffixIndex++) {
        const args = [...(prefix === undefined ? [] : [prefix]), ...profiles[profileIndex]!.argv, ...suffixes[suffixIndex]!]
        const first = args[0]
        const mode = first === undefined || selectorFlags.includes(first) ? "compose-select"
          : knownHarnesses.includes(first) || help.includes(first) ? "compose" : undefined
        const id = `${prefixIndex}:${profileIndex}:${suffixIndex}`
        const result = spawnSync("bash", [script, "run", ...args], { encoding: "utf8", timeout: 10_000 })
        assert.equal(result.error, undefined, id)
        assert.equal(result.signal, null, id)
        if (mode === undefined) {
          assert.equal(result.status, 1, id)
          assert.match(result.stderr, /^unknown harness:/u, id)
          assert.equal(result.stdout, "", id)
        } else {
          assert.equal(result.status, 0, `${id}: ${result.stderr}`)
          assert.equal(result.stderr, "", id)
          const forwarded = first !== undefined && help.includes(first) ? ["--help"] : args
          assert.deepEqual(result.stdout.split("\0").slice(0, -1), [mode, ...forwarded], id)
        }
        outcomes[mode ?? "rejected"] = (outcomes[mode ?? "rejected"] ?? 0) + 1
        ids.update(`${id}\n`)
        executed++
      }
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
await assertCliSourcesUnchanged(sourceHashes)
const expected = prefixes.length * profiles.length * suffixes.length
assert.equal(executed, expected)
console.log(JSON.stringify({
  scope: "run-root-dispatch-only", complete: true, expectedCases: expected, executedCases: executed,
  distinctTupleIds: executed, idSequenceSha256: ids.digest("hex"), outcomes,
  domains: { prefixes: prefixes.map(value => value ?? null), profiles, suffixes },
  sourceHashes, dispatchSourceSha256: createHash("sha256").update(dispatch).digest("hex"),
  extraction: "Exact production dispatch block before runtime setup; help renderers replaced with inert text functions. Every case runs in a fresh Bash subprocess.",
  remainingVerification: ["full run option product", "runtime setup", "profile composition and harness launch", "TTY and stdin-dependent behavior", "Guide dispatch"],
}, null, 2))
