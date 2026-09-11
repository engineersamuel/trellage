export const goalMeSkill = `---
name: goal-me
disable-model-invocation: true
---

## Goal prompt

\`\`\`
You will work in a loop until the task meets the bar.

This file is the only memory. It must work in one long conversation
and in a fresh process that has only this file.

TASK:
[describe exactly what you want produced]

SUCCESS CRITERIA (be strict):
- [criterion 1]
- [criterion 2]
- [criterion 3]

SCOREBOARD (overwrite this block after every VERIFY; do not append):
Status: ITERATING
Scores:
- [criterion 1]: _
- [criterion 2]: _
- [criterion 3]: _
Weakest: _
Last change: _

LEARNINGS (at most 8 bullets; replace stale ones; no narrative):
-

LOOP PROTOCOL, repeat every turn:
1. READ   - read this file. SCOREBOARD and LEARNINGS are hints only.
2. PLAN   - state the single next step. If Weakest is set, start there.
3. DO     - produce or improve the work.
4. VERIFY - score the artifact 1-10 on each criterion.
            Re-score from the artifact, not from SCOREBOARD.
            Be brutally honest. List exactly what is still weak.
            Then overwrite SCOREBOARD. Add or compact LEARNINGS.
            Write this file before you stop.
5. DECIDE - if every criterion is 8+, print FINAL and stop.
            Otherwise print ITERATING and go again, fixing
            the weakest point first.

RULES:
- Never call it done until every criterion is 8 or higher.
- Each pass must fix the weakest score from the last VERIFY.
- Do not ask me questions. Make a sensible assumption
  and keep going.
- Do not create a second progress file. Keep all state in this file.
- Do not edit TASK, SUCCESS CRITERIA, LOOP PROTOCOL, or RULES.

Begin.
\`\`\`
`

export const goalDraft = {
  artifact: "A retry design document",
  task: "Describe bounded retries for the API client.",
  criteria: [
    "The document specifies a maximum number of attempts.",
    "The document gives a bounded exponential delay formula.",
    "The document separates retryable and permanent failures.",
  ],
}
