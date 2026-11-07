import { expect, test } from "bun:test"
import { markdown } from "../decisions.ts"

test("code fences render as escaped pre blocks", () => {
  expect(markdown("Proof:\n```text\nPID <x>\n**no bold**\n```\nDone.")).toBe("<p>Proof:</p><pre><code>PID &#60;x&#62;\n**no bold**</code></pre><p>Done.</p>")
})

test("pipe tables render as tables", () => {
  expect(markdown("| Check | Evidence |\n|---|:--|\n| `fmt` | Exit 0 |\nAfter")).toBe(
    "<table><thead><tr><th>Check</th><th>Evidence</th></tr></thead><tbody><tr><td><code>fmt</code></td><td>Exit 0</td></tr></tbody></table><p>After</p>",
  )
})

test("a lone pipe line without a rule row stays a paragraph", () => {
  expect(markdown("a | b")).toBe("<p>a | b</p>")
})
