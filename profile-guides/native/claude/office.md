---
schemaVersion: 1
goalExecution:
  controller: claude-goal
  workflowIds:
    - office-documents
    - academic-presentations
capabilities:
  - anthropic-document-skills
  - academic-pptx-editorial-layer
  - native-common-skill-bundle
  - isolated-claude-profile-home
bestFor:
  - Creating and editing Word documents, Excel workbooks, PDFs, and PowerPoint presentations
  - Research talks and academic presentations that need a clear argument and evidence
avoidFor:
  - Chart-heavy slide production that needs the optional slide-maker builder; use office-charts
  - Tasks that require OS sandboxing or interactive permission approval
prerequisites:
  - id: office-profile
    description: Run trx setup claude office to install the document plugin and managed skills.
  - id: proxy
    description: Host Claude Code, curl, jq, and the local copilot-proxy-rs endpoint must be available.
workflows:
  - id: office-documents
    description: Create or edit Office documents using the Anthropic document skills.
    examples:
      - Turn these notes into a formatted Word report
      - Build an Excel workbook from this data with formulas and charts
    promptTemplate: |
      Use the appropriate document skill for {{intent}}.
      Verify the generated document before handing it over.
  - id: academic-presentations
    description: Plan the presentation argument with academic-pptx and build it with the document plugin.
    examples:
      - Build a conference talk from this research paper
      - Improve the argument and structure of this thesis defense
    promptTemplate: |
      Use academic-pptx for content and structure, and the document plugin's
      pptx skill for file creation and review: {{intent}}.
---

# Claude Office (`trx run claude office`)

Includes `document-skills@anthropic-agent-skills` from `anthropics/skills`,
`academic-pptx` from `Gabberflast/academic-pptx-skill`, and `native-common`.

Uses Sonnet 5.5 at medium effort. Start with
`trx run claude office --permission-mode plan` for Opus 5.5 at max effort.
When changing modes inside a session, use `/effort max` for planning and
`/effort medium` for normal work; max effort is session-only. Profile
state and plugin installation are isolated from `trx run claude default` and
personal Claude state. This is not an OS security boundary.

Run `trx setup claude office`, then `trx run claude office`. For the optional chart-heavy
builder, use `trx run claude office-charts`.
