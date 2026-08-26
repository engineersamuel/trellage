---
name: graph-of-loops
description: 'Execute a build, fix, or investigation as a dependency-aware graph with validation and review loops.'
---

# Execute a Graph of Loops

## Mission

Use this workflow only when explicitly invoked as `$graph-of-loops`. Parse the
invocation arguments as named `OBJECTIVE` and `CONSTRAINTS` inputs.

Complete the software engineering objective supplied as:

`OBJECTIVE="<what to build, fix, or investigate>"`

Apply the constraints and required outcomes supplied as:

`CONSTRAINTS="<limits, requirements, compatibility needs, and evidence>"`

This is an execution workflow. Inspect the real repository, adapt to its
technology and conventions, and continue until the objective is complete or a
concrete external blocker prevents progress.

## Operating boundaries

- Do not invent files, commands, architecture, behavior, or test results.
- Preserve unrelated worktree changes and existing user state.
- Follow repository instructions before changing files.
- Use the current worktree by default.
- Create child worktrees only when tasks are independent, have disjoint write
  sets, and gain meaningful value from parallel execution.
- Do not merge, push, deploy, delete data, or perform other approval-sensitive
  actions unless the user explicitly authorizes them.
- Do not weaken tests, security, type safety, validation, or product behavior
  to make a gate pass.

## Adaptive entry

Classify the objective from evidence:

- **Build:** define observable behavior and acceptance criteria before code.
- **Fix:** reproduce the defect, identify the root cause, and add a regression
  check before or with the repair.
- **Investigate:** define the question and evidence threshold. Do not change
  production code unless the objective or verified findings require a fix.

If required information cannot be discovered from the repository or runtime,
ask only the smallest blocking question.

## Workflow

1. **Inspect**
   - Read repository instructions, status, manifests, relevant code, tests,
     documentation, and runtime state.
   - Derive the correct validation commands from repository sources.
   - Record assumptions as unknown until verified.

2. **Specify**
   - Translate the objective into testable requirements.
   - Define acceptance criteria, non-regression constraints, edge cases, and
     failure behavior.
   - Identify the final evidence needed for completion.

3. **Build the dependency graph**
   - Decompose the work into small tasks with explicit read sets, write sets,
     dependencies, gates, and expected evidence.
   - Mark tasks parallel only when their dependencies are satisfied and their
     write sets do not overlap.
   - Keep integration, validation, and final review as explicit graph nodes.

4. **Track and triage**
   - If the repository uses Beads, represent the task graph with its configured
     tracker.
   - Use `bv --robot-triage --format toon` or another `--robot-*` command for
     dependency-aware prioritization. Never run bare `bv` in an agent session.
   - Verify tracker state before claiming work. Use the tracker for mutation;
     use `bv` only for analysis.

5. **Execute ready nodes**
   - Work from dependencies outward.
   - Use test-driven development when behavior changes.
   - Parallelize only ready, isolated nodes. Keep shared integration files in
     one ownership path.
   - After each node, run its smallest meaningful gate and update the graph.

6. **Integrate**
   - Combine completed nodes in dependency order.
   - Resolve conflicts by preserving the intent of both sides.
   - Run integration checks after every join.
   - If a gate fails, add a repair node and continue the loop.

7. **Review**
   - Review the integrated result against both repository standards and the
     stated requirements.
   - Use an independent reviewer when available.
   - Reproduce each finding before accepting it. Reject unsupported findings
     with evidence.
   - Turn confirmed findings into graph nodes, fix them, and rerun affected
     gates.

8. **Prove completion**
   - Run all relevant formatting, lint, type, unit, integration, build, and
     runtime checks.
   - Verify the real requested behavior, not a proxy metric.
   - Reinspect the final diff and worktree state.
   - Take “done” back if any requirement, finding, gate, or integration surface
     remains incomplete.

## Completion rule

Stop only when:

- Every requirement maps to passing evidence.
- Every discovered in-scope issue is fixed or has a concrete external blocker.
- All relevant repository gates pass.
- The final review has no unresolved confirmed finding.
- The worktree contains no accidental files or unrelated modifications caused
  by this workflow.

## Output format

Report concise execution state:

```markdown
**Outcome:** <complete, blocked, or in progress>

- **Graph:** <completed nodes and dependency state>
- **Changed:** <files and meaningful behavior>
- **Verified:** <exact checks and results>
- **Review:** <accepted, fixed, and rejected findings>
- **Remaining:** <none, or exact next nodes/blockers>
```
