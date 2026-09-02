# ADR 0002: Waku is a bounded per-node supervisor, not the graph scheduler

## Status

Accepted. This is the implementation contract for Waku node supervision
(`trellage_graph.waku_runtime`) in the `claude-graph-of-loops` profile's
Graph of Loops control plane.

## Context

Waku ships a low-level agent loop (`waku.loop.agent.run_loop`) with a
model-driven tool-call cycle. The Graph of Loops profile needs a bounded
retry-and-gate loop around each executable node's specialist attempts, but
Waku's upstream loop:

- Can return normally after exhausting its iteration budget, which looks like
  a clean exit if the caller only checks the process exit status.
- Can turn a tool exception into an error-shaped string result instead of
  raising, so a naive caller may treat a failed gate as a successful one.
- Has no built-in concept of "this node's required evidence exists," because
  it is a general-purpose personal-assistant loop, not a graph engine.

Two extremes were rejected: giving Waku the whole graph (scheduling, worktree
lifecycle, durable state), or dropping Waku and calling Claude directly with
no bounded retry loop.

## Decision

- **Waku supervises exactly one node at a time**, inside the worktree that
  Bernstein already created for that node. It does not schedule other nodes,
  store durable graph state, or decide graph completion.
- **The Waku tool registry exposes exactly two tools:**
  - `run_specialist` — invokes the node's single authorized Claude role for
    the current phase (for example `team-implementer` for an `implement`
    phase, `tdd-workflows-tdd-orchestrator` for `red`/`green` phases). It refuses to run a
    role not authorized for that node.
  - `run_gate` — invokes one of the node's predeclared gate commands from its
    envelope. It refuses to invoke a command that is not predeclared. Static
    plan validation and runtime execution share one direct-command policy:
    inline shell or interpreter source through `-c`, `-lc`, `-e`, or
    equivalent flags is rejected, including when hidden behind `env` or
    `timeout`. Compound checks use separate gates or a checked-in fail-fast
    script.

  Waku's default personal-assistant tools (calendar, memory store, general
  web/file tools) are not registered for graph nodes.
- **Default execution ceilings** (overridable only through the profile's
  `[orchestration]` block, never by a node plan):
  - Maximum parallel nodes: 3.
  - Maximum Waku iterations per node: 10.
  - Maximum Claude specialist attempts per node: 3.
  - Maximum gate calls per node: 12.
  - Maximum supervisor output tokens per Waku model call: 2,048.
  - Node wall-clock timeout: 1,800 seconds.
- **Completion is event-based, not text-based.** After `run_loop` returns,
  the controller inspects the node's evidence ledger for the exact required
  event sequence (specialist attempt, gate results, and — for
  behavior-changing nodes — red, green, and final-gate events in order). The
  Waku supervisor model's final text is never treated as completion
  authority.
- **Any of the following produces a nonzero node result:** the iteration
  limit is reached, a tool call returns malformed data, a tool result is
  error-shaped, a required event is missing, or a declared gate is left
  unresolved.
- **The supervisor model is a small model** (`claude-haiku-4.5` by default)
  to keep the extra model layer around each specialist attempt cheap; the
  gates, not the supervisor, decide pass or fail.

## Consequences

- Every node result is independently verifiable from its evidence ledger,
  regardless of what the Waku supervisor model said in its final response.
- Waku's iteration-exhaustion and error-string behaviors are treated as
  expected failure modes to detect, not edge cases to special-case away.
- A gate cannot turn a failed command into a successful result with inline
  constructs such as `false || true`; the direct-command interface preserves
  the subprocess exit status observed by the controller.
- The registry restriction means Waku cannot be repurposed mid-run to do
  something the node envelope did not authorize — there is no general tool
  to escape through.
- Nested Claude specialists run headless and noninteractive inside the
  Bernstein worktree, with a sanitized environment that removes parent
  Claude session markers, an isolated `CLAUDE_CONFIG_DIR`, and no host
  credentials; all model traffic goes through `copilot-proxy-rs`. If the
  current directory is not the expected worktree, or the role is not
  authorized for the node, the spawn is refused before any model call.
- Planner and specialist prompts are supplied through stdin. They never rely
  on a positional argument after Claude's variadic tool flags.
- Because ceilings are fixed defaults, a legitimately large node may need to
  be decomposed into smaller graph nodes rather than granted a higher
  ceiling from inside a plan.

## Alternatives considered

- **Use Waku as the whole-graph scheduler and memory layer.** Rejected: this
  would make Waku a second durable-state owner alongside Beads, and its
  personal-assistant design has no notion of dependency-ordered,
  parallel-safe execution.
- **Remove Waku entirely and call Claude directly per node.** Rejected: the
  user explicitly chose to integrate Waku's readable inner loop, and a
  restricted node loop adds useful bounded-retry and repair behavior once its
  completion is independently verified by the evidence ledger.
- **Trust Waku's final model text or process exit code as completion
  signal.** Rejected: both are known to report success after iteration
  exhaustion or a swallowed tool error.

## Rollback and review triggers

- **Rollback:** Set `node_runtime` away from `"waku"` only if the profile
  schema later supports an alternative; today, removing the
  `[orchestration]` block removes Waku node supervision entirely along with
  the rest of the Graph of Loops control plane.
- **Review this decision if:** the pinned Waku version changes `run_loop`'s
  tool-result or iteration-exhaustion behavior; the fixed execution ceilings
  prove too tight or too loose for real node sizes observed in production
  runs; or evidence-ledger verification is found to miss a real Waku failure
  mode not listed above.
