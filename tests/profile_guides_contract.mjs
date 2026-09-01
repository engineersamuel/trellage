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

process.stdout.write(`profile guides: PASS (${expected.length} profiles)\n`)
