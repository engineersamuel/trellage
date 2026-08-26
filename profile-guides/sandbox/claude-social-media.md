---
schemaVersion: 1
capabilities:
- voice-profile-building
- linkedin-post-drafting
- post-performance-scoring
- carousel-generation
- content-idea-planning
- reel-script-reverse-engineering
- youtube-thumbnail-prompting
- pinned-comment-generation
- ai-writing-tell-removal
bestFor:
- Public short-form content across LinkedIn, Instagram, X, and YouTube that must sound like a real person
- Turning a newsletter or outlier post into other content formats (carousels, reel scripts, thumbnails,
  pinned comments)
avoidFor:
- Long-form SEO blogs or docs-as-blog — use claude-blog instead
- Deep multi-source research — use claude-research instead
- Engineering delivery or app coding
prerequisites:
- id: voice-builder
  description: Run voice-builder first in this project so about-me.md and voice.md exist. Every downstream
    social-media skill reads these files before drafting anything.
- id: apify-api-token
  description: Optional. Set APIFY_API_TOKEN to enable Apify-backed workflows such as post-scorer (pulling
    post history) and reels-scripting (reverse-engineering an outlier Reel).
- id: google-ai-api-key
  description: Optional. Set GOOGLE_AI_API_KEY to enable API-backed Google AI workflows such as gemini-carousel.
workflows:
- id: voice-builder
  description: Interview the user and produce about-me.md and voice.md as the foundation every other social-media
    skill reads before drafting.
  skill: social-media-skills:voice-builder
  examples:
  - Build my voice
  promptTemplate: |
    /social-media-skills:voice-builder {{intent}}
- id: post-writer
  description: Draft a LinkedIn post in the user's voice using the voice files produced by voice-builder.
  skill: social-media-skills:post-writer
  examples:
  - Write me a post about AI agents
  promptTemplate: |
    /social-media-skills:post-writer {{intent}}
- id: post-scorer
  description: Pull the user's post history via Apify and score a draft against what actually performs
    for them.
  skill: social-media-skills:post-scorer
  examples:
  - Score this draft against my history
  promptTemplate: |
    /social-media-skills:post-scorer {{intent}}
- id: gemini-carousel
  description: Generate a slide-by-slide carousel from source content, with an approval gate before finalizing.
  skill: social-media-skills:gemini-carousel
  examples:
  - Make me a carousel from this
  promptTemplate: |
    /social-media-skills:gemini-carousel {{intent}}
- id: niche-research
  description: Surface the week's most relevant niche stories (via Reddit, X, and Google, with verified
    dates) to decide what to post this week.
  skill: social-media-skills:niche-research
  examples:
  - What should I post this week
  promptTemplate: |
    /social-media-skills:niche-research {{intent}}
- id: content-matrix
  description: Alternative to niche-research for 'what should I post this week' — pair content
    pillars with 8 formats for 32+ post ideas in one table.
  skill: social-media-skills:content-matrix
  examples:
  - What should I post this week
  - Build me a content matrix from my three pillars
  promptTemplate: |
    /social-media-skills:content-matrix {{intent}}
- id: reels-scripting
  description: Reverse-engineer an outlier Reel via Apify plus Gemini 2.5 Flash and write a new script
    in the user's voice, sourced from their newsletter.
  skill: social-media-skills:reels-scripting
  examples:
  - Turn this outlier Reel into a script
  promptTemplate: |
    /social-media-skills:reels-scripting {{intent}}
- id: youtube-thumbnail
  description: Turn a video title into a branded YouTube thumbnail prompt for Gemini.
  skill: social-media-skills:youtube-thumbnail
  examples:
  - I need a thumbnail for 'How I fired my team'
  promptTemplate: |
    /social-media-skills:youtube-thumbnail {{intent}}
- id: pinned-comment
  description: Write a meme-style pinned comment with a matching image generation prompt.
  skill: social-media-skills:pinned-comment
  examples:
  - Write me a pinned comment
  promptTemplate: |
    /social-media-skills:pinned-comment {{intent}}
- id: humanize-draft
  description: Strip AI writing tells from a drafted post without inventing facts, using the bundled Humanizer
    plugin.
  examples:
  - Make this draft sound less like AI wrote it, don't add or invent claims
  promptTemplate: |
    {{intent}}
---

# claude-social-media

## Use This Profile When

- You need public short-form content (LinkedIn posts, carousels, reel scripts, thumbnails, pinned comments) that sounds like a real person, not generic AI copy.
- You are starting a new content project and need a voice profile (about-me.md, voice.md) built before anything is drafted.
- You want to score a draft against real post-performance history, or reverse-engineer an outlier Reel into a new script.

## Avoid This Profile When

- The deliverable is a long-form SEO blog post or docs-as-blog article — use claude-blog instead.
- The task is deep multi-source research rather than content drafting — use claude-research instead.
- The task is engineering delivery — use a coding profile such as codex-superpowers or copilot-hve.

## Workflow Notes

- Every skill in this profile is voice-first: `voice-builder` produces `about-me.md` and `voice.md`, and every other skill reads those two files before drafting a line. Run voice-builder once per project before anything else.
- 'What should I post this week' can be answered two ways: `niche-research` surfaces fresh outside stories, `content-matrix` maps the user's own content pillars to 8 formats for 32+ ideas. Pick based on whether the user wants outside inspiration or an internal content grid.
- `post-scorer` and `reels-scripting` are Apify-backed and only work with `APIFY_API_TOKEN` set; `gemini-carousel` and related Gemini workflows need `GOOGLE_AI_API_KEY`. Neither is required for the core voice/post-writer flow.
- Humanizer (`blader/humanizer`) is bundled to strip AI writing tells from any draft without inventing facts — use it as a pass over content produced by any of the other skills.

## Gotchas

- Skipping voice-builder produces generic, unvoiced drafts — every downstream skill degrades without `about-me.md`/`voice.md`.
- `APIFY_API_TOKEN` and `GOOGLE_AI_API_KEY` are forwarded only when present in the environment; Trellage never stores them in the profile or lock.
- This is an Opus-routed proxy profile and needs the external `copilot-proxy-rs_default` Docker network.
