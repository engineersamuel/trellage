// Diffs in the Foldkit chat and code colors for the diff lines of shared/diffview.ts.
import hljs from "highlight.js/lib/common"
import "highlight.js/styles/github-dark.css"
import { micromark } from "micromark"
import { gfm, gfmHtml } from "micromark-extension-gfm"
import { setDiffHighlighter, setMarkdownRenderer, startToolDiffs } from "../../shared/diffview"

setDiffHighlighter((code, language) =>
  hljs.getLanguage(language) ? hljs.highlight(code, { language, ignoreIllegals: true }).value : null,
)

// Markdown preview of .md diffs: CommonMark + GFM. micromark escapes raw HTML and drops unsafe link protocols.
setMarkdownRenderer((md) => micromark(md, { extensions: [gfm()], htmlExtensions: [gfmHtml()] }))

// The patched agent-interface timeline leaves a [data-sf-tool] slot per finished tool call; fill them with diffs.
startToolDiffs()
