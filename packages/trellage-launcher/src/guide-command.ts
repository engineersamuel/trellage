import { fstatSync, readFileSync } from "node:fs"
import {
  parseGuideHeadlessArgv,
  parseGuideServiceRequestJson,
  resolveGuideModelConfig,
  runGuideGenerate,
  runGuideMatch,
  type GuideHeadlessArgs,
  type GuideServiceRequest,
} from "./guide-api.js"
import { parseGuideCatalog, type CombinedGuideCatalog } from "./guide-catalog.js"
import { CopilotGuideProvider } from "./copilot-guide-provider.js"
import { CachedGuideProvider, defaultGuideMatchCachePath } from "./guide-match-cache.js"
import { loadDefaultGuidePrompts } from "./guide-prompts.js"

const maximumCatalogBytes = 8 * 1024 * 1024

export interface ResolvedGuideRequest {
  readonly request: GuideServiceRequest
  readonly model: string
  readonly effort: ReturnType<typeof resolveGuideModelConfig>["effort"]
}

export const readGuideCatalog = (descriptor = 3): CombinedGuideCatalog => {
  const status = fstatSync(descriptor)
  if (status.size > maximumCatalogBytes) {
    throw new Error(`guide catalog exceeds ${maximumCatalogBytes} bytes`)
  }
  const source = readFileSync(descriptor, "utf8")
  if (Buffer.byteLength(source, "utf8") > maximumCatalogBytes) {
    throw new Error(`guide catalog exceeds ${maximumCatalogBytes} bytes`)
  }
  return parseGuideCatalog(source)
}

export const resolveGuideRequest = (
  args: GuideHeadlessArgs,
  stdinRequest: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedGuideRequest => {
  const fromStdin =
    args.intent === undefined
      ? parseGuideServiceRequestJson(stdinRequest ?? "")
      : { schemaVersion: 1 as const, intent: args.intent }
  const request: GuideServiceRequest = {
    schemaVersion: 1,
    intent: fromStdin.intent,
    ...((args.profile ?? fromStdin.profile) === undefined ? {} : { profile: args.profile ?? fromStdin.profile }),
    ...((args.model ?? fromStdin.model) === undefined ? {} : { model: args.model ?? fromStdin.model }),
    ...((args.effort ?? fromStdin.effort) === undefined ? {} : { effort: args.effort ?? fromStdin.effort }),
  }
  const config = resolveGuideModelConfig(
    {
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
    },
    env,
  )
  return {
    request,
    model: config.model,
    effort: config.effort,
  }
}

export const runGuideJsonCommand = async (options: {
  readonly argv: ReadonlyArray<string>
  readonly catalog: CombinedGuideCatalog
  readonly guideRoot: string
  readonly stdinRequest?: string
  readonly env: Readonly<Record<string, string | undefined>>
}): Promise<unknown> => {
  const args = parseGuideHeadlessArgv(options.argv)
  if (!args.json) throw new Error("guide JSON command requires --json")
  const resolved = resolveGuideRequest(args, options.stdinRequest, options.env)
  const prompts = await loadDefaultGuidePrompts()
  const provider = new CachedGuideProvider(
    new CopilotGuideProvider({
      model: resolved.model,
      effort: resolved.effort,
      prompts,
    }),
    {
      cachePath: defaultGuideMatchCachePath(options.env),
      model: resolved.model,
      effort: resolved.effort,
      matchPrompt: prompts.match,
    },
  )
  const common = {
    intent: resolved.request.intent,
    model: resolved.model,
    effort: resolved.effort,
  }
  return resolved.request.profile === undefined
    ? runGuideMatch(provider, options.catalog, common)
    : runGuideGenerate(provider, options.catalog, options.guideRoot, {
        ...common,
        profileRef: resolved.request.profile,
      })
}
