// Pure helpers for the report viewer: find the ranked findings, and turn a Markdown report into MDX.

/** A ranked finding: a `## <rank>. <title>` heading and the text up to the next level-2 heading. */
export type Finding = { rank: number; title: string; body: string }

const FINDING = /^##\s+(\d+)[.)]\s+(.+?)\s*$/

export const findings = (md: string): Finding[] => {
  const out: Finding[] = []
  let cur: Finding | null = null
  let fence = false
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    const m = !fence && line.match(FINDING)
    if (m) {
      cur = { rank: Number(m[1]), title: m[2]!, body: "" }
      out.push(cur)
    } else if (!fence && /^#{1,2}\s/.test(line)) cur = null
    else if (cur) cur.body += `${line}\n`
  }
  return out.map((f) => ({ ...f, body: f.body.trim() }))
}

/** Escape what MDX reads as JSX or expressions, outside code spans and fences. */
const escapeProse = (line: string): string =>
  line
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : part.replace(/[{}<>]/g, (c) => `&#${c.charCodeAt(0)};`)))
    .join("")

const attr = (s: string) => JSON.stringify(s)

/**
 * The report as an MDX document: each ranked finding becomes a `<Finding>` component that the viewer renders
 * as a card with its Start button. Everything else stays Markdown.
 */
export const toMdx = (md: string): string => {
  const out: string[] = []
  let fence = false
  let open = false
  const close = () => open && (out.push("", "</Finding>", ""), (open = false))
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence
      out.push(line)
      continue
    }
    if (fence) {
      out.push(line)
      continue
    }
    const m = line.match(FINDING)
    if (m) {
      close()
      out.push(`<Finding rank={${Number(m[1])}} title=${attr(m[2]!)}>`, "")
      open = true
    } else if (/^#{1,2}\s/.test(line)) (close(), out.push(escapeProse(line)))
    else out.push(escapeProse(line))
  }
  close()
  return out.join("\n")
}
