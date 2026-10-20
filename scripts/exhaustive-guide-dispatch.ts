import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { parseArgs } from "node:util"
import { assertCliSourcesUnchanged, caseAt, loadCliDomains, productSize, type CliDomain, type DomainValue } from "./exhaustive-cli-domains.ts"

const choice = (id: string, ...argv: string[]): DomainValue => ({ id, argv })
const omitted = choice("omitted")

export const loadGuideDispatchDomains = async () => {
  const router = await readFile(new URL("../prototypes/trellage-router/bin/trx", import.meta.url), "utf8")
  const start = router.indexOf("mode=''\n")
  const end = router.indexOf("command -v jq >/dev/null", start)
  assert(start >= 0 && end > start, "cannot isolate root dispatch before runtime setup")
  const dispatch = router.slice(start, end)
  const branch = dispatch.split("  guide)\n")[1]?.split("  models|setup|")[0]
  assert(branch, "cannot locate Guide root dispatch")
  const modeFlags = [...branch.matchAll(/        (--[a-z-]+)\)\n          \[\[ "\$[a-z_]+_seen" == false/g)].map(match => match[1]!)
  assert.deepEqual([...modeFlags].sort(), ["--engagement", "--next-steps", "--review", "--ritual"], "Guide mode registry changed; update the independent conflict oracle")
  const blockers = [...new Set([...branch.matchAll(/\n          (--[^\n]+)\)\n            die/g)]
    .flatMap(match => match[1]!.split("|")).map(flag => flag.replace(/=\*$/u, "")))]
    .filter(flag => !modeFlags.includes(flag)).sort()
  assert.deepEqual(blockers, ["--forks", "--intent", "--json", "--preview", "--profile", "--stdin", "--ui-variant"],
    "Guide conflict options changed; update the independent conflict oracle")
  const { guide, sourceHashes } = await loadCliDomains()
  const modes: CliDomain[] = modeFlags.map(flag => ({ name: flag,
    rationale: "Every router mode flag omitted, present, repeated, or given an unsupported inline value.",
    values: [omitted, choice("present", flag), choice("repeated", flag, flag), choice("inline-invalid", `${flag}=true`)] }))
  const domains: CliDomain[] = [...modes, ...blockers.map(flag => {
    const declared = guide.find(domain => domain.name === flag)?.values.find(value => value.argv.length > 0)
    return { name: flag, rationale: "Omission and canonical presence of every root-dispatch conflict option. Valued options retain their values as one group.",
      values: [omitted, choice("present", ...(declared?.argv ?? [flag]))] }
  }), { name: "help", rationale: "Omission and all three root help forms; only a sole help argument exits at root dispatch.",
    values: [omitted, choice("short", "-h"), choice("long", "--help"), choice("word", "help")] },
  { name: "order", rationale: "Forward and reversed argument groups, preserving values within their groups.",
    values: [choice("forward"), choice("reverse")] }]
  return { domains, dispatch, sourceHashes }
}

const render = (selected: ReadonlyMap<string, DomainValue>): string[] => {
  const groups = [...selected.entries()].filter(([name]) => name !== "order").map(([, value]) => value.argv)
  if (selected.get("order")!.id === "reverse") groups.reverse()
  return groups.flat()
}
const expectedDispatch = (selected: ReadonlyMap<string, DomainValue>, argv: readonly string[]): "help" | "accepted" | "rejected" => {
  if (argv.length === 1 && ["-h", "--help", "help"].includes(argv[0]!)) return "help"
  const modes = ["--review", "--ritual", "--next-steps", "--engagement"]
  if (modes.some(name => ["repeated", "inline-invalid"].includes(selected.get(name)!.id))) return "rejected"
  const present = (name: string): boolean => selected.get(name)!.argv.length > 0
  if (modes.filter(present).length > 1) return "rejected"
  const conflicts = {
    "--review": ["--json", "--preview", "--forks"],
    "--next-steps": ["--json", "--intent", "--stdin", "--preview", "--forks"],
    "--engagement": ["--json", "--profile", "--ui-variant", "--preview", "--forks"],
  }
  return Object.entries(conflicts).some(([mode, flags]) => present(mode) && flags.some(present)) ? "rejected" : "accepted"
}

// Default sample: every 61st ordinal. 61 is prime, so it is coprime to the radix-2 and radix-4 digits and
// the sample visits every value of every flag.
export const guideDispatchStride = 61n

if (import.meta.main) {
  const { values } = parseArgs({ options: { start: { type: "string", default: "0" }, count: { type: "string" }, output: { type: "string" } } })
  const sampled = values.count === undefined && values.start === "0"
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "run through scripts/test-offline.sh")
  const { domains, dispatch, sourceHashes } = await loadGuideDispatchDomains()
  const total = productSize(domains)
  const start = BigInt(values.start!)
  // Default: every 64th case (a prime-free power-of-two stride would alias the mixed-radix digits, so use 61).
  const stride = sampled ? guideDispatchStride : 1n
  const count = sampled ? (total + stride - 1n) / stride : values.count === undefined ? total - start : BigInt(values.count)
  assert(start >= 0n && count > 0n && (sampled || start + count <= total), "requested range is outside the declared matrix")
  const end = sampled ? total : start + count
  const domainHash = createHash("sha256").update(JSON.stringify({ guideDispatch: domains, sourceHashes })).digest("hex")
  const directory = await mkdtemp(path.join(os.tmpdir(), "trellage-guide-dispatch-"))
  const script = path.join(directory, "dispatch.sh")
  const source = ["set -uo pipefail", "dispatch_case() (", "set -e", 'set -- guide "$@"',
    'die() { printf "%s\\n" "$1" >&2; exit 1; }', 'usage() { printf "root-help\\n"; }',
    'guide_usage() { printf "guide-help\\n"; }', dispatch,
    'printf "%s\\0" "$mode" "$review_seen" "$ritual_seen" "$next_steps_seen" "$engagement_seen"',
    'if ((${#guide_args[@]})); then printf "%s\\0" "${guide_args[@]}"; fi', ")",
    "while IFS= read -r -d '' case_id; do", "  IFS= read -r -d '' count", "  args=()",
    '  for ((i=0; i<count; i++)); do IFS= read -r -d \'\' arg; args+=("$arg"); done',
    '  printf "CASE\\0%s\\0" "$case_id"', '  if ((count)); then dispatch_case "${args[@]}" 2>&1; else dispatch_case 2>&1; fi',
    '  printf "\\0END\\0%s\\0" "$?"', "done"].join("\n")
  const digest = createHash("sha256")
  const outcomes: Record<string, number> = {}
  const started = Date.now()
  try {
    await writeFile(script, source)
    for (let offset = 0n; offset < count; offset += 256n) {
      const batchEnd = offset + 256n < count ? offset + 256n : count
      const cases = []
      for (let step = offset; step < batchEnd; step++) {
        const index = start + step * stride
        const selected = caseAt(domains, index)
        const argv = render(selected)
        cases.push({ index, selected, argv, expected: expectedDispatch(selected, argv) })
      }
      const input = cases.map(item => [item.index.toString(), item.argv.length.toString(), ...item.argv, ""].join("\0")).join("")
      const result = spawnSync("bash", [script], { input, encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
      assert.equal(result.error, undefined, `${domainHash}:${offset}`)
      assert.equal(result.signal, null)
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stderr, "")
      let cursor = 0
      for (const item of cases) {
        const id = `${domainHash}:${item.index}`
        const prefix = `CASE\0${item.index}\0`
        assert(result.stdout.startsWith(prefix, cursor), `${id}: missing case output`)
        cursor += prefix.length
        const marker = result.stdout.indexOf("\0END\0", cursor)
        assert(marker >= cursor, `${id}: missing case status`)
        const output = result.stdout.slice(cursor, marker)
        cursor = marker + "\0END\0".length
        const terminator = result.stdout.indexOf("\0", cursor)
        assert(terminator >= cursor)
        const status = result.stdout.slice(cursor, terminator)
        cursor = terminator + 1
        if (item.expected === "rejected") {
          assert.equal(status, "1", id)
          assert.match(output, /^--(?:review|ritual|next-steps|engagement) [^\n]+\n$/u, id)
        } else {
          assert.equal(status, "0", `${id}: ${output}`)
          if (item.expected === "help") assert.equal(output, "guide-help\n", id)
          else assert.deepEqual(output.split("\0").slice(0, -1), ["guide",
            ...["--review", "--ritual", "--next-steps", "--engagement"].map(name => String(item.selected.get(name)!.argv.length > 0)),
            ...item.argv], id)
        }
        outcomes[item.expected] = (outcomes[item.expected] ?? 0) + 1
        digest.update(`${item.index}\n`)
      }
      assert.equal(cursor, result.stdout.length, "unexpected output after the final case")
      if (batchEnd % 4096n === 0n)
        console.error(JSON.stringify({ scope: "guide-root-dispatch", checked: batchEnd.toString(), total: count.toString() }))
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
  await assertCliSourcesUnchanged(sourceHashes)
  const report = { scope: "guide-root-dispatch-only", complete: !sampled && start === 0n && end === total,
    ...(sampled ? { stride: stride.toString() } : {}),
    domainHash, sourceHashes, domains, totalCases: total.toString(), start: start.toString(), endExclusive: end.toString(),
    executedCases: count.toString(), distinctTupleIds: count.toString(), idSequenceSha256: digest.digest("hex"),
    elapsedSeconds: (Date.now() - started) / 1000, outcomes,
    dispatchSourceSha256: createHash("sha256").update(dispatch).digest("hex"),
    extraction: "Exact production root dispatch in a Bash subshell for every case. Batches share a parent Bash process. Help renderers emit inert text. No runtime setup or providers execute.",
    remainingVerification: ["full Guide option product", "value-token skipping boundaries", "runtime setup", "Guide service handoff", "TTY and stdin-dependent behavior"],
  }
  if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
  console.log(JSON.stringify(report, null, 2))
}
