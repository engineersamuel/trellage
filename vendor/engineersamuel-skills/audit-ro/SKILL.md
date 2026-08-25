---
name: audit-ro
description: Use when and only when the user explicitly invokes $audit-ro or /audit-ro to coordinate a complete, read-only codebase audit for materially useful simplifications in data structures, state, control flow, algorithms, and ownership.
disable-model-invocation: true
---

# Audit RO

Audit the entire current codebase for materially useful simplifications in its
data structures, state representation, control flow, algorithms, and ownership.

This is an audit-only exercise. Do not edit repository files. Do not run tests,
implement recommendations, commit, or push. Use read-only inspection commands
only. Keep any working record in session scratch storage outside the repository,
then deliver the final audit in the response. Confirm at the end that the
repository remains unchanged.

Act as the coordinator. Continue until the complete codebase has been reviewed
and the final audit has been validated.

## Capture the repository baseline

Before substantive inspection or delegation, record an initial repository-state
baseline in the external audit record. For a version-controlled worktree,
capture the current revision, machine-readable status, staged diff, unstaged
diff, and content fingerprints for untracked files. For a repository without
version control, capture a manifest of relative paths, file types, and content
fingerprints, excluding version-control metadata.

At completion, repeat the same snapshot procedure and compare it with the
initial baseline. A final status command by itself is not unchanged-repository
proof.

## Establish the coverage contract

Inspect the repository and inventory every identifiable subsystem. Give each
subsystem:

- A stable ID and descriptive name.
- An exact, non-overlapping ownership boundary.
- Its key implementation files.
- Relevant public interfaces, major call sites, and tests.
- A status: `queued`, `in review`, `recommend`, or `skip`.

Include frontend, backend, shared infrastructure, platform bridges,
generated-contract ownership, and test/tooling infrastructure where materially
relevant. Do not use broad catch-all rows as proof of coverage.

Maintain one canonical audit record containing:

- The subsystem inventory.
- Confirmed opportunities.
- Explicit skip decisions.
- Cross-cutting patterns.
- Duplicates and superseded findings.
- Final priorities and dependencies.
- An audit log.

Treat this inventory as the coverage contract. Add a new explicit row when later
inspection discovers an omitted subsystem.

## Run bounded subsystem reviews

Use fresh, read-only workers when available. Keep concurrency bounded to the
number of lanes that can be actively coordinated. Assign each worker one
distinct subsystem with an exact ownership boundary that does not overlap
another active assignment.

Use one consolidated wait mechanism for each batch.
Do not interrupt a productive worker only because it is slow. Harvest each
completed result, record it in the canonical audit record, and close that worker
before opening excess work.

Give every worker this brief:

> Review the assigned subsystem for at most two materially useful
> simplifications in its data structures, state representation, or organizing
> model.
>
> This is read-only. Do not edit files, run tests, implement recommendations,
> commit, or push. Use inspection-only commands.
> Keep all notes external to the repository.
>
> Inspect its implementation, public interfaces, major call sites, and existing
> tests. Stay within the assigned ownership boundary. You may identify
> cross-subsystem concerns, but do not expand the scope to solve them.
>
> Look for:
>
> - Scattered booleans or nullable fields that permit invalid combinations and
>   should become a state machine or discriminated union.
> - Repeated assumptions about object shape that need a shared typed model.
> - Duplicated branching that a small map, registry, reducer, or command model
>   would remove.
> - Unclear state or behavior ownership that a small module boundary would
>   clarify.
> - Repeated scans, transformations, or lookups where a more appropriate
>   collection or index would materially simplify behavior.
> - Lifecycle, concurrency, or async states whose representation permits stale
>   or contradictory state.
>
> Do not force an abstraction. Prefer boring local code when it is already
> clear. Do not recommend changes solely for stylistic consistency,
> hypothetical extensibility, minor line-count reduction, or moving existing
> branching behind a new type.
>
> Return at most two opportunities. If nothing clearly meets the threshold,
> return `skip`.
>
> For every result, provide:
>
> 1. Verdict: `recommend` or `skip`.
> 2. Evidence with exact file and line references.
> 3. Current complexity or invalid states.
> 4. Proposed representation and why it is simpler.
> 5. Smallest credible implementation scope, including affected files and
>    interfaces.
> 6. Regression risks and migration concerns.
> 7. Existing and additional validation required.
> 8. Confidence: `high`, `medium`, or `low`.

If read-only workers are unavailable, run the same bounded reviews sequentially
as coordinator. Never reduce coverage because delegation is unavailable.

## Validate and synthesize

Independently verify every worker finding against the current repository before
accepting it. Reject, narrow, or demote findings that are vague, duplicate
another finding, misunderstand intentional semantics, or merely relocate
complexity.

Record skips as completed coverage. Deduplicate overlapping findings, record
superseded entries, and preserve one authoritative subsystem for each accepted
recommendation. Continue bounded batches until every inventory row has status
`recommend` or `skip`.

## Audit the audit

After all rows are complete, use fresh independent read-only passes for:

- Repository coverage and missing subsystem boundaries.
- Duplication and ownership overlap.
- Materiality and over-abstraction.
- Schema completeness.
- Dependency-aware priority ranking.

If the coverage pass finds a real omission, add an explicit subsystem row and
audit it. Do not hide the omission by broadening a completed boundary.

Rank final recommendations by concrete impact, confidence, implementation
effort, blast radius, and prerequisites.
Identify the best first implementation slices.

## Completion gate

Finish only when:

- Every identifiable subsystem has been reviewed.
- Every subsystem has a recommendation or explicit skip.
- Every finding has complete evidence, scope, risk, and validation fields.
- Duplicates and weak abstractions have been removed.
- Priorities and dependencies are internally consistent.
- The audit log records coverage changes, accepted or rejected findings, and
  independent audit passes.
- The final repository-state snapshot matches the initial baseline exactly.

Report the coverage inventory, accepted recommendations, explicit skips,
cross-cutting patterns, rejected or superseded findings, priority and dependency
ranking, best first slices, independent audit results, and unchanged-repository
proof. If any completion condition is unmet, label the audit incomplete and
state the exact gap.
