import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import {
  FIRSTMATE_MAX_RESPONSE_BYTES,
  firstmateSubmissionDigest,
  parseFirstmateFleetReadinessV1,
  parseFirstmateSubmissionReceiptV1,
  parseFirstmateSubmissionRequestV1,
  sameFirstmateFleet,
} from "@trellage/guide-core"

const [operation, requestPath, ...extra] = process.argv.slice(2)
assert.equal(extra.length, 0, "unexpected control-contract argument")
assert.ok(operation === "inventory" || operation === "receipt", "expected inventory or receipt")

const chunks: Buffer[] = []
let size = 0
for await (const chunk of process.stdin) {
  size += chunk.length
  assert.ok(size <= FIRSTMATE_MAX_RESPONSE_BYTES, "native response exceeds the guide control bound")
  chunks.push(chunk)
}
const value = JSON.parse(Buffer.concat(chunks).toString("utf8"))

if (operation === "inventory") {
  assert.equal(requestPath, undefined, "inventory does not accept a request fixture")
  assert.equal(value.launcher, "fmx")
  assert.equal(value.harness, "firstmate")
  const fleet = parseFirstmateFleetReadinessV1(value.fleet)
  if (fleet.identity !== null) assert.equal(fleet.identity.profile, value.profile)
  if (fleet.runtime === "ready") {
    assert.equal(fleet.identity?.sourceRevision, value.source.installedCommit)
    assert.equal(value.source.commitMatchesPin, true)
  }
} else {
  const receipt = parseFirstmateSubmissionReceiptV1(value)
  if (requestPath !== undefined) {
    const request = parseFirstmateSubmissionRequestV1(JSON.parse(await readFile(requestPath, "utf8")))
    assert.equal(receipt.requestId, request.requestId)
    if (receipt.state === "saved" || receipt.state === "handled") {
      assert.equal(receipt.digest, firstmateSubmissionDigest(request), "native and guide request digests differ")
      assert.ok(receipt.fleet !== null && sameFirstmateFleet(receipt.fleet, request.expectedFleet))
    }
  }
}
