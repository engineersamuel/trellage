+++
inputs = ["doc", "past", "issues", "prs", "todos", "ci", "templates"]
+++
Goal document:
{{doc}}

Past goals for this repo, with run history (JSON):
{{past}}

Open issues (JSON): {{issues}}

Recent PRs (JSON): {{prs}}

TODO/FIXME lines:
{{todos}}

CI:
{{ci}}

Templates: {{templates}}

Pick what can inspire or improve THIS goal. pastGoals: up to 3 most relevant ids, a one-sentence tip learned from their runs/unmet lines, and the one-line proposal it suggests. repoScan: up to 5 relevant items (issues, TODOs as file:line, PRs, CI facts) with a hint and a proposal. templates: ids ordered by fit. Use only refs that exist in the data above.
