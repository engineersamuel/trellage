+++
order = 6
best_for = ["A failing test, build, CI check, crash, or unexpected behavior", "An earlier step that ended in an error"]
avoid_for = ["New features with no error", "Work that has no failure to explain", "Why our process let a failure happen, once its code cause is known (use five-whys)"]
skills = ["systematic-debugging"]
skill_dirs = ["claude-code-templates/cli-tool/components/skills/development"]
gate_tools = false
# Added to the worker task after "Use the systematic-debugging skill.": where to stop in the skill.
instructions = "Stop after Phase 3, when the root cause is confirmed or you cannot confirm one. Do not fix the bug: skip Phase 4, write no fix and no new test. Revert every temporary change (logging, experiments) so the code is as you found it. Report: root cause with evidence, hypotheses ruled out, a suggested fix (not applied), and how sure you are."
+++
Find the root cause of an error with the systematic-debugging skill (aitmpl.com): investigate, compare, test hypotheses, then report the cause with evidence and a suggested fix. It does not fix the code.
