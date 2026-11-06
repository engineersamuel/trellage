// Diffs in the Foldkit chat and code colors for the diff lines of shared/diffview.ts (same highlight.js setup and theme as web-react).
import hljs from "highlight.js/lib/common";
import "highlight.js/styles/github-dark.css";
import { setDiffHighlighter, startToolDiffs } from "../../shared/diffview";

setDiffHighlighter((code, language) => (hljs.getLanguage(language) ? hljs.highlight(code, { language, ignoreIllegals: true }).value : null));

// The patched agent-interface timeline leaves a [data-sf-tool] slot per finished tool call; fill them with diffs.
startToolDiffs();
