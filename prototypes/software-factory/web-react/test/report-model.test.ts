import { describe, expect, test } from "bun:test"
import { evaluate } from "@mdx-js/mdx"
import { createElement, Fragment } from "react"
import * as runtime from "react/jsx-runtime"
import { renderToStaticMarkup } from "react-dom/server"
import { findings, toMdx } from "../src/shared/report-model"

const report = `# Optimization synthesis: top 3

Intro with Arc<Vec<Value>> and {braces}.

## 1. Make SSE line framing byte-safe

**Found by:** behavior lens. Uses \`Vec<u8>\`.

\`\`\`rust
## 9. not a heading
let x = { a: 1 };
\`\`\`

## 2) Route chat by resolved model

Body two.

## Agreements, conflicts

| a | b |
| - | - |
| x | y |
`

describe("report model", () => {
  test("findings are the ranked level-2 headings, outside code fences", () => {
    const f = findings(report)
    expect(f.map((x) => [x.rank, x.title])).toEqual([
      [1, "Make SSE line framing byte-safe"],
      [2, "Route chat by resolved model"],
    ])
    expect(f[0]!.body).toContain("let x = { a: 1 };")
    expect(f[1]!.body).toBe("Body two.")
  })

  test("toMdx compiles as MDX and wraps each finding in a Finding component", async () => {
    const mdx = toMdx(report)
    expect(mdx).toContain('<Finding rank={1} title="Make SSE line framing byte-safe">')
    expect(mdx).toContain("Arc&#60;Vec&#60;Value&#62;&#62;")
    expect(mdx).toContain("`Vec<u8>`")
    const { default: Content } = await evaluate(mdx, { ...(runtime as any), Fragment })
    const Finding = ({ rank, title, children }: any) => createElement("section", { "data-rank": rank, title }, children)
    const html = renderToStaticMarkup(createElement(Content, { components: { Finding } }))
    expect(html).toContain('<section data-rank="1" title="Make SSE line framing byte-safe">')
    expect(html).toContain('<section data-rank="2" title="Route chat by resolved model">')
    expect(html).toContain("Arc&lt;Vec&lt;Value&gt;&gt; and {braces}")
    expect(html).toContain("<code>Vec&lt;u8&gt;</code>")
    expect(html).toContain("let x = { a: 1 };")
    expect(html).not.toContain('data-rank="9"')
  })
})

test("a report's brief sits next to it", async () => {
  const { briefRef } = await import("../src/shared/ReportViewer")
  expect(briefRef("reports/synthesis.md")).toBe("reports/synthesis.brief.md")
  expect(briefRef("reports/synthesis.brief.md")).toBeNull()
  expect(briefRef("reports/data.json")).toBeNull()
})

test("brief lines stay separate without list markers", async () => {
  const { briefLines } = await import("../src/shared/ReportViewer")
  expect(briefLines("**Found by:** x\n**Verify:** y")).toBe("**Found by:** x  \n**Verify:** y  ")
  expect(briefLines("✅ a\n🟡 b\n\n- c\n## 1. x\n```\ncode\n```")).toBe("✅ a  \n🟡 b  \n\n- c\n## 1. x\n```\ncode\n```")
})
