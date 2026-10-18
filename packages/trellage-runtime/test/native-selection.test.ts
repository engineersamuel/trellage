import { expect, test } from "bun:test"
import { Effect } from "effect"
import { parseTrellageConfig } from "../src/native-config.ts"

test("TOML selection metadata survives decoding on harnesses and custom profiles", async () => {
  const { native } = await Effect.runPromise(
    parseTrellageConfig(`
[native.harnesses.pi.selection]
description = "Extensible coding harness"
best_for = ["Custom tool workflows"]
[native.profiles.review.selection]
description = "Review changes"
best_for = ["Patch review"]
weaknesses = []
[native.profiles.review.guide]
document = "shipped:native/pi/default.md"
`),
  )
  expect(native.harnesses?.pi?.selection?.description).toBe("Extensible coding harness")
  expect(native.profiles.review?.selection?.best_for).toEqual(["Patch review"])
  expect(native.profiles.review?.selection?.weaknesses).toEqual([])
  expect(native.profiles.review?.guide?.document).toBe("shipped:native/pi/default.md")
})
test("bundled instruction references are portable but cannot escape their shipped root", async () => {
  const valid = await Effect.runPromise(
    parseTrellageConfig('[native.instructions.rules]\nfile="shipped:.agents/rules.md"\n'),
  )
  expect(valid.native.instructions.rules?.file).toBe("shipped:.agents/rules.md")
  for (const file of ["shipped:../secret", "shipped:/etc/passwd", "https://example.invalid/rules"])
    await expect(
      Effect.runPromise(parseTrellageConfig(`[native.instructions.rules]\nfile=${JSON.stringify(file)}\n`)),
    ).rejects.toThrow()
})

test.each(['description = ""', 'best_for = ["same", "same"]', "unknown = true"])(
  "rejects invalid authored selection: %s",
  (declaration) => {
    expect(
      Effect.runPromise(parseTrellageConfig(`[native.profiles.review.selection]\n${declaration}`)),
    ).rejects.toThrow()
  },
)
