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

export const expandedGoalMeSkill = `---
name: goal-me
disable-model-invocation: true
---

## Goal prompt

\`\`\`text
Work toward the outcome below within the agreed limits.

TASK:
[One coherent outcome and its intended use.]

INPUTS AND ARTIFACTS:
[Input locations, output paths, relevant context, and how to inspect them.]

CONSTRAINTS:
[Scope, exclusions, project rules, existing authorization, and resources.]

SUCCESS CRITERIA:
Score each criterion independently from 1-10 using current evidence.
Missing evidence is unverified, not a passing score.
| ID | Criterion and observable Target | Verification and score mapping (8/10 and 10/10 anchors) |
| --- | --- | --- |
| C1 | [target] | [command or evidence-based rubric] |
| C2 | [target] | [command or evidence-based rubric] |
| C3 | [target] | [command or evidence-based rubric] |

REQUIRED CHECKS:
[Each check's ID, command or inspection method, and pass condition.
Write "None" explicitly only if no required checks apply.]
These gates must pass independently of criterion scores.

ACTION CATALOG:
| Action | Criterion IDs | Expected benefit | Prerequisites | Verification |
| --- | --- | --- | --- | --- |
| [concrete improvement] | [IDs] | [impact estimate] | [dependencies or none] | [method] |
Estimates guide selection; only verified results count as progress.

EXECUTION LIMITS:
Max iterations: 20
Max consecutive no-progress attempts: 5

SCOREBOARD:
Status: ITERATING
Iterations: 0
Consecutive no-progress attempts: 0
Pending attempt: none
| Criterion | Baseline | Current | Evidence |
| --- | --- | --- | --- |
| C1 | _ | _ | _ |
| C2 | _ | _ | _ |
| C3 | _ | _ | _ |
Required checks (baseline/current, evidence): _
Artifact state and measurement version: _
Weakest: _
Last change and disposition: _
Next action: _
Stop reason: _

RECENT ATTEMPTS:
Keep only the five most recent attempts.

LEARNINGS:
Keep at most 8 bullets; replace stale ones. No narrative history.

LOOP PROTOCOL:
1. READ - Read this file and inspect the current artifacts and project rules.
2. MEASURE - Measure every criterion and required check.
3. CHOOSE - Choose one concrete action.
4. ACT - Persist the attempt and make the change.
5. VERIFY - Rerun the agreed measurements and required checks.
6. RETAIN OR RECOVER - Keep only verified improvements.
7. RECORD - Overwrite the scoreboard and attempt history.
8. DECIDE - Set FINAL, STOPPED, or ITERATING from current evidence.

RULES:
- Do not weaken a gate to pass.
- Do not create a second progress file.

Begin with READ and MEASURE.
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

export const expandedGoalDraft = {
  ...goalDraft,
  inputsAndArtifacts: "The current repository is the input; the retry design document is the output.",
  constraints: "Preserve existing behavior and follow repository instructions.",
  criterionVerifications: [
    "Inspect the documented attempt limit; 8/10 names a finite limit and 10/10 justifies it.",
    "Inspect the delay formula; 8/10 is bounded and 10/10 covers overflow and jitter.",
    "Inspect the failure classification; 8/10 separates categories and 10/10 covers ambiguous failures.",
  ],
  requiredChecks: ["The repository test command passes."],
  actions: [
    {
      action: "Write and verify the retry design.",
      criterionIds: ["C1", "C2", "C3"],
      expectedBenefit: "Satisfies the complete retry contract.",
      prerequisites: "None.",
      verification: "Apply each criterion rubric and run the required check.",
    },
  ],
  maxIterations: 20,
  maxConsecutiveNoProgressAttempts: 5,
}
