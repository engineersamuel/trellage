# ADR 0003: Trellage-owned Codex review and repository-opt-in Raindrop proof

## Status

Accepted. This is the implementation contract for the Codex review gate
(`trellage_graph.review`) and the Raindrop proof gate (`trellage_graph.proof`)
in the `claude-graph-of-loops` profile's Graph of Loops control plane.

## Context

The profile previously installed `hamelsmu/claude-review-loop` as a Stop-hook
review gate. That plugin:

- Has no LICENSE file in its upstream repository, even though marketplace
  metadata claims MIT.
- Fails open when Codex is absent from the container, so review silently
  stops happening rather than blocking.
- Has no structural connection to Beads repair work — a finding does not
  become tracked, gated work.

Separately, the profile installs the Raindrop Workshop binary. Raindrop can
replay real execution traces, which can run real application code and
side effects. Installing the binary is not proof that replaying it is safe
for a given repository.

## Decision

### Codex review

- The `review-loop` plugin is removed from this profile. It is not copied
  into this repository under any name.
- The controller runs Codex itself: ephemeral, `--sandbox read-only`, with a
  Trellage-owned prompt and a locked JSON output schema
  (`schemas/codex-review.schema.json` — a `findings` array of high-confidence
  correctness findings plus a `summary` string).
- The schema is included in the prompt and Trellage validates the final JSON
  locally. The Copilot Responses proxy does not accept Codex native
  `--output-schema` requests, so transport-level structured output is not used.
  Missing, malformed, or schema-invalid JSON still fails closed.
- A behavior-changing node runs this review after its local gates pass. After
  all nodes integrate, the controller runs one additional cross-node review
  against the graph's base revision.
- Before Beads acceptance, the same read-only adapter audits the candidate
  plan for request fidelity, repository grounding, repair ownership,
  validation coverage, and claims owned by the controller rather than a node.
- A plan-audit transport failure preserves the unchanged candidate and its
  provenance. Plain `resume` retries only the audit when the request, policy,
  runtime, planner contract, discovery, candidate, and Git base revision still
  match. Semantic findings remain blocked and require explicit replan.
- **Fail-closed, not fail-open:** if Codex is missing, exits nonzero, or
  returns output that does not validate against the schema, the controller
  blocks completion — the same as if Codex had reported a finding.
- Every returned finding creates a Beads repair node. A finding is not
  resolved by being ignored or by a specialist's own claim that it is fixed.
  Rejecting a finding requires an explicit controller command
  (`trellage-graph finding reject <finding-id> --run <run-id> --evidence <path>`) backed by
  a recorded evidence file; specialists cannot silently dismiss a finding.

### Raindrop proof

- Replay is **repository-opt-in**. It is applicable only when the repository
  declares both `.raindrop/agents.yaml` and a Trellage proof policy
  (`schemas/repository-proof.schema.json`: `event`, `entry`, one or more
  `assertions`, an `allowed_file_effects` allowlist, and a `timeout_seconds`
  bound).
- When both declarations exist, the controller validates the entry, registers
  it in an isolated Raindrop home, invokes Workshop's `replay_run` MCP tool,
  waits for completion, and evaluates the declared assertions.
- **When no safe replay policy exists, proof status is `not-applicable`.**
  The controller never reports that replay occurred when it did not, and it
  never infers that replay is safe merely because the `raindrop` binary is
  present in the image.
- If a node or graph requires proof and proof is unavailable, mutates a file
  outside `allowed_file_effects`, times out, errors, or fails an assertion,
  the controller reopens or creates repair work and blocks completion.

## Consequences

- Review and proof are both fail-closed: an unreadable or missing result
  blocks the graph rather than passing it silently.
- Every Codex finding is durable, tracked work in Beads, not a comment that
  can be lost when a session ends.
- Repositories with no Raindrop policy get an honest `not-applicable` status
  instead of a false pass or a forced, possibly unsafe, replay.
- Declaring a Trellage proof policy is extra repository setup work; this is
  accepted because the alternative is running unreviewed replay against real
  application code.
- The Codex review prompt is intentionally scoped to high-confidence
  correctness findings, not style, to keep signal-to-noise usable inside a
  graph run.

## Alternatives considered

- **Keep `review-loop` and accept fail-open behavior.** Rejected: an
  unlicensed plugin that silently stops reviewing when its dependency is
  missing is not an acceptable gate for a system whose stated goal is
  provable completion.
- **Make Raindrop replay run automatically whenever the binary is present.**
  Rejected: this conflates "we exported a binary" with "the repository has
  told us how to replay it safely." Automatic replay could execute
  unreviewed application code with real side effects.
- **Treat "no policy" as proof passing rather than not-applicable.**
  Rejected: this would make silence look like verification. Reporting
  `not-applicable` keeps the distinction between "we did not check" and
  "we checked and it passed" explicit in the evidence ledger.

## Rollback and review triggers

- **Rollback:** The schema requires `orchestration.review.required = true`
  when Graph of Loops is enabled, so there is no per-profile flag to disable
  the Codex review gate alone. Roll back by removing the entire
  `[orchestration]` block, which reverts the profile to its
  pre-Graph-of-Loops behavior. Separately, and not as a rollback: a
  repository that declares no `.raindrop/agents.yaml` or Trellage proof
  policy keeps Raindrop proof status `not-applicable`, which is normal
  operation, not a way to disable the review gate.
- **Review this decision if:** the Copilot Responses proxy accepts Codex native
  structured-output requests; the fixed high-confidence-only review prompt produces
  unacceptable false-negative rates in practice; or a repository's proof
  policy format needs fields this schema does not express.
