# ADR 0004: Planning returns grounded, provenance-bound generations

## Status

Accepted.

## Context

A planner can produce a schema-valid graph that substitutes an unrelated
repository surface for a missing target. A cached plan can also survive runtime
or planner-contract changes and execute after its assumptions are obsolete.

## Decision

- Planning returns either a grounded plan or a structured blocked decision.
- Planned objectives and constraints match the persisted request exactly.
- Repository evidence paths must exist, behavior nodes declare repair
  ownership, and the plan accounts for format, lint, type-check, build,
  targeted tests, and the full suite.
- A read-only Codex plan audit runs before Beads acceptance.
- Planner discovery exposes only read-only Serena symbol tools and excludes
  generated Graph state, agent work, dependency trees, and build output.
- Structured discovery is mandatory. A text fallback marker without a valid
  structured discovery artifact fails closed.
- The lifecycle stores request, plan, policy, runtime, planner-contract,
  discovery, review, and base-revision digests in a plan record.
- Normal resume reuses only a current reviewed generation.
- If review transport fails before acceptance, candidate provenance is retained
  and normal resume retries only that audit against the unchanged Git base.
  Review findings are semantic blockers and are not retried as infrastructure.
- Explicit `resume --replan` preserves the prior generation and is rejected
  after a node commit, integration, or dirty generated worktree.

## Consequences

Objective mismatches create no Beads or implementation work. Bounded,
read-only discovery cannot inspect generated copies or invoke Serena mutation
tools. Reuse remains cheap when provenance matches, while stale or
reviewed-invalid plans cannot execute silently. Transient review transport
failures do not discard a valid planner result. Safe replan requires
generation-aware lifecycle and Beads metadata.

## Alternatives considered

- **Rely on planner instructions alone.** Rejected because a real run followed
  the schema while inventing product scope.
- **Delete invalid run state and start again.** Rejected because it destroys
  audit history and conflicts with durable run identity.
- **Allow automatic replan on resume.** Rejected because resume would consume
  model quota and could replace an accepted graph without explicit intent.
