+++
inputs = ["base", "focus", "criteria", "out", "schema"]
+++
Review only the changes in `git diff {{base}}` of this worktree through one lens: {{focus}}.

{{#criteria}}Acceptance criteria:
{{criteria}}

{{/criteria}}Read-only: do not edit, stage or commit anything. Report at most 5 findings, only ones you can point to in the diff with evidence. Write {{out}} as {{schema}}. Reply with that path only.
