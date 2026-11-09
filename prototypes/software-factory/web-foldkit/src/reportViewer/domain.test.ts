import { describe, expect, test } from "vitest";
import { briefLines, briefRef, findings, joinSoftWraps, refOf, reportHtml, sections, toMdx } from "./domain";

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
`;

describe("report model", () => {
  test("findings are the ranked level-2 headings, outside code fences", () => {
    const f = findings(report);
    expect(f.map((x) => [x.rank, x.title])).toEqual([
      [1, "Make SSE line framing byte-safe"],
      [2, "Route chat by resolved model"],
    ]);
    expect(f[0]!.body).toContain("let x = { a: 1 };");
    expect(f[1]!.body).toBe("Body two.");
  });

  test("sections keep the text around the findings, in order", () => {
    expect(sections(report).map((s) => (s.kind === "text" ? s.markdown.trim().split("\n")[0] : `#${s.finding.rank}`))).toEqual([
      "# Optimization synthesis: top 3",
      "#1",
      "#2",
      "## Agreements, conflicts",
    ]);
  });

  test("toMdx wraps each finding and escapes JSX outside code", () => {
    const mdx = toMdx(report);
    expect(mdx).toContain('<Finding rank={1} title="Make SSE line framing byte-safe">');
    expect(mdx).toContain('<Finding rank={2} title="Route chat by resolved model">');
    expect(mdx).toContain("Arc&#60;Vec&#60;Value&#62;&#62;");
    expect(mdx).toContain("`Vec<u8>`");
    expect(mdx).toContain("let x = { a: 1 };");
    expect(mdx).not.toContain("rank={9}");
  });

  test("the HTML page escapes the text and keeps the table", () => {
    const html = reportHtml({ threadId: "t", folderId: "f", title: "T", path: "reports/s.md", file: "/w/reports/s.md", content: report });
    expect(html).toContain("<h2>1. Make SSE line framing byte-safe</h2>");
    expect(html).toContain("Arc&#60;Vec&#60;Value&#62;&#62;");
    expect(html).toContain("<table>");
    expect(html).not.toContain("<script");
  });
});

test("a report's brief sits next to it", () => {
  expect(briefRef("reports/synthesis.md")).toBe("reports/synthesis.brief.md");
  expect(briefRef("reports/synthesis.brief.md")).toBeNull();
  expect(briefRef("reports/data.json")).toBeNull();
});

test("brief lines stay separate without list markers", () => {
  expect(briefLines("**Found by:** x\n**Verify:** y")).toBe("**Found by:** x  \n**Verify:** y  ");
  expect(briefLines("✅ a\n🟡 b\n\n- c\n## 1. x\n```\ncode\n```")).toBe("✅ a  \n🟡 b  \n\n- c\n## 1. x\n```\ncode\n```");
});

test("report paths are found in text and links", () => {
  const code = Object.assign(document.createElement("code"), { textContent: "reports/synthesis.md" });
  const link = Object.assign(document.createElement("a"), { textContent: "the report", href: "" });
  link.setAttribute("href", "/w/reports/x.mdx");
  expect(refOf(code)).toBe("reports/synthesis.md");
  expect(refOf(link)).toBe("/w/reports/x.mdx");
  expect(refOf(Object.assign(document.createElement("code"), { textContent: "src/reports.ts" }))).toBeNull();
});

test("soft-wrapped lines join their paragraph or list item; hard breaks and blocks stay", () => {
  expect(joinSoftWraps("one\ntwo\n\n- a\n  b\n- c\n\n```\nx\ny\n```\nkeep  \nnext")).toBe("one two\n\n- a b\n- c\n\n```\nx\ny\n```\nkeep  \nnext");
});
