---
schemaVersion: 1
capabilities:
- multi-node-coding-orchestration
- dependency-aware-planning
- git-worktree-isolation
- specialist-agent-roles
- research-fan-out-with-code-gate
- persistent-task-memory
- tdd-workflow
- resumable-fail-closed-execution
- rebase-fast-forward-integration
- structured-codex-review-gate
bestFor:
- Complex repository changes that divide into dependency-aware implementation, test, research, debug, or validation nodes
- Long-running work that must survive interruption and resume from durable run, Beads, review, and gate state
- Behavior changes that require real red-green-final TDD evidence, isolated worktrees, Codex review, and rebase-first fast-forward-only integration
- Cross-cutting fixes where independent nodes can run in parallel but overlapping write ownership must remain serialized
- High-assurance delivery that must fail closed on weak discovery, invalid plans, missing gates, unresolved findings, or incomplete proof
avoidFor:
- One-shot Q&A
- Content-only profiles (blogs, social posts) — use claude-blog or claude-social-media instead
- Small, single-file edits that don't need worktree isolation or memory
- Work that is already complete when the request requires new pre-implementation red-gate evidence
- Tasks that require pushing, opening a pull request, deploying, or merging
- Conventional structured feature delivery that does not need a graph, isolated worktrees, or retryable
  nodes
prerequisites:
- id: git-worktree
  description: Start Trellage from a valid Git worktree with a named branch and a clean tracked worktree.
- id: testable-objective
  description: State a concrete repository outcome with deterministic validation commands or discoverable project checks.
workflows:
- id: implement-complex-change
  description: Start a dependency-aware implementation run with explicit behavior, compatibility, test,
    review, integration, and completion constraints.
  skill: graph-of-loops
  examples:
  - Implement idempotent webhook delivery across storage, handlers, retries, and tests without changing the public API
  - Add a scalar and SIMD parser with differential tests, cross-target compilation, benchmarks, and review
  promptTemplate: |
    /graph-of-loops OBJECTIVE="{{intent}}" CONSTRAINTS="Inspect the existing design before planning. Divide the work into dependency-aware nodes with exact read, write, test, and repair ownership. Preserve public APIs, persisted formats, and unrelated behavior. Require deterministic red-green-final gates for every behavior-changing node, all relevant repository checks, Codex review with no unresolved findings, rebase-first fast-forward-only integration, cleanup of generated worktrees, and root Bead closure. Do not push, create a pull request, deploy, or merge."
- id: debug-cross-cutting-failure
  description: Reproduce and repair a non-obvious failure across multiple modules while preserving exact
    evidence, regression tests, review, and integration state.
  skill: graph-of-loops
  examples:
  - Diagnose why concurrent retries create duplicate rows and fix every contributing race
  - Find why the cross-target build passes locally but fails in the locked profile
  promptTemplate: |
    /graph-of-loops OBJECTIVE="{{intent}}" CONSTRAINTS="Reproduce the failure before changing code. Use repository evidence to separate symptoms from root causes. Create dependency-aware debug, repair, regression-test, and validation nodes with non-overlapping ownership where possible. Require the original failure to be captured by a deterministic red gate, the identical gate to pass green, all final checks to pass, Codex findings to be resolved, and integration to use rebase plus fast-forward only. Do not weaken tests or bypass a failed gate."
- id: research-then-implement
  description: Use validated research fan-out only when an implementation decision needs competing
    approaches, then gate the chosen approach through normal TDD and review nodes.
  skill: graph-of-loops
  examples:
  - Compare durable queue designs, select one against repository constraints, then implement it
  - Research safe portable SIMD strategies for the supported targets before coding the selected design
  promptTemplate: |
    /graph-of-loops OBJECTIVE="{{intent}}" CONSTRAINTS="Use a research node only for unresolved design evidence. Fan out credible alternatives, preserve sources and claims, and require deterministic claim-ledger validation before any dependent implementation node starts. The final plan must still include exact code ownership, behavior-level TDD gates, repository validation, Codex review, rebase-first fast-forward-only integration, and root Bead closure. Do not treat research prose as implementation proof."
- id: validate-existing-implementation
  description: Audit and repair an existing multi-part implementation when validation, portability, review,
    or integration may still be incomplete.
  skill: graph-of-loops
  examples:
  - Validate the existing authentication migration across unit, integration, and upgrade paths and repair all failures
  - Audit the current SIMD implementation on every supported target without claiming performance that was not measured
  promptTemplate: |
    /graph-of-loops OBJECTIVE="{{intent}}" CONSTRAINTS="First determine which requested behavior already exists and which work remains. Do not invent a behavior-changing node only to manufacture red-gate history. Use validation or repair nodes for existing code, and use TDD nodes only for newly required behavior that can honestly demonstrate red then green. Run all applicable format, lint, type-check, build, test, portability, and benchmark gates. Resolve Codex findings and close the root Bead only when the repository state proves the objective."
- id: inspect-or-resume-run
  description: Inspect or continue a known 12-character Graph run ID without replacing its durable state.
  skill: graph-of-loops
  examples:
  - Check status for run 475441f36c6c and resume it if the recorded blocker is now fixed
  - Resume run b45a718d0e42 from its current reviewed plan without replanning
  promptTemplate: |
    /graph-of-loops {{intent}}. Start with a direct trellage-graph status command for the named 12-character run ID. If continuation is requested, use plain resume to preserve the current reviewed plan. Use resume --replan only when the current generation is stale or semantically blocked and the controller confirms supersession is safe. Report the exact durable blocker if the run still cannot advance.
---

# claude-graph-of-loops

## Use This Profile When

- The task spans multiple coding nodes/steps and needs the ability to resume, retry, or roll a step back rather than commit to a single linear pass.
- You want curated specialist agent roles (`team-implementer`, `tdd-workflows-tdd-orchestrator`, `team-debugger`, `conductor-validator`, plus the Trellage-owned planner and `insane-research`) staffed instead of a single generalist agent.
- You need a research fan-out that is gated by deterministic claim-ledger
  validation (`validate_ledger.py`), not just competing write-ups.
- You need deterministic ownership, gates, review, and integration to be the
  completion authority instead of an agent saying the task is done.
- You expect interruption or repair cycles and need the same run to retain its
  plan generations, Beads, findings, and evidence.
- You specifically need the Sandbox graph, isolated worktrees, and retryable nodes; a conventional structured
  engineering workflow is less suitable when those controls are unnecessary.

## Avoid This Profile When

- The request is a one-shot question or a single small edit — the worktree/memory/gate machinery is unnecessary overhead.
- The deliverable is content, not code — use claude-blog or claude-social-media instead.
- The requested change is already complete but the prompt demands a new
  historical red gate. Use a validation request that permits `validate` and
  `repair` nodes instead of asking Graph to fabricate pre-implementation
  evidence.
- You need the agent to push, create a pull request, deploy, or merge. This
  profile blocks those actions.

## Use with `trx guide`

Select this profile when you already know Graph is appropriate:

```bash
trx guide \
  --profile sandbox:claude-graph-of-loops \
  --intent "Validate and repair the existing SIMD implementation across every supported architecture"
```

Omit `--profile` when you want `trx guide` to compare all available profiles
first. Add `--json` when another tool will consume the recommendation and
generated prompt candidates.

Write `--intent` as the outcome you need. The selected workflow expands it
into the explicit `/graph-of-loops` entrypoint and adds the correct planning,
gate, review, integration, and delivery constraints. Useful intent shapes
include:

- `Implement <complex behavior> while preserving <public contract>.`
- `Reproduce and repair <cross-cutting failure>.`
- `Research <design choice>, select an approach, and implement it.`
- `Validate and repair the existing <multi-part implementation>.`
- `Check or resume Graph run <12-character run ID>.`

## Prompt Design for Best Results

Give Graph a destination and constraints, not a proposed node list. The
planner must discover the repository and choose grounded module seams itself.

Put these elements in `OBJECTIVE`:

- The user-visible or repository-visible outcome.
- The behavior that must change or remain stable.
- The concrete subsystem when known.

Put these elements in `CONSTRAINTS`:

- Public API, storage, compatibility, architecture, and dependency limits.
- Required edge cases and failure modes.
- Required format, lint, type-check, build, test, benchmark, or target checks.
- Review, proof, integration, and delivery restrictions.

Do not prescribe invented file paths, symbols, test commands, or node IDs.
Graph discovery and plan audit will reject unsupported details. Do not require
fresh red-gate evidence for behavior that is already present at the selected
Git base; ask Graph to validate and repair the existing implementation instead.

### Strong implementation prompt

```text
/graph-of-loops OBJECTIVE="Make webhook delivery idempotent so concurrent duplicate events cannot create duplicate records" CONSTRAINTS="Preserve the public API and storage format. Inspect existing transaction and retry behavior before planning. Test concurrent duplicates, partial-failure retries, malformed event IDs, and normal unique events. Run all relevant format, lint, type-check, build, and test commands. Require deterministic red-green-final gates, Codex review, rebase-first fast-forward-only integration, and root Bead closure. Do not push, create a pull request, deploy, or merge."
```

### Strong validation prompt for existing code

```text
/graph-of-loops OBJECTIVE="Validate and repair the existing portable parenthesis matcher across scalar, AVX2, and NEON backends" CONSTRAINTS="Do not manufacture pre-implementation red history for code already present. Use validation or repair nodes for existing behavior. Compare supported SIMD implementations with the scalar reference, compile and link all configured targets, run native tests only where supported, benchmark sparse and dense inputs, and make no performance claim without measurements. Resolve all Codex findings and close the root Bead only after every applicable gate passes."
```

### Resume an existing run

```text
/graph-of-loops Check status for run 475441f36c6c, resume it from the current reviewed plan if safe, and report the exact persisted blocker if it cannot advance.
```

## Workflow Notes

- Graph execution is **explicit-only**. It starts when the user invokes
  `/graph-of-loops OBJECTIVE="..." CONSTRAINTS="..."`. That invocation calls
  the `trellage-graph` CLI (`run`, `status`, `resume`, `validate-plan`,
  `finding reject <finding-id> --run <run-id> --evidence <path>`); it is not automatic, and the outer Claude session does
  not route or simulate graph work on its own from a bare description of the
  task. See the profile's
  [README](../../profiles/claude-graph-of-loops/README.md) for the full
  command contract.
- `run` prints a durable run ID before the first planner call. `status`
  reports pre-accept phases, and `resume` continues the same run after
  planning infrastructure, validation, or Beads bootstrap failures without
  regenerating a current reviewed plan. It also retries only a failed
  candidate-plan audit when candidate provenance and the Git base still match.
  `resume --replan` is the explicit, guarded path for a blocked or stale plan
  generation. A `/graph-of-loops` request that explicitly names an existing
  12-character run ID may start with direct `status` or `resume`; it does not
  need to create a replacement run.
- The control plane wires together: a pre-accept lifecycle journal, Beads as
  the accepted graph and
  repair-state authority, Bernstein for dependency-ordered ready waves and
  worktree creation (rebase-first, fast-forward-only integration), a bounded
  Waku loop per node (only `run_specialist` and `run_gate` tools, model text
  is never completion authority), Serena symbol/reference discovery (with a
  recorded fallback if it cannot start), curated `wshobson/agents` specialist
  roles, `insane-research` fan-out for research nodes, and TDD red/green/
  final-gate evidence for behavior-changing nodes.
- Research nodes run through a Trellage-owned headless adapter for the
  `insane-research` role. They write the upstream validator's session layout,
  and the controller invokes locked `validate_ledger.py --session <path>`
  before preserving the claim ledger, source registry, outputs, and state.
- The planner performs bounded discovery through an exact read-only Serena
  allowlist before fixing node dependencies and ownership sets.
  Symbol/reference lookup is preferred; read-only file and pattern tools cover
  relevant repository languages not served by active language servers.
  Generated Graph state, agent work, dependencies, and build output are
  excluded. Native structured output or JSON result text is accepted only
  after local schema validation. Evidence-rich prose or schema-invalid
  structured discovery gets one bounded, tool-free normalization attempt that
  may only restructure supplied facts; missing or schema-invalid normalized
  discovery fails closed. It returns a grounded plan or durable blocked
  decision. If the model omits fallback evidence, the controller preserves the
  exact observed Serena tool failure. A read-only Codex plan audit checks
  scope, repair ownership, validation coverage, and controller-owned
  claims before acceptance. Gate commands are direct argv only;
  inline `-c`, `-lc`, `-e`, and equivalent evaluation forms are rejected
  statically and at runtime.
- The image provides an exact Rust 1.96.0 toolchain with Cargo, rustfmt,
  Clippy, bundled `rust-lld`, and AArch64/x86_64/i686 musl standard
  libraries. AArch64 code can run natively. x86 targets can be compiled and
  linked, but AVX2 runtime tests and performance measurements require a native
  x86_64 runner.
- The runtime entrypoint restores the locked Cargo target configuration after
  the persistent `/home/agent` volume is mounted, so live gates use
  `rust-lld` instead of the unavailable system `cc`.
- Every `bd` subprocess uses the current worktree's explicit `.beads`
  directory. Resume recovers partial graph bootstrap by namespaced metadata
  and fails closed on duplicate matches.
- Review is a Trellage-owned, ephemeral Codex gate that uses the Trellage
  Docker container as its external sandbox. It does not depend on nested Linux
  user namespaces. Output is validated locally against a locked JSON schema —
  **fail-closed**: a missing binary, nonzero exit, incomplete inspection,
  malformed output, or any returned finding blocks completion and creates a
  Beads repair node, rather than silently skipping review.
- Raindrop proof is repository-opt-in: applicable only when the repository
  declares both `.raindrop/agents.yaml` and a Trellage proof policy;
  otherwise status is `not-applicable`, never a false pass.
- Push, pull request, and deployment are unsupported and blocked: the typed
  schema fixes `[orchestration.authorization]`'s delivery permissions to
  `false`, with no per-invocation override.

## Gotchas

- Staffing is deliberately curated (`agent-teams`, `tdd-workflows`,
  `conductor` from `wshobson/agents`, plus the Trellage-owned planner role
  and `insane-research`) rather than the full upstream `wshobson/agents`
  catalog, to avoid burning the context window and to keep role names unique.
- Runtime allocates a 2g tmpfs; very large intermediate artifacts across
  multiple worktrees can still exhaust it.
- This is an Opus-routed proxy profile and needs the external
  `copilot-proxy-rs_default` Docker network.
- A late-discovered gate, review, or proof failure reopens the affected node
  Bead and the root Bead — do not treat an earlier `status` pass as final
  until the root Bead itself is closed.
