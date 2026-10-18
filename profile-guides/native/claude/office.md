---
schemaVersion: 2
templates:
  office-documents: |-
    Use the appropriate document skill for {{intent}}.
    Verify the generated document before handing it over.
  academic-presentations: |-
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
