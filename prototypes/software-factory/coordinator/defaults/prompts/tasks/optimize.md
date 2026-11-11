+++
inputs = ["request", "title", "lens", "report"]
+++
{{request}}

Apply only the "{{title}}" lens to this repository as it is now:
{{lens}}

This is read-only analysis. Do not edit, stage, commit, or push application code; the lens instructions above describe what to look for, not changes to make.

Save your result to reports/{{report}}.md: up to 5 findings ranked by impact, each with file:line, the problem, the proposed change, estimated impact, risk, and how to verify. Separate verified facts from estimates. It is valid to report no material finding. Return the saved report path.
