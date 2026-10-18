---
schemaVersion: 2
templates:
  voice-builder: /social-media-skills:voice-builder {{intent}}
  post-writer: /social-media-skills:post-writer {{intent}}
  post-scorer: /social-media-skills:post-scorer {{intent}}
  gemini-carousel: /social-media-skills:gemini-carousel {{intent}}
  niche-research: /social-media-skills:niche-research {{intent}}
  content-matrix: /social-media-skills:content-matrix {{intent}}
  reels-scripting: /social-media-skills:reels-scripting {{intent}}
  youtube-thumbnail: /social-media-skills:youtube-thumbnail {{intent}}
  pinned-comment: /social-media-skills:pinned-comment {{intent}}
  humanize-draft: "{{intent}}"
---

# claude / social-media

Launch this profile with `trx run claude social-media`. It runs on the host and uses the local proxy at `http://127.0.0.1:8080`.

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
- The local `copilot-proxy-rs` service must be available at `http://127.0.0.1:8080`.
