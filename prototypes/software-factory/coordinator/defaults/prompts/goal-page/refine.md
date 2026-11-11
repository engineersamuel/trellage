+++
inputs = ["title", "task", "lines", "dim", "note"]
+++
Goal document:
Title: {{title}}
task: {{task}}
{{lines}}

Jev scored the goal weak on "{{dim}}". Jev's note: {{note}}

Give 1-3 concrete fixes that raise "{{dim}}". Each fix edits ONE line: op add (new line in section; index null), replace (index = line number in that section; for task index null and text = full new task), or remove (index; text ""). title <= 8 words; why one sentence.
