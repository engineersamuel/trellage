import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { BasketPreviewArgsError, parseBasketPreviewArgv } from "../packages/trellage-launcher/src/basket-preview.tsx"
import { ForkPreviewArgsError, forkPreviewVariants, parseForkPreviewArgv } from "../packages/trellage-launcher/src/fork-preview.tsx"
import { caseAt, productSize } from "./exhaustive-cli-domains.ts"
import { assertPreviewSourcesUnchanged, loadPreviewDomains, renderPreviewArguments } from "./exhaustive-preview-domains.ts"

const helpAliases = new Set(["--help", "-h"])
export const expectedBasket = (argv: readonly string[]): { help: boolean } | undefined => {
  const help = argv.some(token => helpAliases.has(token))
  const options = argv.filter(token => !helpAliases.has(token))
  return options.every(token => token === "--preview") && options.length <= 1 && (help || options.length === 1)
    ? { help } : undefined
}
export const expectedFork = (argv: readonly string[]): { help: boolean; variant: string } | undefined => {
  const helpIndex = argv.findIndex(token => helpAliases.has(token))
  const effective = helpIndex === -1 ? argv : argv.slice(0, helpIndex)
  const flags = effective.filter(token => token === "--forks")
  const variants = effective.filter(token => forkPreviewVariants.some(variant => variant === token))
  if (flags.length + variants.length !== effective.length || flags.length > 1 || variants.length > 1 ||
    (helpIndex === -1 && flags.length !== 1)) return undefined
  return { help: helpIndex !== -1, variant: variants[0] ?? "tabs" }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { command: { type: "string" }, start: { type: "string", default: "0" },
    count: { type: "string" }, output: { type: "string" } } })
  assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "run through scripts/test-offline.sh")
  assert(values.command === "basket" || values.command === "fork", "--command must be basket or fork")
  const command = values.command
  const { [command]: domains, sourceHashes } = await loadPreviewDomains()
  const total = productSize(domains)
  const start = BigInt(values.start!)
  const count = values.count === undefined ? total - start : BigInt(values.count)
  assert(start >= 0n && count > 0n && start + count <= total, "requested range is outside the declared matrix")
  const end = start + count
  const domainHash = createHash("sha256").update(JSON.stringify({ [command]: domains, sourceHashes })).digest("hex")
  const outcomes: Record<string, number> = {}
  const digest = createHash("sha256")
  const started = Date.now()
  for (let index = start; index < end; index++) {
    const argv = renderPreviewArguments(caseAt(domains, index))
    const expected = command === "basket" ? expectedBasket(argv) : expectedFork(argv)
    let result: unknown
    let error: unknown
    try { result = command === "basket" ? parseBasketPreviewArgv(argv) : parseForkPreviewArgv(argv) }
    catch (caught) { error = caught }
    const caseId = `${domainHash}:${index}`
    if (expected === undefined) {
      assert(error instanceof (command === "basket" ? BasketPreviewArgsError : ForkPreviewArgsError), caseId)
      outcomes.rejected = (outcomes.rejected ?? 0) + 1
    } else {
      assert.equal(error, undefined, caseId)
      assert.deepEqual(result, expected, caseId)
      outcomes.accepted = (outcomes.accepted ?? 0) + 1
    }
    digest.update(`${index}\n`)
  }
  await assertPreviewSourcesUnchanged(sourceHashes)
  const report = { scope: `${command}-preview-arguments-only`, complete: start === 0n && end === total,
    domainHash, sourceHashes, domains, totalCases: total.toString(), start: start.toString(), endExclusive: end.toString(),
    executedCases: count.toString(), distinctTupleIds: count.toString(), idSequenceSha256: digest.digest("hex"),
    elapsedSeconds: (Date.now() - started) / 1000, outcomes,
    remainingVerification: ["ordinary Guide option Cartesian product with preview modes", "router dispatch", "TTY and UI behavior"],
  }
  if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
  console.log(JSON.stringify(report, null, 2))
}
