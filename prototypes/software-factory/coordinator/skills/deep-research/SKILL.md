---
name: deep-research
description: >-
  Cited deep research on external facts: current products, libraries, APIs, standards, prices, benchmarks
  and prior art. Plans 3-5 angles, gathers evidence with Perplexity, Context7 and web search (with fallbacks
  when a tool is missing or fails), keeps a claim ledger, and writes a report where every claim has a source.
  Use when a task needs evidence from outside the repository.
---

# Deep research

You work without a human. Do not ask questions. When something is unclear, choose the most likely reading,
write it under **Assumptions**, and continue.

Method sources (MIT): Anthropic's research lead, subagent and citation prompts
(github.com/anthropics/claude-cookbooks, patterns/agents/prompts) and the claim ledger of
github.com/sjarmak/coding-agent-workflows (deep-research skill).

## 1. Tools and fallbacks

Check which tools you have before you plan. Use the first one that works in each row.

| Need | First choice | Fallback 1 | Fallback 2 |
|---|---|---|---|
| Fast facts, URLs | `perplexity_search` | Exa `web_search_exa` | your built-in web search (`WebSearch`, `web_search`), or `curl -sL "https://html.duckduckgo.com/html/?q=<query>"` |
| Short answer with citations | `perplexity_ask` | Exa search, then read 2-3 pages | built-in search, then fetch |
| Hard multi-source question | `perplexity_research` | 3-5 Exa searches, then read the best pages | built-in search and fetch |
| Analysis of evidence you have | `perplexity_reason` | reason yourself from your evidence files | — |
| Read one page | Exa `web_fetch_exa` | your built-in fetch (`WebFetch`, `web_fetch`) | `curl -sL <url>` |
| Library or API docs | Context7 `resolve-library-id`, then `query-docs` | the library's official docs site through fetch | its repository README through fetch |

Rules for tools:

- A tool **fails** when it returns an error, a timeout, a 401/403/429, or an empty result. Retry once only for a
  timeout or a 429. Then use the next column for the rest of the task, and write the switch in **Tool log**.
- If the task says an MCP server is unavailable, start in the fallback column for that row.
- If no search tool works at all, stop. Write the report with status `blocked: no search tool` and the errors.
- Budget per task: at most 15 Perplexity calls, and at most 2 `perplexity_research` calls (each one costs money
  and can take 1-5 minutes). The factory enforces this: a call over the budget is refused, which counts as a
  failure, so use the fallback column. Use `perplexity_research` only for an angle that search could not answer.
- Context7: at most 3 calls per library question.
- Never paste secrets, tokens or private repository code into a search query.

## 2. Scope

**Paths.** Every relative path in this skill and in the task (`research/...`, `reports/...`) is relative to the
working directory the session started in. Run `pwd` once at the start and build absolute paths from it. Never put
these files in a subfolder, even when the topic is about that subfolder.

Write a brief to `research/<slug>/brief.md`:

- The question, in one line.
- The decision the answer must support.
- What "done" means: the facts that, once known, settle the decision.
- **Assumptions**.
- Size: **quick** (one fact or one comparison of 2 options) or **deep** (anything else).

## 3. Plan angles

- quick: 1 angle, no `perplexity_research`.
- deep: 3-5 angles that do not overlap. At least one angle tries to **refute** the most likely answer (look for
  failures, deprecations, counter-benchmarks, open issues).

For each angle write: its question, the tools it uses, and the stop rule (what evidence ends it).

## 4. Gather evidence

**deep size: run the angles in parallel subagents, one subagent per angle, all started in the same turn.** Use the
subagent tool your harness has:

| Harness | Subagent tool |
|---|---|
| Claude Agent SDK | `Task` (or `Agent`) |
| GitHub Copilot SDK | `task` |
| Pi SDK | `subagent` (pi-subagents) with agent `research-angle`, `async: false`, one call per angle in parallel |

Give each subagent: its angle and stop rule, the section 1 tool table and rules, the absolute path of its evidence
file, and the instruction to return a 5-line summary. The subagents share your Perplexity budget. Only when no
subagent tool exists (check your tool list), or quick size, run the angles yourself, one after the other, and say
so in the **Tool log**.

For each angle write `research/<slug>/evidence/<angle>.md`:

- Each finding as one line: the claim, the source URL, the source date, and the source kind (primary docs,
  vendor claim, paper, independent test, forum).
- Prefer primary sources and dates from the last 12 months. Mark older sources with their year.
- Stop the angle when its stop rule is met, or after 8 tool calls with nothing new.

## 5. Claim ledger

Write `research/<slug>/ledger.md`, one row per claim the report will use:

| Claim | Status | Sources |
|---|---|---|

Status is one of:

- **supported**: 2 independent sources, or 1 primary source.
- **disputed**: sources disagree. Give both sides.
- **inferred**: your reasoning from supported claims. Say from which.
- **unverified**: 1 non-primary source only.

## 6. Write the report

Write the report from the evidence files and the ledger only. Do not add facts from memory.
Save it to the report path the task names (default `reports/deep-research.md`):

1. **TL;DR**: one line with the answer and the main risk.
2. **Answer**: the recommendation, tied to the decision in the brief.
3. **Comparison** (when there are options): a table with the facts that decide.
4. **Evidence**: the claims with status and inline source links.
5. **Dissent and risks**: disputed claims and what the refuting angle found.
6. **Limits**: what was not checked, and the **Tool log**: the count of each tool from your actual calls
   (subagents included; count, do not estimate), refused calls, failures, fallbacks, and whether angles ran in
   parallel subagents.
7. **Sources**: numbered URLs with dates.

## 7. Check citations

Read the report once more. For each sentence with a number, a version, a date or a ranking:

- It has a source link, and the source says it. If not, fix it, mark it unverified, or remove it.
- Its ledger status is not hidden: a disputed or unverified claim is not written as a fact.

Then return the report path.
