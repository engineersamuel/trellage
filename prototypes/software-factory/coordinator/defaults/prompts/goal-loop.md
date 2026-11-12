+++
inputs = ["goal", "loop", "prompt", "acs", "acSource", "pr", "history", "note", "usd"]
+++
[goal loop {{loop}}] You start loop {{loop}} of goal "{{goal}}" with a fresh context. Earlier loops worked in this same worktree, branch and PR; their chat is gone, so the goal state below is your memory. Continue the work until every acceptance criterion passes and the PR is green. Do not start over, do not open a second PR, and do not redo what already passes.

Goal:
{{prompt}}

Acceptance criteria (status from {{acSource}}):
{{acs}}

PR: {{pr}}

Earlier loops (newest last):
{{history}}
{{#note}}
Direction from the human for this loop:
{{note}}
{{/note}}
Next: read `git log` and .factory/ (acceptance, contract, evidence) in the worktree, call sdlc_status, then fix what fails. Keep the same acceptance criteria in sdlc_plan unless the human changed them. The goal's cost limit is ${{usd}} for all loops together. When your loop ends, call report_up; if a defect in the software factory itself stops you, say so in report_up's factoryDefect.
