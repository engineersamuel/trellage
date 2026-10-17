---
name: decide
description: Run Edward de Bono's Six Thinking Hats on one decision with the six-hats plugin subagents — white first, then red, yellow, black, and green in parallel, then blue for one plan. Use when the user invokes /six-hats:decide or asks for a six-hats decision.
---

# Six Thinking Hats

Run the six hat subagents from this plugin on the decision in the user's
request. Each hat thinks in one mode only; you coordinate and do not wear a hat
yourself.

## Rules

- Call each hat by its plugin agent type: `six-hats:white-hat`,
  `six-hats:red-hat`, `six-hats:yellow-hat`, `six-hats:black-hat`,
  `six-hats:green-hat`, and `six-hats:blue-hat`.
- If any of those agent types is unavailable, stop and report which one is
  missing. Never substitute `general-purpose` or another agent.
- Spawn each hat as an ordinary foreground subagent, not as an agent-team
  teammate, and without worktree isolation.
- Do not edit, commit, or run mutating commands in the launching checkout.
  Only the green hat changes files, and only inside its git-ignored scratch
  copy under `.six-hats/`.
- Finish the round without asking questions. If a hat fails or returns
  nothing usable, record its error under that hat's heading and still run
  the blue hat, which must name the missing perspective.

## Steps

1. Restate the decision in one sentence. If the request has no decision,
   ask for one and stop.
2. Run `six-hats:white-hat` with the decision. Wait for its facts.
3. In a single message, launch `six-hats:red-hat`, `six-hats:yellow-hat`,
   `six-hats:black-hat`, and `six-hats:green-hat` in parallel. Give each the
   decision and the white hat's full output verbatim.
4. Run `six-hats:blue-hat` with the decision and the full, unedited output of
   all five previous hats, each under a heading naming its hat.
5. Present the result:
   - the blue hat's plan in full;
   - one short line per other hat summarizing its contribution;
   - the green hat's `## Scratch copy` section, copied verbatim from the
     green hat's own output. Never restate, summarize, or infer it from
     another hat.
6. End with `Six Hats round complete` as the last line, and stop. Ask before
   acting on the plan or changing the launching checkout.
