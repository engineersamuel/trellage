---
schemaVersion: 1
capabilities:
- multi-node-coding-orchestration
- git-worktree-isolation
- specialist-agent-roles
- research-fan-out-with-code-gate
- persistent-task-memory
- tdd-workflow
- structured-codex-review-gate
bestFor:
- Reversible multi-node coding that needs isolated worktrees, persistent memory, and the ability to take
  'done' back
- Long-running feature work that benefits from curated specialist agent roles and a fail-closed Codex review
  gate
avoidFor:
- One-shot Q&A
- Content-only profiles (blogs, social posts) — use claude-blog or claude-social-media instead
- Small, single-file edits that don't need worktree isolation or memory
- Conventional structured feature delivery that does not need a graph, isolated worktrees, or retryable
  nodes
prerequisites: []
workflows:
- id: start-graph-run
  description: Start a `/graph-of-loops` run for a coding objective. The trellage-graph controller plans
    the graph, creates isolated worktrees through Bernstein, and staffs curated specialist roles from
    wshobson/agents, backed by beads memory.
  examples:
  - Run /graph-of-loops to implement the rate-limiter service with OBJECTIVE and CONSTRAINTS arguments
  - Build the billing migration as retryable implementation nodes, keeping each risky change in an isolated
    worktree
  promptTemplate: |
    {{intent}}
- id: fan-out-research-with-gate
  description: Run the insane-research fan-out across candidate approaches, gated by deterministic
    claim-ledger validation (validate_ledger.py) before committing to one.
  examples:
  - Research three approaches to our webhook retry problem and gate them with claim-ledger validation
  - Compare queue designs for this ingest service, then prove the preferred option with a small working
    implementation
  promptTemplate: |
    {{intent}}
- id: resume-with-review-gate
  description: Resume a paused `/graph-of-loops` run from persistent Beads state and pass it through the
    Codex review gate before the root Bead can close.
  examples:
  - Resume the auth-refactor graph run and report its status before closing it out
  - Continue the paused authorization migration, retry the failed node, and challenge the completed work
    before marking it done
  promptTemplate: |
    {{intent}}
---

# claude-graph-of-loops

## Use This Profile When

- The task spans multiple coding nodes/steps and needs the ability to resume, retry, or roll a step back rather than commit to a single linear pass.
- You want curated specialist agent roles (`team-implementer`, `tdd-workflows-tdd-orchestrator`, `team-debugger`, `conductor-validator`, plus the Trellage-owned planner and `insane-research`) staffed instead of a single generalist agent.
- You need a research fan-out that is gated by deterministic claim-ledger
  validation (`validate_ledger.py`), not just competing write-ups.
- You specifically need the Sandbox graph, isolated worktrees, and retryable nodes; a conventional structured
  engineering workflow is less suitable when those controls are unnecessary.

## Avoid This Profile When

- The request is a one-shot question or a single small edit — the worktree/memory/gate machinery is unnecessary overhead.
- The deliverable is content, not code — use claude-blog or claude-social-media instead.

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
