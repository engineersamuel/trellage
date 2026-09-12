import assert from "node:assert/strict"

assert.equal(process.versions.bun, "1.3.3")
assert.equal(process.stdin.isTTY, true)
assert.equal(process.stdout.isTTY, true)
process.stdin.resume()
// One write keeps the revoked-input case independent of transport timing.
process.stdout.write("What do you want to do?\n\u001b[?2004h\u001b[?2004l")
