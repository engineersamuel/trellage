import assert from "node:assert/strict"

assert.equal(process.versions.bun, "1.3.3")
assert.equal(process.stdin.isTTY, true)
assert.equal(process.stdout.isTTY, true)
if (process.argv[2] === "source-cache") {
  console.log(JSON.stringify({ transpilerCache: process.env.BUN_RUNTIME_TRANSPILER_CACHE_PATH ?? null }))
  await import("../../src/guide-ui.tsx")
}
process.stdin.setRawMode(true)
process.stdin.resume()
console.log(JSON.stringify({ pid: process.pid }))
const report = (): void => {
  console.log(
    JSON.stringify({
      bun: process.versions.bun,
      columns: process.stdout.columns,
      rows: process.stdout.rows,
    }),
  )
}
let pending = ""
process.stdin.on("data", (data: Buffer) => {
  pending += data.toString()
  let newline: number
  while ((newline = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    if (line === "size") report()
    else if (line === "exit") process.exit(7)
    else console.log(JSON.stringify({ input: line }))
  }
  process.stdout.on("resize", report)
})
report()
