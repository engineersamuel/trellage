import { expect, test } from "bun:test"
import { expectedBasket, expectedFork } from "./exhaustive-guide-previews.ts"
import { caseAt } from "./exhaustive-cli-domains.ts"
import { loadPreviewDomains, renderPreviewArguments } from "./exhaustive-preview-domains.ts"

test("fork help returns only after every preceding token has been validated", () => {
  expect(expectedFork(["--help", "unknown"])).toEqual({ help: true, variant: "tabs" })
  expect(expectedFork(["unknown", "--help"])).toBeUndefined()
  expect(expectedFork(["inline", "--help", "--forks", "tabs"])).toEqual({ help: true, variant: "inline" })
  expect(expectedFork(["tabs", "inline", "--help"])).toBeUndefined()
  expect(expectedFork(["--forks", "--forks", "--help"])).toBeUndefined()
  expect(expectedFork(["inline", "--forks"])).toEqual({ help: false, variant: "inline" })
})

test("basket help never suppresses invalid arguments or repeated preview flags", () => {
  expect(expectedBasket(["--help", "--preview=fixture"])).toBeUndefined()
  expect(expectedBasket(["--help", "--preview", "--preview"])).toBeUndefined()
  expect(expectedBasket(["--help", "--help"])).toEqual({ help: true })
  expect(expectedBasket([])).toBeUndefined()
})

test("order domain contains every group permutation and changes actual argv", async () => {
  const { fork } = await loadPreviewDomains()
  const order = fork.find(domain => domain.name === "order")!
  expect(order.values).toHaveLength(24)
  expect(new Set(order.values.map(value => value.id)).size).toBe(24)
  const selected = new Map(caseAt(fork, 0n))
  selected.set("flag", { id: "present", argv: ["--forks"] })
  selected.set("variant", { id: "inline", argv: ["inline"] })
  selected.set("help", { id: "long", argv: ["--help"] })
  selected.set("foreign", { id: "unknown", argv: ["--unknown"] })
  const rendered = order.values.map(value => {
    selected.set("order", value)
    return renderPreviewArguments(selected).join(" ")
  })
  expect(new Set(rendered).size).toBe(24)
})
