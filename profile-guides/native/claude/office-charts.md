---
schemaVersion: 2
templates:
  chart-heavy-presentations: |-
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
