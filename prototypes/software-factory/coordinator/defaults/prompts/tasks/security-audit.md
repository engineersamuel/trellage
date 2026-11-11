+++
inputs = ["base", "out"]
+++
Run the security-audit skill in full audit mode on this worktree, scoped to the changes in `git diff {{base}}` (the code this diff adds or changes). Use {{out}} as the output directory; it is outside the target. Write the validated findings to {{out}}/findings.json in the skill's report schema (write [] when there are none). Reply with that path only.
