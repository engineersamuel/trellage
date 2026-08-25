---
name: goal-me
description: Use when a user wants a free-form request steered into a filled goal-loop prompt (TASK + SUCCESS CRITERIA), asks to write GOAL.md, or runs /goal-me.
disable-model-invocation: true
---

# Goal Me

Turn free-form input into a **goal prompt** a later harness can run. The only artifact is the written file.

## Workflow

1. **Seed.** Use the user's input as the starting idea. If they gave none, ask for the idea in one sentence and wait.

2. **Grill.** Run `/grill-me` until the user confirms a **shared understanding** of the work to produce. Aim every round at `TASK` and `SUCCESS CRITERIA` only. The loop protocol and rules are fixed.

   If `grill-me` is not installed, interview in frontier rounds: number every currently unblocked decision, attach a recommended answer, wait for the user's answers, then recompute the frontier. Look up facts yourself.

   Keep a live draft of `TASK` and the criteria as answers arrive.

   A `TASK` is ready when it names **one exact artifact** to produce.
   A criterion is ready when an independent scorer can give it **1-10** from that artifact alone.
   Need **at least three** ready criteria.

3. **Write.** After the user confirms shared understanding, fill the template below and write it to the **current working directory**:
   - List existing `GOAL.md` and `GOAL-*.md` files first.
   - Use `GOAL.md` if that path is free.
   - Otherwise use `GOAL-<id>.md`, where `<id>` is **four lowercase hex** characters (`0-9a-f`) that do not collide with an existing file. Generate a new id if it collides.
   - Fill `TASK` and `SUCCESS CRITERIA`. Seed `SCOREBOARD` with those criterion labels and `_` scores. Leave `LEARNINGS` empty. Leave the loop protocol and rules unchanged.

4. **Stop.** Report the **written path**. The file is the handoff. Do not execute the loop.

## Goal prompt

```
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
```
