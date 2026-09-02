#!/usr/bin/env node
import { spawn } from "node:child_process"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const maximumOutputBytes = 2 * 1024 * 1024
const commandTimeoutMs = 5 * 60 * 1000

const record = (value, name) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value
}

const exactKeys = (value, name, required, optional = []) => {
  const allowed = new Set([...required, ...optional])
  const missing = required.filter((key) => !(key in value))
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key))
  if (missing.length > 0) throw new Error(`${name} is missing keys: ${missing.join(", ")}`)
  if (unexpected.length > 0) throw new Error(`${name} has unexpected keys: ${unexpected.join(", ")}`)
}

const text = (value, name) => {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be text`)
  return value
}

const stringArray = (value, name) => {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  const items = value.map((item, index) => text(item, `${name}[${index}]`))
  if (new Set(items).size !== items.length) throw new Error(`${name} must contain unique entries`)
  return items
}

const rank = (value, name) => {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error(`${name} must be an integer from 1 to 5`)
  }
  return value
}

const expectedWorkflowMap = (value, name, expectedProfiles) => {
  if (value === undefined) return undefined
  const expectedProfileSet = new Set(expectedProfiles)
  const entries = Object.entries(record(value, name)).map(([profileRef, workflowId]) => {
    text(profileRef, `${name} profile key`)
    if (!expectedProfileSet.has(profileRef)) {
      throw new Error(`${name} key ${profileRef} must also appear in expectedProfiles`)
    }
    return [profileRef, text(workflowId, `${name}.${profileRef}`)]
  })
  return Object.fromEntries(entries)
}

export const parseProfileGuideScenarios = (value) => {
  const rootValue = record(value, "profile guide scenarios")
  exactKeys(rootValue, "profile guide scenarios", ["schemaVersion", "scenarios"])
  if (rootValue.schemaVersion !== 1 || !Array.isArray(rootValue.scenarios)) {
    throw new Error("profile guide scenarios must use schemaVersion 1")
  }
  const scenarios = rootValue.scenarios.map((rawScenario, index) => {
    const scenario = record(rawScenario, `scenario ${index}`)
    exactKeys(
      scenario,
      `scenario ${index}`,
      ["id", "intent", "expectedProfiles", "maxRank", "excludedProfiles"],
      ["expectedWorkflows"],
    )
    const expectedProfiles = stringArray(scenario.expectedProfiles, `scenario ${index}.expectedProfiles`)
    if (expectedProfiles.length === 0) throw new Error(`scenario ${index}.expectedProfiles must not be empty`)
    const expectedWorkflows = expectedWorkflowMap(
      scenario.expectedWorkflows,
      `scenario ${index}.expectedWorkflows`,
      expectedProfiles,
    )
    const excludedProfiles = stringArray(scenario.excludedProfiles, `scenario ${index}.excludedProfiles`)
    const excluded = new Set(excludedProfiles)
    const overlap = expectedProfiles.find((profileRef) => excluded.has(profileRef))
    if (overlap !== undefined) throw new Error(`scenario ${index} both expects and excludes ${overlap}`)
    return {
      id: text(scenario.id, `scenario ${index}.id`),
      intent: text(scenario.intent, `scenario ${index}.intent`),
      expectedProfiles,
      ...(expectedWorkflows === undefined ? {} : { expectedWorkflows }),
      maxRank: rank(scenario.maxRank, `scenario ${index}.maxRank`),
      excludedProfiles,
    }
  })
  const ids = scenarios.map(({ id }) => id)
  if (new Set(ids).size !== ids.length) throw new Error("profile guide scenario IDs must be unique")
  return scenarios
}

const loadScenarios = async () =>
  parseProfileGuideScenarios(
    JSON.parse(
      await readFile(path.join(root, "tests", "fixtures", "profile-guide-scenarios.json"), "utf8"),
    ),
  )

const runCommand = (executable, commandArgs, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, commandArgs, {
      cwd: root,
      env: options.env ?? process.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = []
    const stderr = []
    let outputBytes = 0
    let settled = false
    let leaderClosed = false
    let terminationError
    let forceKill
    let timeout

    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      clearTimeout(forceKill)
      if (error === undefined) resolve(result)
      else reject(error)
    }
    const signalProcessTree = (signal) => {
      if (child.pid === undefined) return
      try {
        if (process.platform === "win32") child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // The process already exited.
        }
      }
    }
    const processTreeIsRunning = () => {
      if (child.pid === undefined) return false
      if (process.platform === "win32") return !leaderClosed
      try {
        process.kill(-child.pid, 0)
        return true
      } catch (error) {
        return error?.code !== "ESRCH"
      }
    }
    const finishAfterProcessTreeExit = () => {
      if (!leaderClosed || processTreeIsRunning()) {
        setTimeout(finishAfterProcessTreeExit, 25)
        return
      }
      finish(terminationError)
    }
    const terminate = (error) => {
      if (terminationError !== undefined) return
      terminationError = error
      signalProcessTree("SIGTERM")
      forceKill = setTimeout(() => {
        signalProcessTree("SIGKILL")
        finishAfterProcessTreeExit()
      }, 2_000)
    }
    const collect = (chunks) => (chunk) => {
      if (terminationError !== undefined) return
      outputBytes += chunk.length
      if (outputBytes > maximumOutputBytes) {
        terminate(new Error(`${executable} output exceeded ${maximumOutputBytes} bytes`))
        return
      }
      chunks.push(chunk)
    }
    child.stdout.on("data", collect(stdout))
    child.stderr.on("data", collect(stderr))
    child.on("error", (error) => {
      if (terminationError === undefined) finish(error)
    })
    child.on("close", (code) => {
      leaderClosed = true
      if (terminationError !== undefined) {
        return
      }
      const errorText = Buffer.concat(stderr).toString("utf8").trim()
      if (code !== 0) {
        finish(new Error(`${executable} ${commandArgs.join(" ")} failed with exit ${code}: ${errorText}`))
        return
      }
      finish(undefined, Buffer.concat(stdout).toString("utf8"))
    })
    child.stdin.on("error", (error) => {
      if (terminationError === undefined) finish(error)
    })
    timeout = setTimeout(() => {
      terminate(new Error(`${executable} ${commandArgs.join(" ")} timed out after ${commandTimeoutMs}ms`))
    }, commandTimeoutMs)
    child.stdin.end(options.input)
  })

const runMiseTask = (task, taskArgs, env, input) =>
  runCommand("mise", ["run", task, "--", ...taskArgs], { env, input })

const nativeSourceDescriptions = async () => {
  const descriptions = new Map()
  const prototypes = path.join(root, "prototypes")
  for (const directory of await readdir(prototypes, { withFileTypes: true })) {
    if (!directory.isDirectory() || !/^trellage-.+-profiles$/u.test(directory.name)) continue
    const familyRoot = path.join(prototypes, directory.name)
    const launchers = (await readdir(path.join(familyRoot, "bin"), { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map(({ name }) => name)
    if (launchers.length !== 1) throw new Error(`${directory.name}/bin must contain one launcher`)
    const catalog = record(
      JSON.parse(await readFile(path.join(familyRoot, "catalog.json"), "utf8")),
      `${directory.name}/catalog.json`,
    )
    const profiles = record(catalog.profiles, `${directory.name}/catalog.json profiles`)
    for (const [profile, rawProfile] of Object.entries(profiles)) {
      const entry = record(rawProfile, `${launchers[0]}/${profile}`)
      descriptions.set(`native:${launchers[0]}/${profile}`, text(entry.description, `${profile}.description`))
    }
  }
  return descriptions
}

const compactWorkflow = (value, name) => {
  const workflow = record(value, name)
  const compact = {
    id: text(workflow.id, `${name}.id`),
    description: text(workflow.description, `${name}.description`),
    examples: stringArray(workflow.examples, `${name}.examples`),
  }
  return workflow.skill === undefined ? compact : { ...compact, skill: text(workflow.skill, `${name}.skill`) }
}

const catalogProfile = (value, surface) => {
  const entry = record(value, `${surface} profile`)
  const name = text(entry.name, `${surface} profile.name`)
  const guide = record(entry.guide, `${surface}:${name}.guide`)
  if (!Array.isArray(guide.workflows) || !Array.isArray(guide.prerequisites)) {
    throw new Error(`${surface}:${name}.guide must contain workflows and prerequisites`)
  }
  const workflows = new Map(
    guide.workflows.map((workflow, index) => {
      const compact = compactWorkflow(workflow, `${surface}:${name}.workflows[${index}]`)
      return [compact.id, compact]
    }),
  )
  const shared = {
    surface,
    name,
    description: text(entry.description, `${surface}:${name}.description`),
    sandbox: entry.sandbox,
    workflows,
    prerequisites: guide.prerequisites,
    headless: entry.headless,
    herdrCompatibility: entry.herdrCompatibility,
  }
  if (surface === "native") {
    const launcher = text(entry.launcher, `${surface}:${name}.launcher`)
    return [`native:${launcher}/${name}`, { ...shared, launcher }]
  }
  const harness = text(record(entry.harness, `${surface}:${name}.harness`).kind, `${surface}:${name}.harness.kind`)
  return [`sandbox:${name}`, { ...shared, harness }]
}

const profileCatalogIndex = (nativeList, sandboxList) => {
  const entries = [
    ...nativeList.profiles.map((profile) => catalogProfile(profile, "native")),
    ...sandboxList.profiles.map((profile) => catalogProfile(profile, "sandbox")),
  ]
  return new Map(entries)
}

const validateNativeCatalogSync = (nativeList, sourceDescriptions) => {
  const installedProfiles = new Set()
  for (const profile of nativeList.profiles) {
    const entry = record(profile, "native profile")
    const profileRef = `native:${text(entry.launcher, "native launcher")}/${text(entry.name, "native profile")}`
    installedProfiles.add(profileRef)
    const sourceDescription = sourceDescriptions.get(profileRef)
    if (sourceDescription === undefined) {
      throw new Error(
        `installed Native catalog has unexpected profile: ${profileRef}; run mise run rebuild-native-profiles before live evaluation`,
      )
    }
    if (entry.description !== sourceDescription) {
      throw new Error(
        `${profileRef} installed description differs from this worktree; run mise run rebuild-native-profiles before live evaluation`,
      )
    }
  }
  const missingProfiles = [...sourceDescriptions.keys()].filter((profileRef) => !installedProfiles.has(profileRef))
  if (missingProfiles.length > 0) {
    throw new Error(
      `installed Native catalog is missing worktree profiles: ${missingProfiles.join(", ")}; run mise run rebuild-native-profiles before live evaluation`,
    )
  }
}

const validateExpectedWorkflowProfiles = (scenarios, profiles) => {
  for (const scenario of scenarios) {
    for (const profileRef of Object.keys(scenario.expectedWorkflows ?? {})) {
      if (!profiles.has(profileRef)) {
        throw new Error(`${scenario.id}.expectedWorkflows references unknown profile ${profileRef}`)
      }
    }
  }
}

const validateResponseEnvelope = (response, scenario) => {
  exactKeys(response, `${scenario.id} response`, [
    "schemaVersion",
    "phase",
    "intent",
    "model",
    "effort",
    "recommendations",
  ])
  if (
    response.schemaVersion !== 1 ||
    response.phase !== "match" ||
    response.intent !== scenario.intent ||
    !Array.isArray(response.recommendations) ||
    response.recommendations.length < 3 ||
    response.recommendations.length > 5
  ) {
    throw new Error(`${scenario.id}: trx guide returned an unsupported match response`)
  }
  text(response.model, `${scenario.id}.model`)
  if (!["low", "medium", "high", "xhigh", "max"].includes(response.effort)) {
    throw new Error(`${scenario.id}.effort is unsupported`)
  }
}

const validateRecommendationConfidence = (recommendation, scenario, previousConfidence) => {
  const confidence = recommendation.confidence
  if (typeof confidence !== "number" || confidence < 0 || confidence > 1) {
    throw new Error(`${scenario.id}: recommendation confidence must be between 0 and 1`)
  }
  if (confidence > previousConfidence) throw new Error(`${scenario.id}: recommendations are not confidence ordered`)
  return confidence
}

const validateRecommendationEnrichment = (recommendation, profile, workflow, scenario, profileRef) => {
  if (
    recommendation.surface !== profile.surface ||
    recommendation.name !== profile.name ||
    recommendation.description !== profile.description ||
    recommendation.sandbox !== profile.sandbox ||
    recommendation.launcher !== profile.launcher ||
    recommendation.harness !== profile.harness ||
    !isDeepStrictEqual(recommendation.workflow, workflow) ||
    !isDeepStrictEqual(recommendation.prerequisites, profile.prerequisites) ||
    !isDeepStrictEqual(recommendation.headless, profile.headless) ||
    !isDeepStrictEqual(recommendation.herdrCompatibility, profile.herdrCompatibility)
  ) {
    throw new Error(`${scenario.id}: recommendation enrichment differs from the worktree catalog for ${profileRef}`)
  }
}

const validateRecommendation = (rawRecommendation, index, scenario, profiles, previousConfidence) => {
  const recommendation = record(rawRecommendation, `${scenario.id}.recommendations[${index}]`)
  exactKeys(
    recommendation,
    `${scenario.id}.recommendations[${index}]`,
    [
      "profileRef",
      "workflowId",
      "confidence",
      "reason",
      "tradeoff",
      "surface",
      "name",
      "description",
      "sandbox",
      "workflow",
      "prerequisites",
      "headless",
      "herdrCompatibility",
    ],
    ["launcher", "harness"],
  )
  const profileRef = text(recommendation.profileRef, `${scenario.id}.profileRef`)
  const workflowId = text(recommendation.workflowId, `${scenario.id}.workflowId`)
  const confidence = validateRecommendationConfidence(recommendation, scenario, previousConfidence)
  const profile = profiles.get(profileRef)
  if (profile === undefined) throw new Error(`${scenario.id}: recommendation references unknown profile ${profileRef}`)
  const workflow = profile.workflows.get(workflowId)
  if (workflow === undefined) {
    throw new Error(`${scenario.id}: recommendation references unknown workflow ${profileRef}/${workflowId}`)
  }
  text(recommendation.reason, `${scenario.id}.reason`)
  text(recommendation.tradeoff, `${scenario.id}.tradeoff`)
  validateRecommendationEnrichment(recommendation, profile, workflow, scenario, profileRef)
  return { profileRef, workflowId, confidence }
}

const validateRecommendations = (response, scenario, profiles) => {
  validateResponseEnvelope(response, scenario)
  const recommendations = []
  let previousConfidence = 1
  for (const [index, rawRecommendation] of response.recommendations.entries()) {
    const { profileRef, workflowId, confidence } = validateRecommendation(
      rawRecommendation,
      index,
      scenario,
      profiles,
      previousConfidence,
    )
    previousConfidence = confidence
    recommendations.push({ profileRef, workflowId })
  }
  const refs = recommendations.map(({ profileRef }) => profileRef)
  if (new Set(refs).size !== refs.length) throw new Error(`${scenario.id}: recommendations contain duplicate profiles`)
  return recommendations
}

const evaluate = async () => {
  const scenarios = await loadScenarios()
  await runCommand("npm", ["run", "build"])
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), "trellage-guide-evaluation-"))
  const env = { ...process.env, XDG_CACHE_HOME: cacheRoot }
  try {
    process.stdout.write(`profile guide live evaluation: worktree launcher, isolated cache ${cacheRoot}\n`)
    const [nativeSource, sourceDescriptions, sandboxSource] = await Promise.all([
      runMiseTask("trx", ["list", "--json"], env),
      nativeSourceDescriptions(),
      runMiseTask("trellage", ["list", "--json-full"], env),
    ])
    const nativeList = record(JSON.parse(nativeSource), "Native profile list")
    const sandboxList = record(JSON.parse(sandboxSource), "Sandbox profile list")
    if (!Array.isArray(nativeList.profiles) || !Array.isArray(sandboxList.profiles)) {
      throw new Error("worktree profile lists must contain profiles")
    }
    validateNativeCatalogSync(nativeList, sourceDescriptions)
    const profiles = profileCatalogIndex(nativeList, sandboxList)
    validateExpectedWorkflowProfiles(scenarios, profiles)

    let failures = 0
    for (const scenario of scenarios) {
      const source = await runMiseTask(
        "trx",
        ["guide", "--json"],
        env,
        JSON.stringify({ schemaVersion: 1, intent: scenario.intent }),
      )
      let response
      try {
        response = record(JSON.parse(source), `${scenario.id} response`)
      } catch {
        throw new Error(`${scenario.id}: trx guide returned malformed JSON`)
      }
      const recommendations = validateRecommendations(response, scenario, profiles)
      const refs = recommendations.map(({ profileRef }) => profileRef)
      const missing = scenario.expectedProfiles.filter((profileRef) => {
        const profileRank = refs.indexOf(profileRef) + 1
        return profileRank === 0 || profileRank > scenario.maxRank
      })
      const expectedRank = Math.min(...scenario.expectedProfiles.map((profileRef) => refs.indexOf(profileRef) + 1))
      const unexpected = scenario.excludedProfiles.filter((profileRef) => {
        const alternativeRank = refs.indexOf(profileRef) + 1
        return alternativeRank > 0 && alternativeRank <= expectedRank
      })
      const workflowMismatches = Object.entries(scenario.expectedWorkflows ?? {}).flatMap(
        ([profileRef, expectedWorkflowId]) => {
          const actualWorkflowId = recommendations.find(
            (recommendation) => recommendation.profileRef === profileRef,
          )?.workflowId
          return actualWorkflowId === expectedWorkflowId
            ? []
            : [
                `${profileRef}: expected=${expectedWorkflowId}, actual=${actualWorkflowId ?? "<not-recommended>"}`,
              ]
        },
      )
      if (missing.length > 0 || unexpected.length > 0 || workflowMismatches.length > 0) {
        failures += 1
        process.stdout.write(
          `FAIL ${scenario.id}: ranked=[${refs.join(", ")}] missing-top-${scenario.maxRank}=[${missing.join(", ")}] excluded=[${unexpected.join(", ")}] workflow-mismatches=[${workflowMismatches.join("; ")}]\n`,
        )
      } else {
        process.stdout.write(`PASS ${scenario.id}: ${refs.join(", ")}\n`)
      }
    }
    if (failures > 0) throw new Error(`profile guide live evaluation failed ${failures} scenario(s)`)
    process.stdout.write(`profile guide live evaluation: PASS (${scenarios.length} scenarios)\n`)
  } finally {
    await rm(cacheRoot, { recursive: true, force: true })
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const args = process.argv.slice(2)
  if (args.length !== 1 || args[0] !== "--live") {
    process.stderr.write("Usage: node scripts/evaluate-profile-guides.mjs --live\n")
    process.stderr.write("The --live flag is required because this command can consume paid model quota.\n")
    process.exit(2)
  }
  await evaluate()
}
