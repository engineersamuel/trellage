import {
  parseGuideHeadlessArgv,
  parseGuideServiceRequestJson,
  resolveGuideModelRouting,
  runGuideGenerate,
  runGuideMatch,
  type GuideHeadlessArgs,
  type GuideResolvedModelRouting,
  type GuideServiceRequest,
} from "./guide-api.ts"
import type { CompositionCatalog } from "./composition-catalog.ts"
import { CopilotGuideProvider } from "./copilot-guide-provider.ts"
import { GuideArtifactCache } from "./guide-match-cache.ts"
import { loadDefaultGuidePrompts } from "./guide-prompts.ts"
import { jevShouldSkipPromptOptimization } from "./jev-guide-gates.ts"
import { JevGuideMatcher } from "./jev-guide-matcher.ts"


const guideOptimizeGate = (cwd: string, env: Readonly<Record<string, string | undefined>>, intent: string) => ({
  shouldSkipOptimize: (input: Parameters<typeof jevShouldSkipPromptOptimization>[0]) =>
    jevShouldSkipPromptOptimization(input, intent, { cwd, env }),
})

export interface ResolvedGuideRequest {
  readonly request: GuideServiceRequest
  readonly routing: GuideResolvedModelRouting
}

const runResolvedGuideJsonRequest = async (
  options: {
    readonly catalog: CompositionCatalog
    readonly guideRoot: string
    readonly cwd: string
    readonly env: Readonly<Record<string, string | undefined>>
    readonly resolveCatalog?: (signal?: AbortSignal) => Promise<CompositionCatalog>
  },
  resolved: ResolvedGuideRequest,
  provider: CopilotGuideProvider,
  cache: GuideArtifactCache,
  matcher: JevGuideMatcher,
): Promise<unknown> => {
  const request = resolved.request
  if (request.profile === undefined) {
    return runGuideMatch(
      provider,
      options.catalog,
      {
        intent: request.intent,
        ...resolved.routing.match,
        ...(request.goal === undefined ? {} : { goal: request.goal }),
      },
      cache,
      {
        matcher,
        ...(options.resolveCatalog === undefined ? {} : { resolveCatalog: options.resolveCatalog }),
      },
    )
  }
  const catalog = options.resolveCatalog === undefined ? options.catalog : await options.resolveCatalog()
  return runGuideGenerate(
    provider,
    catalog,
    options.guideRoot,
    {
      intent: request.intent,
      ...resolved.routing.generate,
      profileRef: request.profile,
      ...(request.goal === undefined ? {} : { goal: request.goal }),
      ...(request.workflowId === undefined ? {} : { workflowId: request.workflowId }),
      ...(request.originalIntent === undefined ? {} : { originalIntent: request.originalIntent }),
    },
    cache,
    guideOptimizeGate(options.cwd, options.env, request.intent),
  )
}


export const resolveGuideRequest = (
  args: GuideHeadlessArgs,
  stdinRequest: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): ResolvedGuideRequest => {
  const fromStdin: GuideServiceRequest =
    args.intent === undefined
      ? parseGuideServiceRequestJson(stdinRequest ?? "", args.profile)
      : { schemaVersion: 2 as const, intent: args.intent }
  const request: GuideServiceRequest = {
    ...fromStdin,
    ...(args.profile === undefined ? {} : { profile: args.profile }),
    ...(args.model === undefined ? {} : { model: args.model }),
    ...(args.effort === undefined ? {} : { effort: args.effort }),
  }
  const routing = resolveGuideModelRouting(
    {
      ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.effort === undefined ? {} : { effort: request.effort }),
    },
    env,
  )
  return {
    request,
    routing,
  }
}

export const runGuideJsonCommand = async (options: {
  readonly argv: ReadonlyArray<string>
  readonly catalog: CompositionCatalog
  readonly guideRoot: string
  readonly promptMasterSkillDirectory: string
  readonly stdinRequest?: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly cwd: string
  /** Production entrypoints inject the capability refresh. Tests and static fixtures leave it unset. */
  readonly resolveCatalog?: (signal?: AbortSignal) => Promise<CompositionCatalog>
}): Promise<unknown> => {
  const args = parseGuideHeadlessArgv(options.argv)
  if (!args.json) throw new Error("guide JSON command requires --json")
  const resolved = resolveGuideRequest(args, options.stdinRequest, options.env)
  const prompts = await loadDefaultGuidePrompts()
  const provider = new CopilotGuideProvider({
    routing: resolved.routing,
    prompts,
    promptMasterSkillDirectory: options.promptMasterSkillDirectory,
  })
  const cache = new GuideArtifactCache({
    cwd: options.cwd,
    routing: resolved.routing,
    prompts,
    promptMasterSkillDirectory: options.promptMasterSkillDirectory,
  })
  const matcher = new JevGuideMatcher({ cwd: options.cwd, env: options.env })
  return runResolvedGuideJsonRequest(options, resolved, provider, cache, matcher)
}
