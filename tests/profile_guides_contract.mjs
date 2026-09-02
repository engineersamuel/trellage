#!/usr/bin/env node
import { readdir, readFile, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  discoverProfileGuideRelativePaths,
  loadProfileGuideRegistry,
  validateProfileGuideCoverage,
} from "../packages/trellage-guide-core/dist/index.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const guideRoot = path.join(root, "profile-guides")

const expected = []
const prototypeEntries = await readdir(path.join(root, "prototypes"), { withFileTypes: true })
const nativeFamilies = prototypeEntries
  .filter((entry) => entry.isDirectory() && /^trellage-.+-profiles$/u.test(entry.name))
  .map((entry) => entry.name)
  .sort()
for (const family of nativeFamilies) {
  const launchers = (await readdir(path.join(root, "prototypes", family, "bin"), { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
  if (launchers.length !== 1) throw new Error(`${family}/bin must contain exactly one launcher`)
  const [launcher] = launchers
  const raw = await readFile(path.join(root, "prototypes", family, "catalog.json"), "utf8")
  const catalog = JSON.parse(raw)
  if (catalog === null || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error(`${family}/catalog.json must contain an object`)
  }
  const profiles = catalog.profiles
  if (profiles === null || typeof profiles !== "object" || Array.isArray(profiles)) {
    throw new Error(`${family}/catalog.json must contain a profile object`)
  }
  for (const profile of Object.keys(profiles)) {
    expected.push({ surface: "native", launcher, profile })
  }
}

for (const entry of await readdir(path.join(root, "profiles"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue
  const profileDocument = path.join(root, "profiles", entry.name, "profile.toml")
  if ((await stat(profileDocument)).isFile()) expected.push({ surface: "sandbox", profile: entry.name })
}

const actual = await discoverProfileGuideRelativePaths(guideRoot)
const coverage = validateProfileGuideCoverage(expected, actual)
if (coverage.missing.length > 0 || coverage.unexpected.length > 0) {
  throw new Error(
    `profile guide coverage mismatch: missing=[${coverage.missing.join(", ")}] unexpected=[${coverage.unexpected.join(", ")}]`,
  )
}

const registry = await loadProfileGuideRegistry(guideRoot, expected)
const operationalWorkflowId =
  /^(?:(?:doctor|health-check|inventory|readiness|setup|smoke-test)|(?:extension|launch|launcher|local|model|profile|proxy)-(?:doctor|health-check|inventory-check|readiness-check|repair|setup|smoke-test))$/u
const operationalExamplePatterns = [
  /\breply exactly\b/iu,
  /\b(?:run|use)\s+(?:the\s+)?(?:profile\s+)?doctor\b/iu,
  /\b(?:check|confirm|verify)\b.*\b(?:profile|proxy|launcher)\b.*\b(?:health|healthy|live|respond(?:s|ing)?)\b/iu,
  /\b(?:repair|set up|setup)\s+(?:the\s+)?(?:profile|launcher)\b/iu,
  /\b(?:what|which|list|check|confirm)\b.*\b(?:extensions?|models?|plugins?)\b.*\b(?:active|advertised|available|installed)\b/iu,
]
const isOperationalExample = (example) =>
  operationalExamplePatterns.some((pattern) => pattern.test(example))

for (const id of ["launch-smoke-test", "health-check", "inventory", "profile-repair", "setup"]) {
  if (!operationalWorkflowId.test(id)) throw new Error(`operational workflow guard missed fixture: ${id}`)
}
for (const id of ["diagnose-sources", "model-selection", "repair-production-data"]) {
  if (operationalWorkflowId.test(id)) throw new Error(`operational workflow guard rejected valid fixture: ${id}`)
}
for (const example of [
  "Please reply exactly PROFILE_OK",
  "Run the profile doctor",
  "Confirm the proxy is healthy",
  "Repair the launcher profile",
  "List which extensions are installed",
]) {
  if (!isOperationalExample(example)) throw new Error(`operational example guard missed fixture: ${example}`)
}
for (const example of [
  "Diagnose why this external source is missing",
  "Choose a stronger model for this refactor",
  "Repair the production data without changing the profile",
]) {
  if (isOperationalExample(example)) throw new Error(`operational example guard rejected valid fixture: ${example}`)
}

for (const [profileRef, loaded] of registry) {
  for (const workflow of loaded.guide.workflows) {
    if (operationalWorkflowId.test(workflow.id)) {
      throw new Error(`${profileRef} guide contains maintenance-only workflow: ${workflow.id}`)
    }
    for (const example of workflow.examples) {
      if (isOperationalExample(example)) {
        throw new Error(`${profileRef}/${workflow.id} contains maintenance-only example: ${example}`)
      }
    }
  }
}

const socialGuide = registry.get("sandbox:claude-social-media")
if (socialGuide === undefined) throw new Error("claude-social-media guide is missing")
const socialWorkflowIds = new Set(socialGuide.guide.workflows.map(({ id }) => id))
for (const workflow of [
  "voice-builder",
  "post-writer",
  "post-scorer",
  "gemini-carousel",
  "reels-scripting",
  "youtube-thumbnail",
  "pinned-comment",
]) {
  if (!socialWorkflowIds.has(workflow)) {
    throw new Error(`claude-social-media guide is missing workflow: ${workflow}`)
  }
}
if (!socialWorkflowIds.has("niche-research") && !socialWorkflowIds.has("content-matrix")) {
  throw new Error("claude-social-media guide must include niche-research or content-matrix")
}
const socialExamples = new Set(
  socialGuide.guide.workflows.flatMap(({ examples }) => examples),
)
for (const example of [
  "Build my voice",
  "Write me a post about AI agents",
  "Score this draft against my history",
  "Make me a carousel from this",
  "What should I post this week",
  "Turn this outlier Reel into a script",
  "I need a thumbnail for 'How I fired my team'",
  "Write me a pinned comment",
]) {
  if (!socialExamples.has(example)) {
    throw new Error(`claude-social-media guide is missing example: ${example}`)
  }
}
if (!socialGuide.guide.prerequisites.some(({ id }) => id === "voice-builder")) {
  throw new Error("claude-social-media guide must declare the voice-builder prerequisite")
}

const headlongGuide = registry.get("sandbox:headlong")
if (headlongGuide === undefined) throw new Error("headlong guide is missing")
const persistentInvestigation = headlongGuide.guide.workflows.find(
  ({ id }) => id === "persistent-investigation",
)
if (persistentInvestigation === undefined) {
  throw new Error("headlong guide is missing persistent-investigation")
}
if (!persistentInvestigation.examples.includes("Investigate intermittent test failures")) {
  throw new Error("headlong persistent-investigation is missing the concise investigation example")
}
for (const phrase of [
  "Keep working between my interactions.",
  "Maintain a durable record of hypotheses and evidence",
  "identify root causes",
  "test potential fixes",
  "local dashboard",
]) {
  if (!persistentInvestigation.promptTemplate.includes(phrase)) {
    throw new Error(`headlong persistent-investigation prompt is missing: ${phrase}`)
  }
}

const councilGuide = registry.get("sandbox:claude-council")
if (councilGuide === undefined) throw new Error("claude-council guide is missing")
const councilWorkflow = councilGuide.guide.workflows.find(({ id }) => id === "run-council-deliberation")
if (councilWorkflow === undefined) throw new Error("claude-council deliberation workflow is missing")
for (const phrase of [
  "Pressure-test this idea and its implementation",
  "Challenge the assumptions",
  "implementation tradeoffs",
  "concrete next steps",
]) {
  if (!councilWorkflow.promptTemplate.includes(phrase)) {
    throw new Error(`claude-council prompt is missing: ${phrase}`)
  }
}

const eccGuide = registry.get("sandbox:claude-ecc")
if (eccGuide === undefined) throw new Error("claude-ecc guide is missing")
const expectedEccWorkflows = new Map([
  ["discover-ecc-workflow", ["ecc:ecc-guide", "/ecc:ecc-guide"]],
  ["plan-change", ["ecc:plan", "/ecc:plan"]],
  ["tdd-implementation", ["ecc:tdd-workflow", "/ecc:tdd-workflow"]],
  ["review-and-verify", ["ecc:code-review", "/ecc:code-review"]],
])
for (const [workflowId, [skill, promptPhrase]] of expectedEccWorkflows) {
  const workflow = eccGuide.guide.workflows.find(({ id }) => id === workflowId)
  if (workflow === undefined) throw new Error(`claude-ecc guide is missing workflow: ${workflowId}`)
  if (workflow.skill !== skill) throw new Error(`claude-ecc workflow uses the wrong skill: ${workflowId}`)
  if (!workflow.promptTemplate.includes(promptPhrase)) {
    throw new Error(`claude-ecc workflow prompt is missing ${promptPhrase}: ${workflowId}`)
  }
}
const eccReviewWorkflow = eccGuide.guide.workflows.find(({ id }) => id === "review-and-verify")
if (eccReviewWorkflow === undefined || !eccReviewWorkflow.promptTemplate.includes("/ecc:verification-loop")) {
  throw new Error("claude-ecc review workflow must finish with verification-loop")
}

const researchGuide = registry.get("sandbox:claude-research")
if (researchGuide === undefined) throw new Error("claude-research guide is missing")
const researchWorkflow = researchGuide.guide.workflows.find(({ id }) => id === "vault-backed-research")
if (researchWorkflow === undefined) throw new Error("claude-research vault-backed workflow is missing")
for (const phrase of ["before implementation", "source-backed evidence", "unresolved questions", "implementation options"]) {
  if (!researchWorkflow.promptTemplate.includes(phrase)) {
    throw new Error(`claude-research prompt is missing: ${phrase}`)
  }
}

const compoundGuide = registry.get("native:cpx/compound-engineering")
if (compoundGuide === undefined) throw new Error("cpx compound-engineering guide is missing")
const expectedCompoundPrompts = new Map([
  ["ce-plan", "/ce-plan {{intent}}"],
  ["lfg", "/lfg {{intent}}"],
  ["ce-compound", "/ce-compound mode:non-interactive {{intent}}"],
])
const compoundSkills = compoundGuide.guide.workflows.map(({ skill }) => skill)
const expectedCompoundSkills = [...expectedCompoundPrompts.keys()]
if (
  compoundSkills.length !== expectedCompoundSkills.length ||
  new Set(compoundSkills).size !== expectedCompoundSkills.length ||
  compoundSkills.some((skill) => !expectedCompoundPrompts.has(skill))
) {
  throw new Error(
    `cpx compound-engineering one-shot skills must be exactly: ${expectedCompoundSkills.join(", ")}`,
  )
}
for (const prohibitedSkill of ["ce-brainstorm", "ce-code-review"]) {
  if (
    compoundGuide.guide.workflows.some(
      ({ skill, promptTemplate }) =>
        skill === prohibitedSkill || promptTemplate.includes(`/${prohibitedSkill}`),
    )
  ) {
    throw new Error(`cpx compound-engineering must not expose ${prohibitedSkill} as a one-shot workflow`)
  }
}
for (const [skill, promptTemplate] of expectedCompoundPrompts) {
  const workflow = compoundGuide.guide.workflows.find((candidate) => candidate.skill === skill)
  if (workflow === undefined) throw new Error(`cpx compound-engineering is missing the ${skill} workflow`)
  if (workflow.promptTemplate !== promptTemplate) {
    throw new Error(`cpx compound-engineering ${skill} must use one direct prompt`)
  }
}

const normalizeSemanticText = (value) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
const workflowSemanticText = ({ description, examples }) =>
  normalizeSemanticText([description, ...examples].join(" "))
const hasSemanticGroupsNear = (
  value,
  anchor,
  groups,
  radius = 260,
) => {
  const semanticText = normalizeSemanticText(value)
  let offset = semanticText.indexOf(anchor)
  while (offset >= 0) {
    const window = semanticText.slice(
      Math.max(0, offset - radius),
      Math.min(semanticText.length, offset + anchor.length + radius),
    )
    if (groups.every((alternatives) => alternatives.some((pattern) => pattern.test(window)))) {
      return true
    }
    offset = semanticText.indexOf(anchor, offset + anchor.length)
  }
  return false
}
const requireWorkflowSemanticGroups = (skill, facts) => {
  const workflow = compoundGuide.guide.workflows.find((candidate) => candidate.skill === skill)
  if (workflow === undefined) throw new Error(`cpx compound-engineering is missing the ${skill} workflow`)
  const semanticText = workflowSemanticText(workflow)
  for (const [fact, groups] of facts) {
    if (!groups.every((alternatives) => alternatives.some((pattern) => pattern.test(semanticText)))) {
      throw new Error(`cpx compound-engineering ${skill} description/examples must document ${fact}`)
    }
  }
}
const requireWorkflowSemanticContext = (skill, fact, anchor, groups) => {
  const workflow = compoundGuide.guide.workflows.find((candidate) => candidate.skill === skill)
  if (workflow === undefined) throw new Error(`cpx compound-engineering is missing the ${skill} workflow`)
  if (!hasSemanticGroupsNear(workflowSemanticText(workflow), anchor, groups)) {
    throw new Error(`cpx compound-engineering ${skill} description/examples must document ${fact}`)
  }
}

requireWorkflowSemanticGroups("ce-plan", [
  [
    "reuse of repository learning",
    [
      [/\breus(?:e|es|ing)\b/u, /\bappl(?:y|ies|ying)\b/u, /\binform(?:ed|ing)\b/u],
      [/\brepositor(?:y|ies)\b/u],
      [/\blearnings?\b/u, /\blessons?\b/u, /\bsolutions?\b/u, /\bknowledge\b/u],
    ],
  ],
])
requireWorkflowSemanticContext(
  "ce-plan",
  "the generated headless Durable path for accepted input, implementation-ready planning, and document review",
  "durable",
  [
    [/\bgenerated\b/u],
    [/\bheadless\b/u],
    [/\braw\b/u],
    [/\bintent\b/u],
    [/\brequirements?\b/u],
    [/\bupstream\b/u],
    [/\bpath\b/u, /\bcontract\b/u, /\bmode\b/u],
    [/\bimplementation ready\b/u],
    [/\bunified\b/u],
    [/\bplans?\b/u],
    [/\bdocuments?\b/u],
    [/\breviews?\b/u],
  ],
)
requireWorkflowSemanticGroups("lfg", [
  [
    "requirements-ready input",
    [
      [
        /\brequirements ready\b/u,
        /\bsettled requirements?\b/u,
        /\bapproved plans?\b/u,
        /\bexisting plans?\b/u,
      ],
    ],
  ],
  [
    "hands-off execution",
    [[/\bhands off\b/u, /\bautonomous\b/u, /\bwithout check ins?\b/u, /\bno check ins?\b/u]],
  ],
  [
    "planning, implementation, and simplification",
    [[/\bplans?\b/u, /\bplanning\b/u], [/\bimplements?\b/u, /\bimplementation\b/u], [/\bsimplif(?:y|ies|ication)\b/u]],
  ],
  [
    "review/fix and browser testing",
    [[/\breviews?\b/u], [/\bfix(?:es|ing)?\b/u], [/\bbrowser\b/u], [/\btests?\b/u, /\btesting\b/u]],
  ],
  [
    "commit, push, open-PR, and CI-watching delivery",
    [
      [/\bcommits?\b/u],
      [/\bpush(?:es|ing)?\b/u],
      [/\bopen\b/u],
      [/\bpr\b/u, /\bpull requests?\b/u],
      [/\bwatch(?:es|ing)?\b/u],
      [/\bci\b/u, /\bcontinuous integration\b/u],
    ],
  ],
  [
    "the default open-PR stop boundary",
    [
      [/\bdefault\b/u],
      [/\bstops?\b/u],
      [/\bopen\b/u],
      [/\bpr\b/u, /\bpull requests?\b/u],
      [/\bdoes not\b/u, /\bdoesn t\b/u, /\bwithout\b/u],
      [/\bmerg(?:e|es|ing)\b/u],
    ],
  ],
  [
    "the explicit stack-land merge exception",
    [
      [/\bexplicit\b/u],
      [/\bstack land\b/u],
      [/\bauthoriz(?:e|es|ing)\b/u],
      [/\b(?:land|lands|landing|merge|merges|merging)\b/u],
    ],
  ],
  [
    "local commits when no remote exists",
    [
      [/\bwithout a remote\b/u, /\bno remote\b/u],
      [/\blocal\b/u],
      [/\bcommits?\b/u],
    ],
  ],
])
requireWorkflowSemanticGroups("ce-compound", [
  [
    "one learning per run",
    [[/\bone\b/u], [/\bper run\b/u]],
  ],
  [
    "one verified non-trivial solved problem",
    [
      [/\bone\b/u],
      [/\bverified\b/u, /\bvalidated\b/u],
      [/\bnon trivial\b/u, /\bsubstantive\b/u],
      [/\bsolved\b/u, /\bresolved\b/u],
      [/\bproblems?\b/u, /\bissues?\b/u],
    ],
  ],
  [
    "future-work learning",
    [
      [/\bfuture\b/u, /\blater\b/u],
      [/\bwork\b/u, /\bplans?\b/u],
      [/\blearnings?\b/u, /\bknowledge\b/u, /\bsolutions?\b/u],
    ],
  ],
  [
    "skipping when no valid learning exists",
    [[/\bskip(?:s|ping)?\b/u], [/\bno\b/u], [/\bvalid\b/u], [/\blearnings?\b/u]],
  ],
])

const compoundBody = compoundGuide.body.replace(/\s+/gu, " ").toLowerCase()
const hasCompoundBodyTermsNear = (
  anchor,
  terms,
  radius = 220,
) => {
  let offset = compoundBody.indexOf(anchor)
  while (offset >= 0) {
    const window = compoundBody.slice(
      Math.max(0, offset - radius),
      Math.min(compoundBody.length, offset + anchor.length + radius),
    )
    if (terms.every((term) => term.test(window))) return true
    offset = compoundBody.indexOf(anchor, offset + anchor.length)
  }
  return false
}
const compoundBodyFacts = [
  [
    "a bare interactive cpx compound-engineering launch",
    hasCompoundBodyTermsNear("cpx compound-engineering", [
      /\binteractive\b/u,
      /\b(?:bare|without (?:a )?`?-p`?)\b/u,
    ]),
  ],
  [
    "manual first-use ce-setup",
    hasCompoundBodyTermsNear("/ce-setup", [
      /\b(?:first|once)\b/u,
      /\brepositor(?:y|ies)\b/u,
      /\bmanual(?:ly)?\b/u,
    ], 320),
  ],
  ["interactive /ce-brainstorm <intent>", /\/ce-brainstorm\s+<intent>/u.test(compoundBody)],
  [
    "a same-session handoff to ce-plan or lfg",
    hasCompoundBodyTermsNear("same-session", [
      /\bhandoff\b/u,
      /\bce-plan\b/u,
      /\blfg\b/u,
    ]),
  ],
  [
    "one-skill one-shot guide generation",
    hasCompoundBodyTermsNear("one-shot", [
      /\b(?:one|single)[ -]skill\b/u,
      /\b(?:generat(?:e|ed|ion)|emit(?:s|ted)?|produc(?:e|es|ed)|command|prompt)\b/u,
    ]),
  ],
  [
    "interactive ce-plan right-sizing outside headless mode",
    hasCompoundBodyTermsNear("/ce-plan", [
      /\binteractive\b/u,
      /\boutside\b/u,
      /\bheadless\b/u,
      /\bright-size\b/u,
      /\bdirect\b/u,
      /\bchat brief\b/u,
    ], 320),
  ],
  [
    "the generated headless Durable planning contract",
    hasCompoundBodyTermsNear("durable", [
      /\bgenerated\b/u,
      /\bheadless\b/u,
      /\bno synchronous user\b/u,
      /\bimplementation-ready\b/u,
      /\bunified plan\b/u,
      /\bdocument review\b/u,
    ], 440),
  ],
  [
    "the promise that each completed unit helps the next",
    hasCompoundBodyTermsNear("completed", [
      /\beach\b/u,
      /\bunit\b/u,
      /\b(?:help|helps|make|makes|improve|improves)\b/u,
      /\bnext\b/u,
    ], 180),
  ],
  [
    "repository-local solution knowledge",
    hasCompoundBodyTermsNear("repository-local", [
      /\bsolutions?\b/u,
      /\bknowledge\b/u,
    ], 180),
  ],
  [
    "the default lfg stop-before-merge boundary",
    hasCompoundBodyTermsNear("/lfg", [
      /\bdefault\b/u,
      /\b(?:does not|doesn't|will not|never|stops? before)\b/u,
      /\bmerg(?:e|es|ing)\b/u,
    ]),
  ],
  [
    "the explicit stack-land merge exception",
    hasCompoundBodyTermsNear("stack-land", [
      /\bexplicit\b/u,
      /\bauthoriz(?:e|es|ing)\b/u,
      /\b(?:land|lands|landing|merge|merges|merging)\b/u,
    ], 320),
  ],
  [
    "requirements-ready lfg after brainstorming",
    hasCompoundBodyTermsNear("/lfg", [
      /\bce-brainstorm\b/u,
      /\brequirements?\b/u,
      /\b(?:ready|settled|approved)\b/u,
    ], 520),
  ],
  [
    "chat fallback without the blocking question tool",
    hasCompoundBodyTermsNear("numbered choices", [
      /\bchat\b/u,
      /\bblocking question tool\b/u,
      /\bnext\b/u,
      /\bturn\b/u,
    ], 360),
  ],
  [
    "fresh ce-compound one-shot context",
    hasCompoundBodyTermsNear("/ce-compound mode:non-interactive", [
      /\bdoes not inherit\b/u,
      /\bcpx\b/u,
      /\bconversation\b/u,
      /\broot cause\b/u,
      /\bproof\b/u,
      /\bcurrent tree\b/u,
    ], 520),
  ],
  [
    "implement-only no-publish boundary",
    hasCompoundBodyTermsNear("implementation-only", [
      /\bstop\b/u,
      /\bcommit\b/u,
      /\bpush\b/u,
      /\bmode:return-to-caller\b/u,
      /\bce-work\b/u,
    ], 420),
  ],
  [
    "standalone ce-work shipping tail",
    hasCompoundBodyTermsNear("/ce-work", [
      /\bstandalone\b/u,
      /\bsimplif(?:y|ies|ication)\b/u,
      /\bcode-review\b/u,
      /\bcommit\b/u,
      /\bpush\b/u,
      /\bopen-pr\b/u,
    ], 420),
  ],
  [
    "strong trx guide intent ingredients",
    hasCompoundBodyTermsNear("strong intent", [
      /\boutcome\b/u,
      /\bconstraints?\b/u,
      /\bacceptance criteria\b/u,
      /\b(?:plans?|learnings?)\b/u,
      /\bdelivery boundary\b/u,
    ], 520),
  ],
  [
    "cross-model review risk",
    hasCompoundBodyTermsNear("cross-model", [
      /\breview\b/u,
      /\bexternal\b/u,
      /\b(?:egress|send|transfer)\b/u,
      /\bplan_model\b/u,
      /\bbrainstorm_model\b/u,
      /\bcross_model_review_mode\b/u,
      /\boff\b/u,
    ], 760),
  ],
]
for (const [fact, present] of compoundBodyFacts) {
  if (!present) throw new Error(`cpx compound-engineering guide must document ${fact}`)
}

const pstackGuide = registry.get("native:cdx/pstack")
if (pstackGuide === undefined) throw new Error("cdx pstack guide is missing")
const expectedPstackWorkflows = new Map([
  [
    "poteto-mode-entry-point",
    ["pstack-for-codex:poteto-mode", "$poteto-mode\n$pstack-for-codex:poteto-mode {{intent}}"],
  ],
  ["targeted-single-skill", ["pstack-for-codex:architect", "$pstack-for-codex:architect {{intent}}"]],
  [
    "review-and-polish",
    [
      "pstack-for-codex:interrogate",
      "$pstack-for-codex:interrogate {{intent}}\n$pstack-for-codex:no-comments\n$pstack-for-codex:unslop",
    ],
  ],
])
for (const [workflowId, [skill, promptTemplate]] of expectedPstackWorkflows) {
  const workflow = pstackGuide.guide.workflows.find(({ id }) => id === workflowId)
  if (workflow === undefined) throw new Error(`cdx pstack guide is missing workflow: ${workflowId}`)
  if (workflow.skill !== skill) throw new Error(`cdx pstack workflow uses the wrong skill identity: ${workflowId}`)
  if (workflow.promptTemplate !== promptTemplate) {
    throw new Error(`cdx pstack workflow uses the wrong prompt invocation: ${workflowId}`)
  }
}

const tufteGuide = registry.get("native:cpx/tufte-vdqi")
if (tufteGuide === undefined) throw new Error("cpx tufte-vdqi guide is missing")
const expectedTufteWorkflows = new Map([
  ["critique-visualization", "tufte-critique"],
  ["critique-and-rebuild", "tufte-critique"],
  ["build-tufte-chart", "tufte-chart"],
  ["adjust-monetary-series", "tufte-chart"],
  ["publish-offline-html", "tufte-chart"],
  ["compare-many-series", "tufte-chart"],
  ["compare-distributions", "tufte-chart"],
  ["build-range-frame-scatter", "tufte-chart"],
])
for (const [workflowId, skill] of expectedTufteWorkflows) {
  const workflow = tufteGuide.guide.workflows.find(({ id }) => id === workflowId)
  if (workflow === undefined) throw new Error(`cpx tufte-vdqi guide is missing workflow: ${workflowId}`)
  if (workflow.skill !== skill) {
    throw new Error(`cpx tufte-vdqi workflow uses the wrong skill identity: ${workflowId}`)
  }
  if (!workflow.promptTemplate.includes(skill)) {
    throw new Error(`cpx tufte-vdqi workflow prompt does not invoke its declared skill: ${workflowId}`)
  }
}
const critiqueAndRebuild = tufteGuide.guide.workflows.find(({ id }) => id === "critique-and-rebuild")
if (
  critiqueAndRebuild === undefined ||
  !critiqueAndRebuild.promptTemplate.includes("tufte-critique") ||
  !critiqueAndRebuild.promptTemplate.includes("tufte-chart")
) {
  throw new Error("cpx tufte-vdqi critique-and-rebuild prompt must invoke both skills")
}

const firstmateGuide = registry.get("native:fmx/default")
if (firstmateGuide === undefined) throw new Error("fmx default guide is missing")
const firstmateFleet = firstmateGuide.guide.workflows.find(({ id }) => id === "coordinate-fleet-delivery")
if (firstmateFleet === undefined) throw new Error("fmx default fleet workflow is missing")
const normalizedPrompt = (prompt) => prompt.replace(/\s+/gu, " ")
for (const phrase of [
  "Firstmate operating contract",
  "sole router and integration authority",
  "conservative unregistered posture: `no-mistakes` delivery with `yolo` off",
  "standing registration defaults `no-mistakes-prod-only` and `yolo` off",
  "smallest useful durable task graph and worker count",
  "Ships are the default for implementation",
  "promote an existing scout instead of creating duplicate implementation work",
  "non-overlapping work to isolated worktrees",
  "Confirm each spawned worker is processing its brief",
  "durable status and wake events",
  "Serialize only for a true semantic dependency",
  "Resolve each task to `direct-PR`, `no-mistakes`, or `local-only`",
  "do not offer a false binary",
  "`direct-PR` for confirmed internal-only work",
  "hold green work durably while approval is pending",
  "safe teardown only after required artifacts and delivery state are secured",
  "final report covering the task graph",
]) {
  if (!normalizedPrompt(firstmateFleet.promptTemplate).includes(phrase)) {
    throw new Error(`fmx default prompt is missing: ${phrase}`)
  }
}
const firstmateInvestigation = firstmateGuide.guide.workflows.find(({ id }) => id === "run-fleet-investigation")
if (firstmateInvestigation === undefined) throw new Error("fmx default investigation workflow is missing")
for (const phrase of [
  "sole router and decision authority",
  "Consult existing reports before dispatch",
  "durable task graph",
  "non-overlapping hypotheses",
  "promote the existing scout",
  "safe teardown only after their artifacts are secured",
]) {
  if (!normalizedPrompt(firstmateInvestigation.promptTemplate).includes(phrase)) {
    throw new Error(`fmx default investigation prompt is missing: ${phrase}`)
  }
}

const firstmatePstackGuide = registry.get("native:fmx/pstack-workers")
if (firstmatePstackGuide === undefined) throw new Error("fmx pstack-workers guide is missing")
const disciplinedFleet = firstmatePstackGuide.guide.workflows.find(
  ({ id }) => id === "disciplined-fleet-delivery",
)
if (disciplinedFleet === undefined) throw new Error("fmx pstack-workers fleet workflow is missing")
for (const phrase of [
  "sole router and integration authority",
  "lean pstack-derived inner loop",
  "worker brief",
  "smallest logical change",
  "expected blast radius",
  "`how` walk",
  "`why` history check",
  "real artifact",
  "verification gaps",
  "must not route, merge, or assume captain authority",
  "smallest useful durable task graph and worker count",
  "promote an existing scout",
  "Confirm each spawned worker is processing its brief",
  "do not duplicate its policy section in worker briefs",
  "Resolve each task to `direct-PR`, `no-mistakes`, or `local-only`",
  "hold green work durably while approval is pending",
  "safe teardown only after required artifacts and delivery state are secured",
]) {
  if (!normalizedPrompt(disciplinedFleet.promptTemplate).includes(phrase)) {
    throw new Error(`fmx pstack-workers prompt is missing: ${phrase}`)
  }
}
const disciplinedInvestigation = firstmatePstackGuide.guide.workflows.find(
  ({ id }) => id === "disciplined-parallel-debugging",
)
if (disciplinedInvestigation === undefined) throw new Error("fmx pstack-workers investigation workflow is missing")
for (const phrase of [
  "concrete evidence first",
  "falsified alternatives",
  "evidence-backed final decision",
  "durable status and wake events",
  "promote the existing scout",
  "safe teardown",
]) {
  if (!normalizedPrompt(disciplinedInvestigation.promptTemplate).includes(phrase)) {
    throw new Error(`fmx pstack-workers investigation prompt is missing: ${phrase}`)
  }
}
for (const workflow of [disciplinedFleet, disciplinedInvestigation]) {
  for (const forbidden of ["$poteto-mode", "$pstack-for-codex:", "multi-frontier"]) {
    if (workflow.promptTemplate.includes(forbidden)) {
      throw new Error(`fmx pstack-workers prompt includes forbidden full-pstack behavior: ${forbidden}`)
    }
  }
}

const youtubeGuide = registry.get("native:cdx/youtube")
if (youtubeGuide === undefined) throw new Error("cdx youtube guide is missing")
for (const workflowId of ["transcript-analysis", "youtube-topic-research", "channel-playlist-review"]) {
  const workflow = youtubeGuide.guide.workflows.find(({ id }) => id === workflowId)
  if (workflow === undefined) throw new Error(`cdx youtube guide is missing workflow: ${workflowId}`)
  if (workflow.skill !== "youtube-full") {
    throw new Error(`cdx youtube workflow uses the wrong skill identity: ${workflowId}`)
  }
}
if (!youtubeGuide.guide.prerequisites.some(({ id }) => id === "transcript-api-key")) {
  throw new Error("cdx youtube guide must declare the TranscriptAPI key prerequisite")
}
if (!youtubeGuide.guide.avoidFor.some((item) => /visual analysis/iu.test(item))) {
  throw new Error("cdx youtube guide must state the visual-analysis boundary")
}
if (!youtubeGuide.guide.avoidFor.some((item) => /paid TranscriptAPI credits/iu.test(item))) {
  throw new Error("cdx youtube guide must state the paid-credit boundary")
}
const youtubeGuideText = await readFile(path.join(guideRoot, "native", "cdx", "youtube.md"), "utf8")
for (const phrase of [
  "~/.config/trellage/.env.schema",
  "~/.config/trellage/.env.local",
  "mode `0700`",
  "mode-`0600`",
  "explicit process environment value takes precedence",
  "/api/v2/youtube/channel/resolve",
  "`channel_id`",
  "`resolved_from`",
  "`canonical_url`",
  "do not make a second request",
  "external process argument",
  "exactly one",
  "`--config -`",
  "`--max-redirs 0 --retry 0`",
  "`location = false`",
]) {
  if (!youtubeGuideText.includes(phrase)) {
    throw new Error(`cdx youtube guide must document Varlock setup: ${phrase}`)
  }
}

const graphGuide = registry.get("sandbox:claude-graph-of-loops")
if (graphGuide === undefined) throw new Error("claude-graph-of-loops guide is missing")
const graphWorkflowIds = new Set(graphGuide.guide.workflows.map(({ id }) => id))
for (const workflow of [
  "implement-complex-change",
  "debug-cross-cutting-failure",
  "research-then-implement",
  "validate-existing-implementation",
  "inspect-or-resume-run",
]) {
  if (!graphWorkflowIds.has(workflow)) {
    throw new Error(`claude-graph-of-loops guide is missing workflow: ${workflow}`)
  }
}
for (const workflow of graphGuide.guide.workflows) {
  if (workflow.skill !== "graph-of-loops") {
    throw new Error(`claude-graph-of-loops workflow must select graph-of-loops: ${workflow.id}`)
  }
  if (!workflow.promptTemplate.includes("/graph-of-loops")) {
    throw new Error(`claude-graph-of-loops workflow must invoke the explicit entrypoint: ${workflow.id}`)
  }
}
const implementationWorkflow = graphGuide.guide.workflows.find(
  ({ id }) => id === "implement-complex-change",
)
if (
  implementationWorkflow === undefined
  || !implementationWorkflow.promptTemplate.includes('OBJECTIVE="{{intent}}"')
  || !implementationWorkflow.promptTemplate.includes("red-green-final")
  || !implementationWorkflow.promptTemplate.includes("fast-forward-only")
) {
  throw new Error("claude-graph-of-loops implementation workflow must preserve the full execution contract")
}
const validationWorkflow = graphGuide.guide.workflows.find(
  ({ id }) => id === "validate-existing-implementation",
)
if (
  validationWorkflow === undefined
  || !validationWorkflow.promptTemplate.includes("Do not invent a behavior-changing node")
) {
  throw new Error("claude-graph-of-loops validation workflow must prevent fabricated TDD history")
}
if (!graphGuide.guide.prerequisites.some(({ id }) => id === "git-worktree")) {
  throw new Error("claude-graph-of-loops guide must declare the git-worktree prerequisite")
}
process.stdout.write(`profile guides: PASS (${expected.length} profiles)\n`)
