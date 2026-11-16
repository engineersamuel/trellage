+++
inputs = ["source", "folder", "page", "brief", "max_skills"]
+++
You prepare one design-skill source for a tournament. Builders will build the same website brief, each with the skills of one source, and judges will compare the results. Your job: read the source and say how a builder should use it for this brief.

Source: {{source}}
Your folder: {{folder}}
{{#page}}The page at that URL, as text: `{{page}}` (it names the GitHub repositories the page links to). If the skills live in a repository, clone it into your folder with `git clone --depth 1 <url>`. If the page has no repository, write the page's method as instructions.{{/page}}
{{^page}}The repository is cloned at `{{folder}}/repo`.{{/page}}

# The brief the builders get

{{brief}}

# What to do

1. Find every skill (a folder with a `SKILL.md`) and every Claude plugin (`.claude-plugin/plugin.json`). Read the README to learn the intended use. Repositories often copy the same skill into folders for many tools (`.cursor/`, `.opencode/`, `.agents/`...): pick one copy, preferably the `.claude/` or `skills/` one.
2. Choose the skills that help design and build a polished web storefront from scratch: visual design, typography, colour, layout, motion, UI craft. Leave out skills for other jobs (slides, documents, mobile-native code, review-only skills that need an existing app) unless they clearly improve this build. At most {{max_skills}} skills.
3. Write the instructions a builder needs: which skill to invoke first, the order, and any skill-specific setup (for example "pick one DESIGN.md from design-md/ that suits an umbrella shop and follow it"). Keep the instructions to what this source says; do not add your own design opinions.
4. If getting the skills needs payment (a paid token, licence key, subscription, paid account or paywall), set `paid` to true and say why; such a source is excluded. If it has nothing usable for building a web UI, mark it not usable and say why.

Write `{{folder}}/card.json` with exactly this shape, and nothing else in the file:

```json
{
  "paid": false,
  "usable": true,
  "reason": "one sentence: why usable or why not",
  "title": "short name for the leaderboard",
  "summary": "one or two sentences: what this source gives a designer",
  "skills": ["paths of skill folders, relative to your folder; empty when the source has no skill folder"],
  "plugins": ["paths of plugin folders relative to your folder, only when a skill needs its plugin's commands or agents"],
  "files": ["other files the builder must read, relative to your folder, e.g. one DESIGN.md"],
  "instructions": "text added to the builder's task"
}
```

Then reply with one line: usable or not, and the title.
