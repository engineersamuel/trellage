// The report viewer's data: a saved Markdown report (GET /api/reports) and its ranked findings.
// Pure helpers, ported from the old React viewer (web-react/src/shared/report-model.ts and ReportViewer.tsx).
import { Schema } from "effect";
import { AsyncData } from "foldkit";
import { markdown } from "../../../shared/decisions";
import { Report } from "../../../shared/schemas";

export type { Report } from "../../../shared/schemas";

export const ReportAsyncData = AsyncData.Schema(Report, Schema.String);

/** A ranked finding: a `## <rank>. <title>` heading and the text up to the next level-2 heading. */
export const Finding = Schema.Struct({ rank: Schema.Number, title: Schema.String, body: Schema.String });
export type Finding = typeof Finding.Type;

const FINDING = /^##\s+(\d+)[.)]\s+(.+?)\s*$/;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^#{1,2}\s/;

/** One piece of a report: Markdown text, or a ranked finding with its body. */
export type Section = { kind: "text"; markdown: string } | { kind: "finding"; finding: Finding };

/** The report split into text and ranked findings, in order. Headings inside code fences do not count. */
export const sections = (md: string): ReadonlyArray<Section> => {
  const out: Section[] = [];
  let text: string[] = [];
  let finding: { rank: number; title: string; lines: string[] } | null = null;
  let fence = false;
  const flush = () => {
    if (finding) out.push({ kind: "finding", finding: { rank: finding.rank, title: finding.title, body: finding.lines.join("\n").trim() } });
    else if (text.join("").trim()) out.push({ kind: "text", markdown: text.join("\n") });
    finding = null;
    text = [];
  };
  for (const line of md.split("\n")) {
    if (FENCE.test(line)) fence = !fence;
    const m = fence ? null : FINDING.exec(line);
    if (m) {
      flush();
      finding = { rank: Number(m[1]), title: m[2]!, lines: [] };
    } else if (!fence && HEADING.test(line) && finding) {
      flush();
      text.push(line);
    } else if (finding) finding.lines.push(line);
    else text.push(line);
  }
  flush();
  return out;
};

export const findings = (md: string): ReadonlyArray<Finding> =>
  sections(md).flatMap((s) => (s.kind === "finding" ? [s.finding] : []));

/** Escape what MDX reads as JSX or expressions, outside code spans and fences. */
const escapeProse = (line: string): string =>
  line
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : part.replace(/[{}<>]/g, (c) => `&#${c.charCodeAt(0)};`)))
    .join("");

/** The report as an MDX document: each ranked finding becomes a `<Finding>` component. Everything else stays Markdown. */
export const toMdx = (md: string): string => {
  const out: string[] = [];
  let fence = false;
  let open = false;
  const close = () => open && (out.push("", "</Finding>", ""), (open = false));
  for (const line of md.split("\n")) {
    if (FENCE.test(line)) {
      fence = !fence;
      out.push(line);
      continue;
    }
    if (fence) {
      out.push(line);
      continue;
    }
    const m = FINDING.exec(line);
    if (m) {
      close();
      out.push(`<Finding rank={${Number(m[1])}} title=${JSON.stringify(m[2]!)}>`, "");
      open = true;
    } else if (HEADING.test(line)) (close(), out.push(escapeProse(line)));
    else out.push(escapeProse(line));
  }
  close();
  return out.join("\n");
};

/** A brief is one item per line; keep each line on its own even when the writer left out the "- ". */
export const briefLines = (md: string): string => {
  let fence = false;
  return md
    .split("\n")
    .map((l) => {
      if (FENCE.test(l)) return (fence = !fence), l;
      return fence || !l.trim() || /^\s*([-*+]\s|\d+[.)]\s|#|\||>)/.test(l) ? l : `${l}  `;
    })
    .join("\n");
};

/** The brief that sits next to a report: reports/synthesis.md → reports/synthesis.brief.md. */
export const briefRef = (p: string): string | null => (/\.brief\.md$/.test(p) || !/\.md$/.test(p) ? null : p.replace(/\.md$/, ".brief.md"));

/** A text that names a saved report: `reports/x.md`, or an absolute path ending in .md/.mdx. */
export const REPORT_REF = /^(?:\/[^\s`'"]+\/)?reports\/[\w.-]+\.mdx?$/;

const BLOCK_START = /^\s*([-*+]\s|\d+[.)]\s|#|\||>|```|~~~)/;
const LIST_ITEM = /^\s*([-*+]\s|\d+[.)]\s)/;

/**
 * Join soft-wrapped lines into their paragraph or list item, as Markdown does. A line that ends in two spaces is a
 * hard break (a brief's lines), so the next line stays on its own.
 */
export const joinSoftWraps = (md: string): string => {
  const out: string[] = [];
  let fence = false;
  for (const line of md.split("\n")) {
    if (FENCE.test(line)) fence = !fence;
    const prev = out.at(-1);
    const joins =
      !fence && !FENCE.test(line) && line.trim() !== "" && !BLOCK_START.test(line) &&
      prev !== undefined && prev.trim() !== "" && !prev.endsWith("  ") && !/^\s*(#|\||```|~~~)/.test(prev);
    if (joins) out[out.length - 1] = `${prev.trimEnd()} ${line.trim()}`;
    else out.push(LIST_ITEM.test(line) ? line.trimStart() : line);
  }
  return out.join("\n");
};

/** Markdown as HTML for the viewer. */
export const markdownHtml = (md: string): string => markdown(joinSoftWraps(md));

const PAGE_STYLE = `body{margin:0;background:#0b0b0f;color:#e5e5e5;font:15px/1.6 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 20px}a{color:#818cf8}
code{background:#1f1f27;padding:1px 5px;border-radius:4px;font-size:.9em}pre{background:#15151b;padding:12px;border-radius:8px;overflow:auto}
pre code{background:none;padding:0}table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid #2a2a33;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#17171e}h2{border-bottom:1px solid #26262e;padding-bottom:6px}.meta{color:#a3a3a3;font-size:13px}`;

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/** A standalone HTML page of the report, opened in a new tab. */
export const reportHtml = (report: Report): string => {
  const body = sections(report.content)
    .map((s) =>
      s.kind === "text" ? markdownHtml(s.markdown) : `<h2>${escapeHtml(`${s.finding.rank}. ${s.finding.title}`)}</h2>${markdownHtml(s.finding.body)}`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(report.path)}</title><style>${PAGE_STYLE}</style></head><body><main><p class="meta">${escapeHtml(report.folderId)} · ${escapeHtml(report.file)}</p>${body}</main></body></html>`;
};

/** The file name a report path ends with. */
export const fileName = (p: string): string => p.split("/").pop() ?? p;

/** The report path an element names: its text, or its link target. */
export const refOf = (e: Element): string | null => {
  const text = (e.textContent ?? "").trim();
  const href = e.getAttribute("href") ?? "";
  return REPORT_REF.test(text) ? text : REPORT_REF.test(href) ? href : null;
};
