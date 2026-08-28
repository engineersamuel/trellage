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

const researchGuide = registry.get("sandbox:claude-research")
if (researchGuide === undefined) throw new Error("claude-research guide is missing")
const researchWorkflow = researchGuide.guide.workflows.find(({ id }) => id === "vault-backed-research")
if (researchWorkflow === undefined) throw new Error("claude-research vault-backed workflow is missing")
for (const phrase of ["before implementation", "source-backed evidence", "unresolved questions", "implementation options"]) {
  if (!researchWorkflow.promptTemplate.includes(phrase)) {
    throw new Error(`claude-research prompt is missing: ${phrase}`)
  }
}

process.stdout.write(`profile guides: PASS (${expected.length} profiles)\n`)
