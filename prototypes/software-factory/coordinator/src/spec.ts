// What a worker runs with: the factory's start settings plus what its runtime reported it loaded.
import type { FeedEvent, WorkerSpec } from "./factory.ts"
import type { Thread } from "./threads.ts"

const last = (log: readonly FeedEvent[], type: string): any => log.findLast((e) => e.type === type && !e.agentId)?.data

export type SpecView = ReturnType<typeof specView>

export const specView = (
  worker: { id: string; name: string; role: string; auth: string; model: string; owner: string; home: string },
  spec: WorkerSpec | null,
  log: readonly FeedEvent[],
  thread: Thread | undefined,
  plugins: string[],
) => {
  const start = last(log, "session.start")?.context ?? {}
  const loaded: any[] = last(log, "session.skills_loaded")?.skills ?? []
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
    loadedSkills: loaded.map((s) => ({ name: s.name, source: s.source, enabled: !!s.enabled, requested: expected.has(bare(s.name)), path: s.path ?? null })),
    mcpServers: (last(log, "session.mcp_servers_loaded")?.servers ?? []).map((s: any) => ({ name: s.name, status: s.status, source: s.source ?? null })),
    plugins: [...new Set([...plugins, ...(last(log, "session.plugins_loaded")?.plugins ?? [])])],
    customTools: spec?.tools ?? [],
    skillDirectories: spec?.skillDirectories ?? [],
    extraPath: spec?.extraPath ?? [],
    systemPrompt: spec?.systemPrompt ?? null,
    sessionId: spec?.sessionId ?? null,
  }
}
