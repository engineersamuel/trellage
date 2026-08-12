import type { LaunchEntry } from "./state.js"

export interface LaunchCatalog {
  readonly prompt: string
  readonly description?: string
  readonly entries: ReadonlyArray<LaunchEntry>
}

const controls = /[\u0000-\u001f\u007f-\u009f]/u

const text = (value: unknown, name: string, maximum = 8000): string => {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
    throw new Error(`${name} must be a non-empty string of at most ${maximum} characters`)
  }
  if (controls.test(value)) throw new Error(`${name} must not contain control characters`)
  return value
}

const optionalText = (value: unknown, name: string): string | undefined =>
  value === undefined || value === null ? undefined : text(value, name)

const record = (value: unknown, name: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

const stringArray = (value: unknown, name: string): ReadonlyArray<string> => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  const result = value.map((item, index) => text(item, `${name} ${index}`, 256))
  if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`)
  return result
}
const argumentArray = (value: unknown, name: string): ReadonlyArray<string> => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value.map((item, index) => {
    if (typeof item !== "string" || item.length > 8000) {
      throw new Error(`${name} ${index} must be a string of at most 8000 characters`)
    }
    if (controls.test(item)) throw new Error(`${name} ${index} must not contain control characters`)
    return item
  })
}

const derivedIdentity = (label: string): { readonly harness: string; readonly profile: string } => {
  const parts = label.split(" / ")
  if (parts.length !== 2) return { harness: "unknown", profile: label }
  return { profile: parts[0]!, harness: parts[1]! }
}

export const parseLaunchCatalog = (source: string): LaunchCatalog => {
  let payload: unknown
  try {
    payload = JSON.parse(source)
  } catch {
    throw new Error("stdin must contain valid JSON")
  }

  const root = Array.isArray(payload) ? undefined : record(payload, "catalog")
  const choices = Array.isArray(payload) ? payload : root?.choices
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("catalog must contain at least one choice")
  }

  const ids = new Set<string>()
  const entries = choices.map((choice, index): LaunchEntry => {
    const item = record(choice, `choice ${index}`)
    const id = text(item.id, `choice ${index} id`, 256)
    if (ids.has(id)) throw new Error(`choice IDs must be unique: ${id}`)
    ids.add(id)
    const label = text(item.label, `choice ${index} label`, 1000)
    const derived = derivedIdentity(label)
    const harness = optionalText(item.harness, `choice ${index} harness`) ?? derived.harness
    const profile = optionalText(item.profile, `choice ${index} profile`) ?? derived.profile
    const harnessVersion = optionalText(item.harnessVersion, `choice ${index} harnessVersion`)
    const plugins = stringArray(item.plugins, `choice ${index} plugins`)
    const skills = stringArray(item.skills, `choice ${index} skills`)
    const mcps = stringArray(item.mcps, `choice ${index} mcps`)
    const commandAlias = optionalText(item.commandAlias, `choice ${index} commandAlias`)
    const commandPath = optionalText(item.commandPath, `choice ${index} commandPath`)
    const profileArgument = optionalText(item.profileArgument, `choice ${index} profileArgument`)
    const passthroughArgs = argumentArray(item.passthroughArgs, `choice ${index} passthroughArgs`)
    const defaultModel = optionalText(item.defaultModel, `choice ${index} defaultModel`)
    const models = stringArray(item.models, `choice ${index} models`)
    const modelOverrideSupported = item.modelOverrideSupported === true
    if (item.sandbox !== undefined && typeof item.sandbox !== "boolean") {
      throw new Error(`choice ${index} sandbox must be a boolean`)
    }
    const sandbox = item.sandbox as boolean | undefined
    if (modelOverrideSupported && models.length === 0) {
      throw new Error(`choice ${index} must advertise models when overrides are supported`)
    }
    if (defaultModel !== undefined && models.length > 0 && !models.includes(defaultModel)) {
      throw new Error(`choice ${index} default model must be advertised`)
    }
    return {
      id,
      label,
      harness,
      profile,
      description: optionalText(item.description, `choice ${index} description`) ?? "No description",
      ...(harnessVersion === undefined ? {} : { harnessVersion }),
      plugins,
      skills,
      mcps,
      ...(commandAlias === undefined ? {} : { commandAlias }),
      ...(commandPath === undefined ? {} : { commandPath }),
      ...(profileArgument === undefined ? {} : { profileArgument }),
      passthroughArgs,
      ...(item.details === undefined ? {} : { details: text(item.details, `choice ${index} details`) }),
      ...(defaultModel === undefined ? {} : { defaultModel }),
      models,
      modelOverrideSupported,
      ...(sandbox === undefined ? {} : { sandbox }),
    }
  })

  const description = root === undefined ? undefined : optionalText(root.description, "description")
  return {
    prompt:
      root === undefined
        ? "Select a Trellage profile"
        : (optionalText(root.prompt, "prompt") ?? "Select a Trellage profile"),
    ...(description === undefined ? {} : { description }),
    entries,
  }
}
