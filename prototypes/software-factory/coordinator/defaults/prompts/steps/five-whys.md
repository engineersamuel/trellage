+++
order = 16
best_for = ["Why a goal run, release, or incident went wrong after it ended", "A failure that came back after a fix, or a debug report whose code cause does not explain why our process let it happen"]
avoid_for = ["A failing test, build, or crash with no cause found yet (use debug first)", "New features with no failure to explain", "Quick or cheap checks: it starts several fact-checker and cynic subagents"]
skills = ["five-whys"]
skill_dirs = ["2x-skills/plugins/incident-tools/skills"]
gate_tools = false
harness = { kind = "claude", profiles = ["default"] }
# The proxy's model router (Jev) picks the fact-checker and cynic subagent model (the skill asks for "sonnet") from this text.
subagent_route = "Low-cost, fast subagent work: fact-check claims against files, git and logs, and attack a cause chain. Return a short verdict table. Prefer a cheap, quick model."
# Added to the worker task after "Use the five-whys skill.".
instructions = "Do not change tracked files and do not fix anything. Use a debug report in the task as Measured evidence; do not investigate the code cause again. Report: the five-whys document (impact, the whys with evidence, root causes, open inferences)."
+++
Find the root causes of a past failure with the five-whys skill (intercom/2x-skills): a cause chain from impact to a cause you can change, every claim checked by fact-checker subagents and every link attacked by a cynic subagent. Slow and costly. It does not fix anything.
