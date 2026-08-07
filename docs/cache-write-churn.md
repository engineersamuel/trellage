# Cache-Write Churn — Measured Findings

Status: **live measurement, ongoing investigation.** Companion to
`docs/lean-ctx-evaluation.md`, which established that cache write is 51-68% of
spend and therefore the largest available lever.

Measured in the running `claude-council` container
(`trellage-claude-claude-council-worktree-clear-forest-905a-*`) against
`copilot-proxy-rs`, using `claude --output-format json` for exact usage
telemetry.

---

## 1. The fixed prefix is ~34,700 tokens

A trivial `-p "Reply with exactly: OK"` call — 4 output tokens — costs:

| condition | cache write | cache read | cost |
|---|---|---|---|
| cold (first call) | 34,715 | 0 | **$0.217** |
| warm (repeat) | 0 | 34,715 | **$0.017** |

**A cold start costs 12.5x a warm one for identical work.** That ratio is just
the price sheet: cache write is $18.75/Mtok, cache read is $1.50/Mtok.

Every session pays this before doing anything useful.

## 2. The cache TTL is 5 minutes, and that is the whole problem

Directly measured by idling between identical calls:

| gap | result |
|---|---|
| 0s | warm — 34,715 cache read |
| 90s | warm — 34,715 cache read |
| 330s (5.5 min) | **cold — 34,715 cache write** |

Confirmed by the telemetry field: `cache_creation.ephemeral_5m_input_tokens`
carries the full amount, `ephemeral_1h_input_tokens` is always 0.

**Five minutes of thinking, reading a diff, or answering a colleague re-bills
the entire prefix at 12.5x.** During heavy development — where gaps between
prompts are routinely longer than five minutes — this is the dominant cost.

### The 1-hour cache is not reachable through this path

Attempted:

```
export ANTHROPIC_BETAS=extended-cache-ttl-2025-04-11
export CLAUDE_CODE_EXTENDED_CACHE_TTL=1h
```

Result: `ephemeral_1h_input_tokens` stayed **0**, `ephemeral_5m_input_tokens`
took the whole block, and a 400s idle still went cold. The beta header is
**not being honored end-to-end** through `copilot-proxy-rs`.

This is the single highest-value open thread: a 1h TTL would convert most cold
starts into warm reads and cut that cost by ~92%.

## 3. What actually occupies the 34.7k prefix

Isolation probes, same trivial prompt:

| configuration | cold cache write | delta |
|---|---|---|
| normal (skills + plugins loaded) | 34,715 | baseline |
| **empty `CLAUDE_CONFIG_DIR`** (no skills/plugins) | 33,457 | **-1,258** |
| tools restricted to `Read` only | 29,166 | **-5,549** |

Findings:

- **Caveman + Council + `CLAUDE.md` (6,262 bytes) cost only ~1,258 tokens
  combined.** The profile's own customization is *not* the problem. Stripping
  it would save ~3.6%.
- **Tool definitions are ~5,549 tokens** — 4.4x more than everything the
  profile adds.
- The remaining **~29,000 tokens is harness-fixed overhead** — Claude Code's
  own system prompt and scaffolding — present even with an empty config and
  reduced toolset.

So the prefix is overwhelmingly upstream harness cost, not Trellage
configuration. Trimming profile content is not where the money is.

## 4. Cost of the churn

At 34,715 tokens per cold start:

| cold starts/day | per day | per month (22d) |
|---|---|---|
| 10 | $6.51 | **$143** |
| 20 | $13.02 | **$286** |
| 40 | $26.04 | **$573** |

For comparison, the tool-restriction trim saves $0.104 per cold start — real,
but an order of magnitude below simply *not going cold*.

Note also that the section-2 task runs in `lean-ctx-evaluation.md` showed
53,000-62,000 cache-write tokens for a single 9-turn session — well above one
prefix write. That indicates **repeated mid-session cache writes as context
grows**, which is a second, separate churn source not yet characterized.

## 5. Ranked levers

1. **Get the 1h cache TTL honored through `copilot-proxy-rs`** (est. ~92%
   reduction on cold-start cost). Currently broken; root cause unknown —
   proxy header passthrough is the prime suspect. **Highest value by far.**
2. **Characterize mid-session cache-write growth** (the 53-62k-per-session
   figure). May indicate context being re-established rather than appended.
3. **Trim tool definitions** (~5,549 tokens, ~16% of prefix) by restricting
   tools per profile to those actually used. Cheap, deterministic, no upstream
   dependency.
4. **Trim profile content** (~1,258 tokens, ~3.6%). Lowest value; Caveman and
   Council are close to free. **Do not sacrifice them for tokens.**

## 6. Reproduction

```bash
docker exec <claude-council-container> bash -lc '
  export PATH=/mise/installs/node/22.17.0/bin:/mise/installs/http-claude/2.1.224:$PATH
  export CLAUDE_CONFIG_DIR=/home/agent/.claude
  export ANTHROPIC_AUTH_TOKEN=trellage-local-proxy
  export ANTHROPIC_BASE_URL=http://copilot-proxy-rs:8080
  export ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5
  claude --dangerously-skip-permissions --output-format json -p "Reply with exactly: OK"
' | jq .usage
```

Read `cache_creation_input_tokens` (cold) vs `cache_read_input_tokens` (warm),
and `cache_creation.ephemeral_5m_input_tokens` vs `ephemeral_1h_input_tokens`
to check TTL behavior.
