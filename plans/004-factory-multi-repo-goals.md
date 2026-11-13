# Plan 004: Goals that change more than one repo

Status: TODO (draft for review). Priority P2. Effort L.
Risk MEDIUM (goal schema, grading, PR order across repos).
Depends on: the factory home file `~/projects/FACTORY.md` (done; README "Factory home file").

## Goal

One goal can change two or more repos, for example a copilot-proxy-rs API change and the matching
weavekit client change. Today a goal has one `repo`, and FACTORY.md tells agents not to edit a second repo.

## Proposed shape

A goal keeps `repo` for the single-repo case. A multi-repo goal adds `parts`; each part is one normal
run in one repo with its own worktree, branch, PR, and checks.

```json
{
  "id": "cpr-weavekit-refusal",
  "title": "Refusal entries in /v1/systemone, and weavekit reads them",
  "prompt": "Shared intent for every part.",
  "parts": [
    { "id": "proxy", "repo": "/home/me/projects/copilot-proxy-rs", "base": "main",
      "prompt": "Part-specific task.", "expect": { "pr": { "checks": "SUCCESS" } } },
    { "id": "client", "repo": "/home/me/projects/weavekit", "base": "main",
      "after": ["proxy"], "prompt": "Part-specific task.", "expect": { "pr": { "checks": "SUCCESS" } } }
  ]
}
```

- `after`: parts that must reach an open PR with passing checks first. The later part gets the earlier
  PR URLs and diffs as input. No cycles.
- Exactly one of `repo` or `parts`. Each part's `repo` must be a factory folder.
- Each part runs as its own sub-coordinator conversation, so the existing gates, security review,
  approvals, and one-PR-per-run rule stay unchanged.
- The goal passes only when every part passes. The grade lists each part.

## Changes

1. `shared/goal.ts`: add `GoalPart`, `parts`, and `goalProblems` checks (folder, `after` refers to
   known ids, no cycles). → verify: schema tests for valid, cycle, unknown `after`, both `repo` and `parts`.
2. `sf goal run`: start parts in `after` order, pass earlier PR links into later prompts, score each
   part with `goalUnmet`. → verify: CLI test with two fake parts.
3. Run logs: one runner line per part with `part` id; the goal's grade has a per-part list.
   → verify: grading test.
4. FACTORY.md shared rule "One goal changes one repo": change to "One part changes one repo".
5. Goal page: Discover reads FACTORY.md to propose parts when the idea crosses repos.
   → verify: goalPage test with a two-repo FACTORY.md.

## Open questions for the human

- When part 1's PR changes after part 2 started (fix round), restart part 2 or let it continue?
- Merge order stays with the human. Should the PR bodies link each other and say the merge order?
- Is an upstream repo (langfuse) allowed as a part?

## STOP conditions

- Stop if a part would need to push to a repo the factory has no folder for.
- Stop if running two sub-coordinators at the same time breaks the state lock or approvals.
