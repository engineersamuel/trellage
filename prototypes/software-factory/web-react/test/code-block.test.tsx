import { describe, expect, test } from "bun:test"
import { StreamingMarkdownDefaultRenderer } from "@copilotkit/react-core"
import { renderToStaticMarkup } from "react-dom/server"
import { factoryMarkdownRenderer } from "../src/shared/CodeBlock"

const python = `from typing import Sequence

def binary_search(arr: Sequence[int], target: int) -> int:
    """Return the index, or -1."""
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if arr[mid] < target:
            lo = mid + 1
        else:
            return mid
    return -1
`

const render = (content: string, isStreaming = false) =>
  renderToStaticMarkup(
    <StreamingMarkdownDefaultRenderer content={content} isStreaming={isStreaming} {...factoryMarkdownRenderer} />,
  )

describe("Factory Markdown code blocks", () => {
  test.each(["python", "py", "", "unknown-language"])("highlights Python with the fence label %j", (language) => {
    const html = render(`Selected: **bs-typed**\n\n\`\`\`${language}\n${python}\`\`\`\n\nGrading basis`)
    expect(html).toContain('class="hljs-keyword"')
    expect(html).toContain('class="hljs-string"')
    expect(html).toContain("binary_search")
    expect(html).toMatch(/<strong\b[^>]*>.*<\/strong>/)
    expect(html.replace(/<[^>]+>/g, "")).toContain("Selected: bs-typed")
    expect(html.replace(/<[^>]+>/g, "")).toContain("Grading basis")
  })

  test("keeps explicitly plain text unhighlighted and escapes HTML", () => {
    const html = render('```text\n<script>alert("x")</script>\nfrom typing import Sequence\n```')
    expect(html).not.toContain("hljs-keyword")
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
    expect(html).toContain("from typing import Sequence")
  })

  test("highlights streamed code and retains whitespace and the full completed output", () => {
    const partial = render("```python\nfrom typing import Sequence\n\ndef binary_search(", true)
    expect(partial).toContain('class="hljs-keyword"')
    expect(partial).toContain("binary_search")
    const completed = render(`\`\`\`python\n${python}\`\`\``)
    expect(completed).toContain("    lo, hi")
    expect(completed).toContain("        mid")
    expect(completed).toContain("&lt; target")
    expect(completed).toContain("-1")
  })

  test("uses an explicit language when several languages could match", () => {
    const html = render('```ts\nconst selected: string = "bs-typed";\n```')
    expect(html).toContain('data-language="ts"')
    expect(html).toContain('class="hljs-keyword"')
    expect(html).toContain('class="hljs-built_in"')
  })

  test("escapes HTML inside highlighted code", () => {
    const html = render('```python\nhtml = "<img src=x onerror=alert(1)>"\n```')
    expect(html).toContain('class="hljs-string"')
    expect(html).not.toContain("<img")
    expect(html).toContain("&lt;img")
  })
})
