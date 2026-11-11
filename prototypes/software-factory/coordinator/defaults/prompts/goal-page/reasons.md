+++
inputs = ["state", "gates", "tier", "meanings"]
+++
{{state}}

Jev decided (probability vs threshold): {{gates}}; risk tier {{tier}}.
Gate meanings: {{meanings}}

For each gate write one short reason (<= 14 words) for Jev's decision, specific to this goal. Give one reason for the tier. bodyIncludes: 1-4 short strings the PR body must contain as proof (e.g. "AC-1: PASS"). untouched: repo paths the PR must not change (only if the goal implies them).
