import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { assertCliSourcesUnchanged, caseAt, loadCliDomains, productSize } from "./exhaustive-cli-domains.ts"
import { parseGuideHeadlessArgv } from "../packages/trellage-launcher/src/guide-api.ts"

import { createGuideWorld } from "./exhaustive-guide-world.ts"
import { assertGuideJsonService } from "./exhaustive-guide-json.ts"
import { expectedGuide } from "./exhaustive-guide-oracle.ts"
import { assertGuideRequestResolution } from "./exhaustive-guide-request.ts"
import { renderArgumentForm } from "./exhaustive-argument-syntax.ts"

const { values } = parseArgs({
  options: {
    start: { type: "string", default: "0" },
    count: { type: "string" },
    output: { type: "string" },
  },
})
assert.equal(process.env.TRELLAGE_TEST_OFFLINE, "1", "run through scripts/test-offline.sh")
const { guide, sourceHashes } = await loadCliDomains()
const total = productSize(guide)
const start = BigInt(values.start!)
const count = values.count === undefined ? total - start : BigInt(values.count)
assert(start >= 0n && count > 0n && start + count <= total, "requested range is outside the declared matrix")
const end = start + count
const domainHash = createHash("sha256").update(JSON.stringify({ guide, sourceHashes })).digest("hex")
const outcomes: Record<string, number> = {}
const serviceOutcomes: Record<string, number> = {}
const world = await createGuideWorld()
const digest = createHash("sha256")
const started = Date.now()
for (let index = start; index < end; index++) {
  const selected = caseAt(guide, index)
  const argv = renderArgumentForm("guide", selected)
  const canonical = expectedGuide(selected)
  const form = selected.get("syntax")!.form
  const flags = [...selected.entries()].filter(([name]) => name.startsWith("--"))
  const lexicalRejection =
    form === "missing-value" ||
    form === "unknown-option" ||
    (form === "inline-values" && flags.some(([name, value]) => name !== "--intent" && value.argv.length > 1)) ||
    (form === "repeat-booleans" && flags.some(([, value]) => value.argv.length === 1)) ||
    (form === "repeat-values" && flags.some(([, value]) => value.argv.length > 1))
  const expected = lexicalRejection ? { error: "GuideArgsError" } : canonical
  const caseId = `${domainHash}:${index}`
  let result: ReturnType<typeof parseGuideHeadlessArgv> | undefined
  let error: unknown
  try {
    result = parseGuideHeadlessArgv(argv)
  } catch (caught) {
    error = caught
  }
  if ("error" in expected) {
    if (!(error instanceof Error))
      assert.fail(`${caseId}: expected ${expected.error}, accepted ${JSON.stringify(argv)}`)
    // Transformations can expose a lexical error before an existing validation error.
    if (form !== "canonical" && "error" in canonical)
      assert(["GuideArgsError", "GuideValidationError"].includes(error.name), caseId)
    else assert.equal(error.name, expected.error, caseId)
    outcomes[error.name] = (outcomes[error.name] ?? 0) + 1
  } else {
    assert.equal(error, undefined, caseId)
    assert.deepEqual(result, expected.result, caseId)
    assertGuideRequestResolution(result!, caseId)
    const service = await assertGuideJsonService(result!, world, caseId, argv)
    serviceOutcomes[service] = (serviceOutcomes[service] ?? 0) + 1
    outcomes.accepted = (outcomes.accepted ?? 0) + 1
  }
  digest.update(`${index}\n`)
  if ((index - start + 1n) % 100_000n === 0n)
    console.error(
      JSON.stringify({ scope: "guide-arguments", checked: (index - start + 1n).toString(), total: total.toString() }),
    )
}
await assertCliSourcesUnchanged(sourceHashes)
const report = {
  scope: "guide-arguments-only",
  complete: start === 0n && end === total,
  domainHash,
  sourceHashes,
  totalCases: total.toString(),
  start: start.toString(),
  endExclusive: end.toString(),
  executedCases: count.toString(),
  distinctTupleIds: count.toString(),
  idSequenceSha256: digest.digest("hex"),
  elapsedSeconds: (Date.now() - started) / 1000,
  outcomes,
  serviceOutcomes,
  remainingVerification: [
    "run matrix",
    "Guide services and router dispatch",
    "remaining draft domains",
    "process-sensitive behavior",
  ],
}
if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
console.log(JSON.stringify(report, null, 2))
