---
schemaVersion: 1
capabilities:
- blog-post-writing
- seo-optimization
- content-briefs-and-outlines
- editorial-calendars
- ai-citation-readiness-audit
- multilingual-publishing
- content-repurposing
bestFor:
- Long-form technical blog posts and docs-as-blog content that need a full 5-gate delivery contract
- SEO and AI-citation-readiness audits of existing published posts
- Editorial calendars, content briefs, outlines, and topic-cluster planning
avoidFor:
- App coding sprints or feature implementation
- Short-form social copy (use claude-social-media instead)
- One-off Q&A without a delivery-contract need
prerequisites: []
workflows:
- id: write-new-post
  description: Generate a new blog post from a topic and push it through the 5-gate delivery contract
    (capability discovery, format completeness, visual verification, content review, asset/link integrity).
  skill: blog-write
  examples:
  - Write me a blog post about zero-trust networking for platform engineers
  - /blog write agentic coding workflows for enterprise teams
  - Create a reviewed docs-as-blog article that explains our new deployment model to SRE leads
  promptTemplate: |
    /blog write {{intent}}
- id: audit-existing-post
  description: Score an existing draft or published URL against the 0-100 quality rubric and surface P0/P1
    issues.
  skill: blog-analyze
  examples:
  - Analyze https://example.com/blog/my-post for SEO and citation gaps
  - Audit this published engineering post and list the P0 issues blocking publication
  promptTemplate: |
    /blog analyze {{intent}}
- id: content-brief
  description: Produce a detailed content brief for a topic before any writing starts.
  skill: blog-brief
  examples:
  - Give me a content brief for a post about Kubernetes cost optimization
  - Plan a three-post topic cluster for platform-engineering observability
  promptTemplate: |
    /blog brief {{intent}}
---

# claude-blog

## Use This Profile When

- You need a full-lifecycle blog post (brief, outline, draft, SEO checks, schema, visuals) delivered as a scored, gated artifact rather than an ungated draft.
- You are auditing an existing post for SEO health or AI-citation readiness.
- You are planning an editorial calendar, topic cluster, or multilingual rollout across several posts.

## Avoid This Profile When

- The task is app/feature coding — switch to codex-superpowers, claude-graph-of-loops, or copilot-hve.
- The deliverable is a short social post, thread, or carousel — use claude-social-media.
- You just want a quick, ungated draft with no review gate — the delivery contract adds overhead you don't need.

## Workflow Notes

- All commands route through the single `/blog` orchestrator (`skills/blog/SKILL.md`); sub-skills like `blog-write` and `blog-analyze` are dispatched from there, not installed as separate top-level commands.
- `/blog write` and `/blog rewrite` results must clear all 5 delivery-contract gates (score 90+, zero P0 issues) before they are shown to you — expect the agent to iterate internally, up to 3 times, before it either delivers or escalates.
- First-run flow from upstream docs: `/blog strategy <niche>` to scope the site, then `/blog write <topic>`, then `/blog analyze <file-or-url>` to check quality.

## Gotchas

- `blog-chart` is an internal-only sub-skill, not a user-facing command — do not invoke it directly.
- Hero images fall back through Banana MCP, direct Gemini API, premium stock APIs, then Openverse; if none are configured the delivery contract may block on Gate 2/5 until a hero image source resolves.
- This profile is Opus-routed via `copilot-proxy-rs` and requires the same external `copilot-proxy-rs_default` Docker network as other proxy-backed Claude profiles.
