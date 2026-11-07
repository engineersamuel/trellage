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

test("bare URLs become links that open in a new tab", () => {
  expect(markdown("PR: https://github.com/o/r/pull/54.")).toBe(
    '<p>PR: <a href="https://github.com/o/r/pull/54" target="_blank" rel="noreferrer">https://github.com/o/r/pull/54</a>.</p>',
  )
  expect(markdown("[PR](https://x.dev/1) and `https://x.dev/2`")).toBe(
    '<p><a href="https://x.dev/1" target="_blank" rel="noreferrer">PR</a> and <code>https://x.dev/2</code></p>',
  )
})
