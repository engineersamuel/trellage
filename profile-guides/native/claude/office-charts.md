---
schemaVersion: 1
goalExecution:
  controller: claude-goal
  workflowIds:
    - chart-heavy-presentations
capabilities:
  - anthropic-document-skills
  - academic-pptx-editorial-layer
  - slide-maker-builder
  - native-common-skill-bundle
  - isolated-claude-profile-home
bestFor:
  - Presentations with many charts or data-heavy slide layouts
  - Building or redesigning decks with the slide-maker workflow
avoidFor:
  - Document work that does not need slide-maker; use office
  - Tasks that require OS sandboxing or interactive permission approval
prerequisites:
  - id: office-charts-profile
    description: Run trx setup claude office-charts to install the document plugin and managed skills.
  - id: proxy
    description: Host Claude Code, curl, jq, and the local copilot-proxy-rs endpoint must be available.
workflows:
  - id: chart-heavy-presentations
    description: Build a data-heavy presentation with the optional slide-maker builder.
    examples:
      - Build a deck that explains these experiment results with charts
      - Redesign these data-heavy slides for a stakeholder review
    promptTemplate: |
      Use academic-pptx for the argument, slide-maker for the slide-building
      workflow, and the document plugin's pptx skill for file work: {{intent}}.
      Verify the result before handing it over.
---

# Claude Office Charts (`trx run claude office-charts`)

Includes everything in `office`, plus `slide-maker` from
`addsumtech/slides_maker`. This is an explicit opt-in, not an automatic
addition to `office`.

Run `trx setup claude office-charts`, then `trx run claude office-charts`. It has separate
state and sessions. Normal work uses Sonnet 5.5 medium; start with
`--permission-mode plan` for Opus 5.5 max. When changing modes inside a session,
set `/effort max` for planning and `/effort medium` for normal work.
It is not an OS security boundary.
