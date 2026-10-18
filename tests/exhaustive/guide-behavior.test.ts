import { test, expect } from "bun:test"
import path from "node:path"

for (const [name, checked, accepted, rejected] of [
  ["overrides", 16_384, 8_864, 7_520],
  ["context", 920, 508, 412],
  ["fields-regression", 86, undefined, undefined],
] as const) {
  test(`JSON request ${name} preserves validation and precedence across its declared product`, async () => {
    const child = Bun.spawn(
      ["python3", "scripts/test-offline.py", "--", process.execPath, `tests/exhaustive/guide-request-${name}.ts`],
      { cwd: path.resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
    )
    const [stdout, stderr, status] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ status, stderr: status === 0 ? "" : stderr }).toEqual({ status: 0, stderr: "" })
    const result = JSON.parse(stdout)
    expect({
      status: result.status,
      checked: result.checked,
      accepted: result.accepted,
      rejected: result.rejected,
    }).toEqual({ status: "passed", checked, accepted, rejected })
  }, 30_000)
}

test("guide generation, matching, and caught model violations use audited deterministic fixtures", async () => {
  // Module mocks stay inside the child, separate from other parser and inventory tests.
  const child = Bun.spawn(
    ["python3", "scripts/test-offline.py", "--", process.execPath, "tests/exhaustive/guide-behavior-regression.ts"],
    {
      cwd: path.resolve(import.meta.dir, "../.."),
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({
    status,
    stderr: status === 0 ? "" : stderr,
    stdout: status === 0 ? "" : stdout,
  }).toEqual({ status: 0, stderr: "", stdout: "" })
  const result = JSON.parse(stdout.split("\n").find((line) => line.startsWith("{"))!)
  expect(result.status).toBe("passed")
  expect(result.caughtViolationStillFails).toBe(true)
  expect(result.results.every((entry: { status: string }) => entry.status === "passed")).toBe(true)
}, 120_000)

test("JSON stdin boundaries reject before model access and CLI intent bypasses stdin", async () => {
  const child = Bun.spawn(
    ["python3", "scripts/test-offline.py", "--", process.execPath, "tests/exhaustive/guide-stdin-regression.ts"],
    { cwd: path.resolve(import.meta.dir, "../.."), stdout: "pipe", stderr: "pipe" },
  )
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ status, stderr: status === 0 ? "" : stderr }).toEqual({ status: 0, stderr: "" })
  const result = JSON.parse(stdout.split("\n").find((line) => line.startsWith("{"))!)
  expect(result.status).toBe("passed")
  expect(result.results).toHaveLength(60)
  expect(result.processResults).toHaveLength(4)
  expect(result.results.filter((entry: { outcome: string }) => entry.outcome === "json-input-rejected")).toHaveLength(
    24,
  )
}, 120_000)
