# lean-ctx Evaluation — Negative Result

Status: **evaluated, not adopted.** Recorded so the finding is not re-discovered.

Date of measurement: session `019fdc8c`, worktree `worktree-clear-forest-905a`,
measured live inside the real `claude-council` container against `copilot-proxy-rs`.

Upstream: https://github.com/yvgude/lean-ctx

---

## 1. What was verified (settled facts)

These were executed, not read from docs:

- The pinned **linux-musl aarch64 binary runs unmodified** in the Trellage container.
- Claude sees all six tools over stdio MCP:
  `mcp__lean-ctx__ctx_call, ctx_glob, ctx_read, ctx_search, ctx_shell, ctx_tree`
- Claude genuinely calls `ctx_*` and produces a correct answer.

**Upstream docs are wrong about the entrypoint.** `lean-ctx --mcp` does not exist:

```
$ lean-ctx --mcp
lean-ctx: unknown command '--mcp'
       run 'lean-ctx help' for the full command list
```

The stdio MCP server is the **bare `lean-ctx` command with no arguments**.

So technical viability is not the open question. Value is.

## 2. Measured token result — inconsistent

Identical task (read 7 files under `packages/trellage-cli/src`, summarize),
identical model, two paired runs:

| run | cache write | cache read | output | turns | cost | sec |
|---|---|---|---|---|---|---|
| OFF r1 | 61,880 | 263,176 | 1,868 | 9 | $0.565 | 32 |
| OFF r2 | 53,011 | 242,847 | 1,849 | 9 | $0.526 | 43 |
| ON r1 | 38,818 | **180,041** | 2,198 | 7 | **$0.388** | 33 |
| ON r2 | 45,015 | **394,623** | 3,020 | 13 | $0.554 | **131** |

Run 1 was a real win: ~31% fewer cache-read tokens, 31% cheaper.
Run 2 reversed it: 13 turns instead of 9, 62% *more* cache-read, 4x slower.

Averaged, lean-ctx is **roughly break-even on cost and clearly worse on latency**.

The upstream "~91% saving" framing does not survive contact with a live agent
loop. Measuring compression ratio on a *file* is not the same as measuring
tokens across an *agent loop*.

## 3. The failure mode (why it regresses)

Visible in the turn count. Compressed output sometimes does not answer the
question, so the model does a second pass — `signatures`, then `full` — and
**pays for both**.

This risk scales with how *exact* the read must be:

- Orientation / "what does this do" tolerates lossy compression. -> run 1.
- **Editing code does not.** Changing a function needs exact whitespace, exact
  imports, real surrounding lines. A `signatures` view is insufficient by
  construction, so the model escalates to `full` and pays twice. -> run 2.

**Heavy development work is predominantly the second category.** The primary
workload is the one where lean-ctx most often double-pays.

## 4. Cost-structure context

Component split of the same runs (Opus-class rates: in $15, cache write $18.75,
cache read $1.50, out $75 per Mtok):

| run | cache write share | cache read share | output share |
|---|---|---|---|
| OFF r1 | 68.4% | 23.3% | 8.3% |
| OFF r2 | 66.4% | 24.3% | 9.3% |
| ON r1 | 62.6% | 23.2% | 14.2% |
| ON r2 | 50.8% | 35.6% | 13.6% |

Input-side tokens are **86-91% of cost**. Output is under 10%.

Implication: **cache write is 51-68% of spend** — a larger lever than anything
lean-ctx or Caveman touches. See section 7.

## 5. Container constraints (found by doing, not reading)

Relevant to any future baked-in binary, not just lean-ctx:

1. **rootfs is read-only.** `docker cp` into `/usr/local/bin` fails outright.
   A binary must be baked at build time via `[dotfiles]`, exactly as obscura is.
   No runtime install is possible.
2. **`/tmp` is `noexec`, `/workspace` is read-only.** Only `/home/agent` (the
   state volume) is writable **and** executable. Test staging had to go there.
3. **The MCP block is unreachable in this profile.** Confirmed live:
   `TRELLAGE_CLAUDE_RUNTIME_MODE=native-plugin`, while `--strict-mcp-config`
   sits inside `if [[ "$runtime_mode" == hyperresearch ]]` (approx. line 453 of
   `prototypes/trellage/trellage`). **The entry script had to be bypassed
   entirely to run this test.** Un-gating that is the actual blocking work for
   any seamless MCP integration.

## 6. State-isolation hazard (independent of tokens)

`lean-ctx` writes `~/.config/lean-ctx/` and `~/.local/state/lean-ctx/` on first
run and **caches its project root**. On the `/home/agent` state volume that
persists across sessions. The sticky root already caused a wrong-root incident
on the host.

Across many sessions and many worktrees — i.e. heavy development — this is a
silent wrong-file hazard. It would require per-session `LEAN_CTX_*` env pointing
at a session-scoped path before it could be considered safe.

## 7. Decision

**Do not build the compiler integration.** Parked as a documented negative result.

Rationale: the remaining work is non-trivial (un-gate the `hyperresearch` MCP
block, bake the binary via `[dotfiles]`, add per-session state isolation) for a
tool whose single good run came from the task type this project does least.

Reconsider only if a larger paired A/B (5-8 runs across mixed task types) shows
a durable win on read-heavy work specifically — in which case the right design
is **selective enablement**, not fleet-wide.

### Caveman, by contrast: keep

Caveman compresses **output**, which is under 10% of cost. Its measured 65%
output reduction is therefore roughly **5-6% of total spend** — real but small.
Its actual value is ergonomic: no tool-call narration, no preamble, no
decorative tables. It is already pinned and `always_on = true` on
`claude-council`, costs nothing, and its worst failure mode is a clipped-reading
reply. Keep it — but do not count it as a token strategy.

### Next lever

Cache **write** volume (51-68% of cost) is context being re-established rather
than reused. That, not output compression, is where the money is.
