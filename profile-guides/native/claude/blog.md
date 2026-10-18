---
schemaVersion: 2
templates:
  write-new-post: /blog write {{intent}}
  audit-existing-post: /blog analyze {{intent}}
  content-brief: /blog brief {{intent}}
---

# claude / blog

Launch this profile with `trx run claude blog`. It runs on the host and uses the local proxy at `http://127.0.0.1:8080`.

## Use This Profile When

- You need a full-lifecycle blog post (brief, outline, draft, SEO checks, schema, visuals) delivered as a scored, gated artifact rather than an ungated draft.
- You are auditing an existing post for SEO health or AI-citation readiness.
- You are planning an editorial calendar, topic cluster, or multilingual rollout across several posts.

## Avoid This Profile When

- The task is app/feature coding — switch to `trx run codex superpowers` or `trx run copilot hve`.
- The deliverable is a short social post, thread, or carousel — use claude-social-media.
- You just want a quick, ungated draft with no review gate — the delivery contract adds overhead you don't need.

## Workflow Notes

- All commands route through the single `/blog` orchestrator (`skills/blog/SKILL.md`); sub-skills like `blog-write` and `blog-analyze` are dispatched from there, not installed as separate top-level commands.
- `/blog write` and `/blog rewrite` results must clear all 5 delivery-contract gates (score 90+, zero P0 issues) before they are shown to you — expect the agent to iterate internally, up to 3 times, before it either delivers or escalates.
- First-run flow from upstream docs: `/blog strategy <niche>` to scope the site, then `/blog write <topic>`, then `/blog analyze <file-or-url>` to check quality.

## Gotchas

- `blog-chart` is an internal-only sub-skill, not a user-facing command — do not invoke it directly.
- Hero images fall back through Banana MCP, direct Gemini API, premium stock APIs, then Openverse; if none are configured the delivery contract may block on Gate 2/5 until a hero image source resolves.
- This profile uses the local `copilot-proxy-rs` service at `http://127.0.0.1:8080`.
