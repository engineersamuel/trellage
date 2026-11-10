// What a worker runs with: the factory's start settings plus what its runtime reported it loaded.
import { Option, Schema } from "effect"
import type { FeedEvent, WorkerSpec } from "./factory.ts"
import type { Thread } from "./threads.ts"

const OptionalString = Schema.optionalKey(Schema.String)
/** Payloads of the runtime events the spec reads. Fields the runtime may leave out are optional. */
const StartContext = Schema.Struct({
  cwd: OptionalString,
  repository: OptionalString,
  branch: OptionalString,
  headCommit: OptionalString,
})
const SessionStart = Schema.Struct({ context: Schema.optionalKey(StartContext) })
const LoadedSkill = Schema.Struct({
  name: Schema.String,
  source: OptionalString,
  enabled: Schema.optionalKey(Schema.Boolean),
  path: OptionalString,
})
const SkillsLoaded = Schema.Struct({ skills: Schema.Array(LoadedSkill) })
const McpServersLoaded = Schema.Struct({
  servers: Schema.Array(Schema.Struct({ name: Schema.String, status: OptionalString, source: OptionalString })),
})
const PluginsLoaded = Schema.Struct({ plugins: Schema.Array(Schema.String) })

/** The payload of the newest top-level `type` event, decoded; None when there is none or it has another shape. */
const last = <A>(log: readonly FeedEvent[], type: string, schema: Schema.Codec<A, unknown>): Option.Option<A> =>
  Option.flatMap(Option.fromNullishOr(log.findLast((e) => e.type === type && !e.agentId)), (e) =>
    Schema.decodeUnknownOption(schema)(e.data),
  )

export type SpecView = ReturnType<typeof specView>

export const specView = (
  worker: { id: string; name: string; role: string; auth: string; model: string; owner: string; home: string },
  spec: WorkerSpec | null,
  log: readonly FeedEvent[],
  thread: Thread | undefined,
  plugins: string[],
) => {
  const start: typeof StartContext.Type = Option.match(last(log, "session.start", SessionStart), {
    onNone: () => ({}),
    onSome: (s) => s.context ?? {},
  })
  const loaded = Option.match(last(log, "session.skills_loaded", SkillsLoaded), {
    onNone: () => [],
    onSome: (s) => s.skills,
  })
  const servers = Option.match(last(log, "session.mcp_servers_loaded", McpServersLoaded), {
    onNone: () => [],
    onSome: (s) => s.servers,
  })
  const loadedPlugins = Option.match(last(log, "session.plugins_loaded", PluginsLoaded), {
    onNone: () => [],
    onSome: (s) => s.plugins,
  })
  const expected = new Set(spec?.skills.map((s) => s.name))
  // Claude names plugin skills "plugin:skill"; match on the skill name.
  const bare = (n: string) => n.slice(n.lastIndexOf(":") + 1)
  return {
    id: worker.id,
    name: worker.name,
    role: worker.role,
    model: worker.model,
    auth: worker.auth,
    owner: worker.owner,
    home: worker.home,
    step: spec?.step ?? null,
    worktree: {
      path: thread?.worktree ?? spec?.workdir ?? start.cwd ?? null,
      repository: start.repository ?? null,
      branch: thread?.branch ?? start.branch ?? null,
      base: thread?.base ?? null,
      head: start.headCommit ?? null,
      folder: thread?.folderId ?? null,
      conversation: thread ? { id: thread.id, title: thread.title } : null,
    },
    /** Skills the step asked for, and whether the runtime loaded each one for the model. */
    skills: (spec?.skills ?? []).map((s) => {
      const l = loaded.find((x) => bare(x.name) === s.name)
      return { ...s, loaded: !!l?.enabled }
    }),
    /** Every skill the runtime loaded, including built-in ones. */
    loadedSkills: loaded.map((s) => ({
      name: s.name,
      source: s.source,
      enabled: !!s.enabled,
      requested: expected.has(bare(s.name)),
      path: s.path ?? null,
    })),
    mcpServers: servers.map((s) => ({ name: s.name, status: s.status, source: s.source ?? null })),
    plugins: [...new Set([...plugins, ...loadedPlugins])],
    customTools: spec?.tools ?? [],
    skillDirectories: spec?.skillDirectories ?? [],
    extraPath: spec?.extraPath ?? [],
    systemPrompt: spec?.systemPrompt ?? null,
    sessionId: spec?.sessionId ?? null,
  }
}
