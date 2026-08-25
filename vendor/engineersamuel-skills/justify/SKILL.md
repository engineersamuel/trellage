---
name: justify
description: Use when a user asks to justify, defend, validate, verify, or pressure-test a prior claim, recommendation, plan, decision, estimate, or confidence assertion, especially when the answer may depend on repository evidence, current external sources, or adversarial expert judgment.
---

# Justify

Treat justification as an evidence audit, not a more persuasive restatement. Earn the verdict by testing the target against primary evidence, disconfirming evidence, and relevant dissent.

## Workflow

1. State the exact target: the claim, recommendation, decision, or estimate being justified.
2. Separate its factual claims, inferences, assumptions, and value judgments.
3. Route each part to the evidence pass it needs. Use multiple passes when appropriate.
4. Decide from the collected record. Never start with a defense and search only for support.

| Target depends on | Required pass |
| --- | --- |
| Repository state, an artifact, or claimed completed work | Audit the target against local primary evidence. |
| Public, current, comparative, or externally verifiable facts | Research external claims with an available web search or research tool. |
| A consequential, contested, or preference-sensitive judgment | Convene the council after the evidence pass. |

## Audit the target

Inspect primary evidence before accepting summaries: source files, diffs, tests, logs, run artifacts, issue text, data, or the original conversation. Verify claimed actions against current state.

Build a compact claim ledger:

| Claim | Type | Supporting evidence | Counterevidence or gap | Status |
| --- | --- | --- | --- | --- |
| Exact, testable statement | fact, inference, assumption, or value | Primary evidence with a file/line or artifact reference | Strongest conflict or missing proof | supported, mixed, contradicted, or unverified |

Call an inference an inference. Passing tests support only what those tests exercise. A plan, summary, or prior agent statement is not evidence that work happened.

## Research external claims

Use an available web search or research capability for claims that depend on current or external facts. Prefer search or research MCPs such as Exa, Perplexity, Tavily, or Firecrawl when available, but do not require a specific provider. Select tools by capability: use search to discover sources, research or reasoning tools to synthesize broad evidence, and fetch or crawl tools to inspect the full primary source.

Prefer first-party and primary sources; use independent sources to test contested or comparative claims. Search for the strongest disconfirming evidence, not only confirming language. Cite each material external claim with a direct URL and enough title/date context for the user to verify it. Distinguish publication date from the date an event or measurement occurred.

## Convene the council

Invoke the available `council` skill or deliberation workflow for consequential or genuinely ambiguous judgments. Do this after the evidence pass so every member receives the same evidence packet rather than inventing facts independently.

Ask the council to examine the strongest case for and against the target, hidden assumptions, plausible alternatives, falsifiers, and a verdict. Synthesize by reasons and evidence, not majority vote. Preserve dissent when it depends on an unresolved fact, risk tolerance, or value judgment.

Do not use council agreement as proof of a factual claim.

## Decide and report

Use one verdict:

- **Justified** — decisive claims are supported and counterevidence does not overturn the conclusion.
- **Partially justified** — the direction has support, but a material claim, scope, or confidence level does not.
- **Not justified** — decisive evidence contradicts the target or the reasoning does not support the conclusion.
- **Insufficient evidence** — missing proof prevents a responsible verdict.

Report, in this order:

1. Verdict and calibrated confidence.
2. The exact target and claim ledger.
3. Decisive supporting and disconfirming evidence.
4. Council synthesis and preserved dissent, when used.
5. Missing proof, the clearest falsifier, and the cheapest next check.
6. Source links and local artifact references.

Keep the output proportional. Omit unused passes and say why they were unnecessary.

## Fail closed

- If the target is not recoverable from the prompt or conversation, ask one precise question and stop.
- If a required source, artifact, external research capability, or council capability is unavailable, name what is unavailable and how that limits the result. Use an alternative tool only when it can supply the same class of evidence.
- A role-played or single-agent simulated council is not a council pass. Never label invented personas or your own second opinion as council output.
- If a required pass cannot be completed, label the overall result `Incomplete — <missing pass>` or return **Insufficient evidence**. Do not silently skip it.
- If evidence conflicts, surface the conflict and lower confidence. Do not average incompatible facts into false certainty.
- Do not fabricate evidence, citations, tool results, council opinions, or confidence.
- Do not expand into implementation or a new recommendation unless the user asks.

Stop when the decisive claims have primary support, the strongest realistic counterclaim has been tested, and remaining uncertainty is explicit.
