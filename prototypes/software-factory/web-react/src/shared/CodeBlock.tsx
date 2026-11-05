import type { DefaultMarkdownRendererProps } from "@copilotkit/react-core"
import hljs from "highlight.js/lib/common"
import { memo, useMemo } from "react"
import "highlight.js/styles/github-dark.css"
import "./code-block.css"

function highlightCode(code: string, info?: string) {
  const language = info?.trim().split(/\s+/)[0]?.toLowerCase()
  return language && hljs.getLanguage(language) ? hljs.highlight(code, { language }) : hljs.highlightAuto(code)
}

const CodeBlock = memo(function CodeBlock({ code, language }: { code: string; language?: string }) {
  const highlighted = useMemo(() => highlightCode(code, language), [code, language])
  return (
    <pre className="sf-code-block">
      <code
        className="hljs"
        data-language={highlighted.language}
        dangerouslySetInnerHTML={{ __html: highlighted.value }}
      />
    </pre>
  )
})

export const factoryMarkdownRenderer = {
  nodeRenderers: {
    codeBlock: ({ node }) => <CodeBlock code={node.text} language={node.info} />,
  },
} satisfies DefaultMarkdownRendererProps
