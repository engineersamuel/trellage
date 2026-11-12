// Software factory coordinator: HTTP API, raw feed, and AG-UI over SSE.
import { KEEP_PER_WORKER } from "./events.ts"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import path from "node:path"
import { Translator } from "./agui.ts"
import { Factory, now, type FeedEvent, type Worker, type WorkerSummary } from "./factory.ts"
import {
  createWorktree,
  discardWorktree,
  fullyMerged,
  GENERAL,
  removeWorktree,
  worktreeRoot,
  type Worktree,
} from "./folders.ts"
import { cardsPrompt, coordinatorPrompt, deskPrompt, globalPrompt, researchPrompt, subPrompt } from "./prompts.ts"
import { loadPrompt } from "./prompt.ts"
import { configStore, type Scalar } from "./config.ts"
import { settleProposal } from "./configChanges.ts"
import { inRun, rerunInterruptedReview } from "./gates.ts"
import { interruptedScopes, resumePrompt, type Interrupted, type Resumed, type Shutdown } from "./resume.ts"
import { GoalBudgets, pauseApproval, PAUSE_REASON, readAnswer, shouldPause, type Budget } from "./budget.ts"
import {
  afterReport,
  childDoneCard,
  childGoalId,
  childGoalPrompt,
  defectCard,
  goalVerdict,
  GoalStates,
  LOOP_ANYWAY,
  goalLoopPrompt,
  loopSessionId,
  newGoalState,
  noProgressCard,
  OPEN_CHILD,
  RESUME,
  RUN_AGAIN,
  STOP_GOAL,
  type GoalState,
} from "./goalLoop.ts"
import { criteriaResults } from "./sdlc.ts"
import type { Verdict } from "../../shared/goal.ts"
import { DEFAULT_RUN_USD } from "../../shared/goal.ts"
import type { Approval } from "./approvals.ts"
import { lastEvaluation, verdictResults } from "./evaluate.ts"
import { instructionsPath, predict, readInstructions, shadowStats } from "./shadow.ts"
import { findingTask, findReport } from "./reports.ts"
import { CARD_TOOLS, cardOpenUi, reportFindings } from "./cards.ts"
import { cardView } from "../../shared/cardviews.ts"
import {
  conversationStatus,
  deletedNotice,
  DESK_ID,
  factorySnapshot,
  genId,
  reportTarget,
  statusNote,
} from "./general.ts"
import { specView } from "./spec.ts"
import { onTrack, steps } from "./steps.ts"
import { findIssues, supervisorPrompt, type Issue } from "./supervisor.ts"
import { answerPrompt } from "./approvals.ts"
import { loop, stopLoops } from "./loops.ts"
import { sendWhenIdle } from "./delivery.ts"
import { freshTurn, reportNudge, reportPrompt, shouldReport, type Report } from "./report.ts"
import { pendingReview } from "./security.ts"
import { branchPr, pastWorkers, runWorkers, type Run } from "./run.ts"
import { costReport, GOAL_PAGE_AGENT, gradeCost, rollUp, runCost, type AgentInfo } from "./costs.ts"
import { factoryConfig } from "./config.ts"
import { artifact, readLessons, unprovenCriteria } from "./sdlc.ts"
import { makeGrading } from "./grading.ts"
import { postMergeCheck } from "./postmerge.ts"
import { ARTIFACTS_DIR, servableImage } from "./files.ts"
import { checkoutCommit, GoalError, goalsDir, loopPrompt, makeGoals } from "./goals.ts"
import { defineTool, type SessionEvent, type Tool } from "@github/copilot-sdk"
import { messageThread, RunRecorder, subId, Threads, type DraftAction, type Thread } from "./threads.ts"
import { cardData, coordinatorTools, factoryConfigView, globalTools, spawnHealing, type Scope } from "./tools.ts"
import { DRAFT_NOTE, DraftError, draftNodeId, isUnstartedDraft, makeDrafts } from "./drafts.ts"
import { enhanceWith, stopEnhance } from "./enhance.ts"
import { makeGoalPage, startGoalRun } from "./goalPage.ts"
import { Option, Schema } from "effect"
import { worktreeDiff } from "./worktreeDiff.ts"

const asset = (name: string) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8")
const landing = asset("landing.html")
const openuiPrompt = asset("openui-prompt.txt")

const factory = (() => {
  try {
    return new Factory()
  } catch (e) {
    // Another coordinator owns the state folder (statedir.ts acquireStateLock).
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
})()
// Gate state, code and security reviews survive a restart: the newest published copy of each wins. A review that
// was mid-run when the process stopped lost its workers, so it is marked failed (the gate then blocks shipping).
const restore = <T extends object>(
  type: string,
  key: (v: T) => string,
  into: Map<string, T>,
  unfinished?: (v: T) => boolean,
) => {
  for (const v of factory.store.latest(type, 2000) as T[]) into.set(key(v), v)
  if (unfinished)
    for (const [k, v] of into)
      if (unfinished(v)) into.set(k, { ...v, status: "failed", error: "coordinator restarted" } as T)
}
restore("factory.sdlc", (sdlc) => sdlc.scopeId, factory.sdlc)
restore(
  "factory.code_review",
  (r) => r.id,
  factory.codeReviews,
  (r) => r.status !== "done" && r.status !== "failed",
)
restore(
  "factory.evaluation",
  (e) => e.id,
  factory.evaluations,
  (e) => e.status !== "done" && e.status !== "failed",
)
restore(
  "factory.security_review",
  (r) => r.id,
  factory.securityReviews,
  (r) => r.status !== "done" && r.status !== "failed",
)
for (const [k, s] of factory.sdlc) {
  const stopped = s.contractState?.status === "running"
  factory.sdlc.set(k, {
    ...s,
    gates: s.gates.map((g) =>
      g.status === "running" ? { ...g, status: "failed", detail: "coordinator restarted" } : g,
    ),
    // A contract the restart stopped does not count as a round; sdlc_plan runs it again.
    ...(stopped
      ? {
          contractRounds: Math.max(0, (s.contractRounds ?? 1) - 1),
          contractState: { ...s.contractState!, status: "failed" as const, error: "coordinator restarted" },
        }
      : {}),
  })
}
const threads = new Threads(factory.root)
const instructions = readInstructions()
const config = configStore()
console.error(`factory config: ${config.user}${config.error ? ` (invalid, using defaults: ${config.error})` : ""}`)
/** Tell every open UI the config changed (file edit, override, promote, applied proposal). */
const publishConfig = () => {
  factory.publish("coordinator", "factory.config_updated", null, now(), factoryConfigView())
  void factory.onConfigChanged()
}
config.watch((c) => {
  console.error(c.error ? `factory config: keeping the last good config; ${c.error}` : "factory config reloaded")
  publishConfig()
})
console.error(
  `global instructions: ${instructionsPath()} (${instructions ? `${instructions.length} chars` : "missing"})`,
)
/** Tools of a global-level coordinator: the desk, or one General chat (`chat` is its thread id). */
const globalScopeTools = (id: string, chat: string | null) => [
  ...coordinatorTools(factory, {
    id,
    threadId: chat,
    knownThread: (tid) => !!threads.get(tid) && !threads.get(tid)!.cleanedAt,
  }),
  ...globalTools({
    list: () =>
      threads.list().map((t) => ({
        ...t,
        folder: threads.folder(t.folderId)?.name,
        status: statusOf(t.id),
        pending: factory.approvals.pending().filter((a) => a.threadId === t.id).length,
        ...(isUnstartedDraft(t) ? { note: DRAFT_NOTE } : {}),
      })),
    folders: () => threads.folders(),
    start: (folder, task) => startConversation(folder, task, chat),
    message: async (tid, text) => logFailure(await deliverToThread(tid, `[from the global coordinator] ${text}`)),
    read: async (tid, wait) => {
      const w = factory.workers.get(subId(tid))
      if (w && wait) await w.waitIdle(300_000)
      const status = statusOf(tid)
      return {
        status,
        ...(statusNote(status) ? { note: statusNote(status) } : {}),
        lastMessage: w?.lastMessage ?? null,
      }
    },
    status: snapshot,
  }),
]

const statusOf = (threadId: string) =>
  conversationStatus(threads.get(threadId), factory.workers.get(subId(threadId)), threads.messages(threadId).length)

const lastText = (threadId: string): string | null =>
  factory.workers.get(subId(threadId))?.lastMessage ??
  [...threads.messages(threadId)]
    .reverse()
    .flatMap((m) => (m.role === "assistant" && m.content ? [m.content] : []))[0] ??
  null

const snapshot = () =>
  factorySnapshot(
    threads.list().filter((t) => !t.archivedAt || t.worktree),
    factory.summaries().map((a) => ({ id: a.id, name: a.name, status: a.status, owner: a.owner })),
    factory.approvals.pending(),
    lastText,
    subId,
  )

const globalSystem = (extra: string) =>
  `${coordinatorPrompt()}\n\n${cardsPrompt()}\n\n${globalPrompt()}${extra}${instructions ? `\n\n<human-instructions>\n${instructions}\n</human-instructions>` : ""}\n\n# OpenUI Lang\n${openuiPrompt}`

// The Factory desk keeps the id "coordinator" and its runtime process; General chats open their own sessions on it.
const coord = await factory.spawn({
  id: DESK_ID,
  name: "Factory desk",
  role: "coordinator",
  sessionId: "sf-coordinator",
  system: globalSystem(`\n\n${deskPrompt()}`),
  tools: globalScopeTools(DESK_ID, null),
  permissions: factory.globalPermissions,
})
const { model, reasoningEffort } = factory.settings.agent
if (reasoningEffort !== "default")
  await coord
    .setModel(model, reasoningEffort)
    .catch((e) => console.error(`reasoning effort ${reasoningEffort} not applied: ${e}`))

/** The desk's own conversation in the General folder: events it handles are saved there. */
const deskThread = (): Thread => {
  const t = threads.list().find((x) => x.desk && x.folderId === GENERAL.id)
  if (t) return t
  const n = threads.create("Factory desk", GENERAL.id)
  threads.setMeta(n.id, { desk: true })
  return threads.get(n.id)!
}

/** A General chat's own coordinator: a session with clean memory, on the desk's runtime. Started on first use. */
const startingChat = new Map<string, Promise<Worker>>()
const chatCoordinator = (t: Thread): Promise<Worker> => {
  if (t.desk) return Promise.resolve(coord)
  const id = genId(t.id)
  const live = factory.workers.get(id)
  if (live) return Promise.resolve(live)
  if (!startingChat.has(id)) {
    const p = factory
      .spawn({
        id,
        name: `General · ${t.title}`.slice(0, 60),
        role: "coordinator",
        owner: DESK_ID,
        threadId: t.id,
        shareRuntimeOf: DESK_ID,
        sessionId: `sf-${id}`,
        system: globalSystem(""),
        tools: globalScopeTools(id, t.id),
        permissions: factory.globalPermissions,
        model: factory.settings.agent.model,
      })
      .then(async (w) => {
        const { model: chatModel, reasoningEffort: chatEffort } = factory.settings.agent
        if (chatEffort !== "default") await w.setModel(chatModel, chatEffort).catch(() => {})
        return w
      })
      .finally(() => startingChat.delete(id))
    startingChat.set(id, p)
  }
  return startingChat.get(id)!
}

const desk = coord.summary()
console.error(`coordinator runtime pid=${desk.pid} auth=${desk.auth} model=${desk.model}`)

// ---------- helpers ----------

const json = (v: unknown, status = 200) => Response.json(v, { status })
const bad = (e: unknown) => new Response(e instanceof Error ? e.message : String(e), { status: 400 })
const empty = (status: number) => new Response(null, { status })

/** SSE response. `start` pushes JSON values and returns a cleanup function. */
const sse = (start: (send: (v: unknown) => boolean, close: () => void) => () => void): Response => {
  let cleanup = () => {}
  let open = true
  let ping: ReturnType<typeof setInterval> | undefined
  // Runs once, whether the server ends the stream or the browser disconnects.
  const stop = () => {
    if (!open) return false
    open = false
    clearInterval(ping)
    cleanup()
    return true
  }
  const enc = new TextEncoder()
  const stream = new ReadableStream({
    start(ctrl) {
      const close = () => {
        if (stop()) ctrl.close()
      }
      const write = (text: string) => {
        if (!open) return false
        try {
          ctrl.enqueue(enc.encode(text))
          return true
        } catch {
          stop()
          return false
        }
      }
      // Events with a seq carry it as the SSE id, so a client can resume after a gap.
      const send = (v: unknown) => {
        const seq = (v as { seq?: unknown })?.seq
        return write(`${typeof seq === "number" && seq > 0 ? `id: ${seq}\n` : ""}data: ${JSON.stringify(v)}\n\n`)
      }
      ping = setInterval(() => write(": ping\n\n"), 15_000)
      cleanup = start(send, close)
    },
    cancel() {
      stop()
    },
  })
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  })
}

type Fields = { readonly [key: string]: unknown }
const decodeFields = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))
/** The fields of an untrusted JSON value; a value that is not an object (null, array, number, string) has none. */
const fieldsOf = (v: unknown): Fields => Option.getOrElse(decodeFields(v), () => ({}))
/** The fields of a request body. A null body is an error, as reading a field of null was before. */
const bodyFields = (v: unknown): Fields => {
  if (v === null) throw new TypeError("request body is null")
  return fieldsOf(v)
}
/** An untrusted JSON value as a list; a value that is not an array is an empty list. */
const listOf = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : [])

/** The text of the run's new user message: the last message, when it is a user message. A resume or a tool-result run has none. */
const newUserText = (input: Fields): string | null => {
  const msg = fieldsOf(listOf(input.messages).at(-1))
  if (msg.role !== "user") return null
  if (typeof msg.content === "string") return msg.content
  if (Array.isArray(msg.content))
    return listOf(msg.content)
      .map((p) => fieldsOf(p).text)
      .filter((t) => typeof t === "string")
      .join("\n")
  return null
}

/** AG-UI run input `context` as a block the coordinator reads with the prompt. */
const uiContext = (context: unknown): string => {
  const items = listOf(context).flatMap((c) => {
    const { description, value } = fieldsOf(c)
    return typeof description === "string" && value !== undefined ? [{ description, value }] : []
  })
  if (!items.length) return ""
  const line = (c: { description: string; value: unknown }) =>
    `- ${c.description}: ${typeof c.value === "string" ? c.value : JSON.stringify(c.value)}`
  return `\n\n<ui-context>\n${items.map(line).join("\n")}\n</ui-context>`
}

// Both UIs share one coordinator session, so every turn says which format the
// current UI renders. Without this the agent copies the format of earlier turns.
const uiFormat = (p: string, answer: string | null) =>
  `${p}\n\n${loadPrompt(answer === "openui" ? "ui-format-openui" : "ui-format-markdown")}`

// ---------- conversations ----------

/** Folder a browser picked for new conversations (cookie sf_folder), so both UIs need no API change. */
const cookieFolder = (req: Request): string =>
  req.headers.get("cookie")?.match(/(?:^|;\s*)sf_folder=([\w-]+)/)?.[1] ?? GENERAL.id

/** Worktree maker for a new conversation in a repo folder; none for the General folder. `base` overrides origin's default branch. */
const worktreeFor = (folderId: string, base?: string) => {
  const f = threads.folder(folderId)
  if (!f?.path) return undefined
  return (id: string) =>
    createWorktree(f.path, path.join(worktreeRoot(), f.id, id.slice(0, 8)), `factory/${f.id}-${id.slice(0, 8)}`, base)
}

const createThread = (text: string | null, folderId: string, base?: string) => {
  const t = threads.create(text, folderId, worktreeFor(folderId, base))
  factory.publish("coordinator", "factory.thread_updated", null, now(), { threadId: t.id })
  return t
}

/** The tool scope of a repo conversation's sub-coordinator. */
const subScope = (t: Thread): Scope => {
  const folder = threads.folder(t.folderId)!
  return {
    id: subId(t.id),
    threadId: t.id,
    workdir: t.worktree!,
    ...(t.base ? { base: t.base } : {}),
    label: folder.name,
    folderId: folder.id,
    report: (r) =>
      reportToGeneral(folder.name, threads.get(t.id) ?? t, r).finally(
        () =>
          void gradeThread(t.id, r).finally(
            () => void goalReported(t.id, r).catch((e) => console.error(`goal loop: ${e}`)),
          ),
      ),
  }
}

/** The coordinator for a conversation: the global one, or the conversation's sub-coordinator in its worktree (started on first use). */
const starting = new Map<string, Promise<Worker>>()
const coordinatorFor = (t: Thread | undefined): Promise<Worker> => {
  if (!t) return Promise.resolve(coord)
  if (!t.worktree) return chatCoordinator(t)
  if (isUnstartedDraft(t))
    return Promise.reject(new Error(`conversation ${t.id} is an unstarted draft; only Run on its draft node starts it`))
  const id = subId(t.id)
  const live = factory.workers.get(id)
  if (live) return Promise.resolve(live)
  if (!starting.has(id)) {
    const folder = threads.folder(t.folderId)!
    const p = factory
      .spawn({
        id,
        name: `${folder.name} · ${t.title}`.slice(0, 60),
        role: "coordinator",
        ...(t.parentThreadId ? { owner: genId(t.parentThreadId) } : {}),
        system: `${coordinatorPrompt()}\n\n${cardsPrompt()}\n\n${subPrompt(folder.name, folder.path, t.worktree, t.branch!, t.prBase, readLessons(factory.root, folder.id))}\n\n${researchPrompt()}\n\n# OpenUI Lang\n${openuiPrompt}`,
        tools: coordinatorTools(factory, subScope(t)),
        permissions: factory.subPermissions,
        workdir: t.worktree,
        model: factory.settings.subAgent.model,
        // A goal's loop n > 1 is a fresh session (a fresh context) of the same sub-coordinator (ADR 0007).
        sessionId: loopSessionId(id, (t.goalId && goalStates.get(t.goalId)?.loop) || 1),
      })
      .then(async (w) => {
        // Resumed sessions keep their old model: always apply the sub-coordinator model and effort.
        const { model: subModel, reasoningEffort: subEffort } = factory.settings.subAgent
        await w
          .setModel(subModel, subEffort)
          .catch((e) => console.error(`sub-coordinator model ${subModel}/${subEffort} not applied: ${e}`))
        w.events.subscribe((ev) => watchSub(w, t.id, ev))
        return w
      })
      .finally(() => starting.delete(id))
    starting.set(id, p)
  }
  return starting.get(id)!
}

/** A delivery whose coordinator is ready; `sent` settles once the prompt was handed to it, rejecting if it was not. */
type Delivery = { sent: Promise<void> }

/** Marked handled so a caller that settles it later does not trip an unhandled rejection; awaiting `sent` still rejects. */
const delivery = (sent: Promise<void>): Delivery => {
  sent.catch(() => {})
  return { sent }
}

/** Log a delivery that fails instead of waiting for it. */
const logFailure = (d: Delivery) => void d.sent.catch((e) => console.error(e instanceof Error ? e.message : String(e)))

/** Save a delivered prompt and the coordinator's answering run in the conversation, so every UI shows it. */
const recordTurn = (t: Thread, c: Worker, text: string) => {
  threads.append(t.id, { id: crypto.randomUUID(), role: "user", content: text })
  if (c === coord) factory.currentThread = t.id
  const tr = new Translator(t.id, crypto.randomUUID())
  const rec = new RunRecorder()
  const off = c.events.subscribe((ev) => {
    for (const e of tr.translate(ev)) rec.add(e)
    if (tr.done) {
      off()
      threads.append(t.id, ...rec.messages())
      factory.publish("coordinator", "factory.thread_updated", null, now(), { threadId: t.id })
    }
  })
  factory.publish("coordinator", "factory.thread_updated", null, now(), { threadId: t.id })
}

/**
 * Send a prompt into a conversation from outside a browser run (approval answers, the global
 * coordinator). Saved like any turn, so every UI shows it. Waits while that coordinator is busy.
 */
const deliverToThread = async (threadId: string | null, text: string): Promise<Delivery> => {
  const t = threadId ? threads.get(threadId) : undefined
  if (t?.cleanedAt)
    return delivery(Promise.reject(new Error(`not delivered: conversation ${t.id} is merged and cleaned up`)))
  if (t?.goalId && goalBlocked(t.goalId))
    return delivery(
      Promise.reject(new Error(`not delivered: goal ${t.goalId} is ${budgetOf(t.goalId).status} at its cost limit`)),
    )
  const c = await coordinatorFor(t)
  const sent = sendWhenIdle(c, factory.coordinatorPrompt(text), () => t && recordTurn(t, c, text)).catch((e) => {
    throw new Error(`delivery to ${c.id} failed: ${e instanceof Error ? e.message : e}`)
  })
  return delivery(sent)
}

/** A sub-coordinator's report goes to the General chat that started its conversation, else to the Factory desk. */
const reportToGeneral = async (folder: string, t: Thread, r: Report): Promise<void> => {
  const target = reportTarget(t, threads.list(), deskThread().id)
  // Queued, not awaited: the target may be busy waiting for this sub (read_conversation wait=true), and the sub's
  // report_up would wait for it in turn. A failed delivery is logged.
  logFailure(await deliverToThread(target, reportPrompt(folder, t.title, t.id, r)))
}

/** Deliver without waiting; failures are logged. */
const deliverAndLog = (threadId: string | null, text: string) =>
  void deliverToThread(threadId, text).then(logFailure, (e) =>
    console.error(`not delivered: ${e instanceof Error ? e.message : e}`),
  )

/** Track a sub-coordinator's turn; when it goes idle done or blocked without reporting, nudge it once to report_up. */
const watchSub = (w: Worker, threadId: string, ev: SessionEvent) => {
  const content = String(fieldsOf(ev.data).content ?? "")
  if (ev.type === "user.message" && !content.startsWith(reportNudge())) factory.turns.set(w.id, freshTurn(Date.now()))
  if (ev.type === "session.error") factory.turn(w.id).blocked = true
  if (ev.type !== "session.idle") return
  const turn = factory.turn(w.id)
  const owned = [...factory.workers.values()].filter((x) => x.owner === w.id)
  const reviews = [...factory.securityReviews.values()]
  const state = {
    turn,
    runningWorkers: owned.filter((x) => x.status === "running").length,
    pendingReview: pendingReview(reviews, w.id) !== undefined,
    pendingDecision: factory.approvals.pending().some((a) => a.threadId === threadId),
    failed:
      owned.some((x) => x.status === "error" && x.lastActivity >= turn.start) ||
      reviews.some((r) => r.scopeId === w.id && r.status === "failed" && r.at >= turn.start),
  }
  if (!inRun(factory, factory.sdlc.get(w.id), () => shouldReport(state))) return
  turn.nudged = true
  deliverAndLog(threadId, reportNudge())
}

/** Open a conversation in a folder (id, or a repo path to add) with `meta` set before its first prompt, and send the task. */
const openConversation = async (
  folder: string,
  task: string,
  meta: Pick<Thread, "parentThreadId" | "improvementOf"> = {},
) => {
  const f = threads.folder(folder) ?? threads.addFolder(folder)
  const t = createThread(task, f.id)
  threads.setMeta(t.id, meta)
  const sent = await deliverToThread(t.id, `[from the global coordinator] ${task}`)
  return { info: { threadId: t.id, folder: f.name, worktree: t.worktree ?? null, branch: t.branch ?? null }, sent }
}

/** Global coordinator tool: open a conversation and give its sub-coordinator a task. */
const startConversation = async (folder: string, task: string, parentThreadId: string | null = null) => {
  const { info, sent } = await openConversation(folder, task, parentThreadId ? { parentThreadId } : {})
  logFailure(sent)
  return info
}

/**
 * Cleanup: every 10 min, remove the worktree and local branch of each repo conversation whose work is
 * fully merged upstream, and stop its sub-coordinator. The conversation and its memory stay.
 */
const conversationBusy = (threadId: string): boolean =>
  [...factory.workers.values()].some(
    (w) => (w.id === subId(threadId) || w.owner === subId(threadId)) && w.status === "running",
  )

const stopConversationWorkers = async (threadId: string): Promise<void> => {
  for (const w of [...factory.workers.values()])
    if (w.owner === subId(threadId) || w.owner === draftNodeId(threadId)) await factory.stop(w.id)
  if (factory.workers.has(subId(threadId))) await factory.stop(subId(threadId))
}

/** Delete a conversation: stop its workers, discard its worktree, and tell the chat that started it. */
const deleteThread = async (id: string): Promise<void> => {
  const t = threads.get(id)
  const repo = t && threads.folder(t.folderId)?.path
  if (t?.worktree && !t.cleanedAt && repo) {
    await stopConversationWorkers(t.id)
    discardWorktree(repo, t as Worktree)
  }
  threads.delete(id)
  factory.publish("coordinator", "factory.thread_updated", null, now(), { threadId: id })
  if (t?.worktree) {
    // The chat that started it forgets it; a repeat of the same request starts a new run.
    const parent = t.parentThreadId && threads.get(t.parentThreadId)
    if (parent) deliverAndLog(parent.id, deletedNotice(t))
  } else if (t && factory.workers.has(genId(t.id))) await factory.stop(genId(t.id))
}

const publishWorktreeCleanup = (t: Thread): void => {
  factory.publish("coordinator", "factory.worktree_cleaned", null, now(), {
    threadId: t.id,
    branch: t.branch,
    worktree: t.worktree,
  })
  factory.publish("coordinator", "factory.thread_updated", null, now(), { threadId: t.id })
}

const cleanMergedThread = async (t: Thread): Promise<void> => {
  if (!t.worktree || t.cleanedAt || conversationBusy(t.id)) return
  const repo = threads.folder(t.folderId)?.path
  if (!repo || !fullyMerged(repo, t as Worktree)) return
  const sdlc = factory.sdlc.get(subId(t.id))
  if (sdlc?.gates.some((g) => g.id === "postMerge" && g.chosen))
    void postMergeCheck(repo, t.branch!).then((r) => {
      factory.publish(subId(t.id), "factory.post_merge", null, now(), { threadId: t.id, ...r })
      if (!r.ok) deliverAndLog(reportTarget(t, threads.list(), deskThread().id), `[post-merge ${t.title}] ${r.detail}`)
    })
  try {
    await stopConversationWorkers(t.id)
    removeWorktree(repo, t as Worktree)
    threads.update(t.id, { cleanedAt: Date.now() })
    publishWorktreeCleanup(t)
  } catch (e) {
    console.error(`cleanup of ${t.worktree} failed: ${e}`)
  }
}

const cleanMerged = async () => {
  for (const t of threads.list()) await cleanMergedThread(t)
}
loop("clean-merged", "10 minutes", cleanMerged, "30 seconds")

const ensureAguiThread = (threadId: string, prompt: string | null, req: Request): Response | null => {
  if (prompt === null || threads.get(threadId)) return null
  const requestedFolder = cookieFolder(req)
  const folderId = threads.folder(requestedFolder) ? requestedFolder : GENERAL.id
  try {
    threads.ensure(threadId, prompt, folderId, worktreeFor(folderId))
    return null
  } catch (e) {
    return bad(e)
  }
}

const findAguiWorker = async (id: string | null, threadId: string): Promise<Worker | Response> => {
  let worker: Worker | undefined
  try {
    worker = id ? factory.workers.get(id) : await coordinatorFor(threads.get(threadId))
  } catch (e) {
    return bad(e)
  }
  return worker ?? bad(`unknown worker ${id}`)
}

const recordAguiPrompt = (worker: Worker, threadId: string, prompt: string): void => {
  if (worker === coord) factory.currentThread = threadId
  threads.append(threadId, { id: crypto.randomUUID(), role: "user", content: prompt })
  factory.publish("coordinator", "factory.thread_updated", null, now(), { threadId })
}

/** A run that is still recording, by thread, so a stop request reaches it after the browser closed its stream. */
const activeRuns = new Map<string, { worker: Worker; tr: Translator; finish: () => void }>()

/** Client tool calls (AG-UI frontend tools) waiting for the browser's result, by tool call id. */
const clientCalls = new Map<string, (content: string) => void>()

/** How long a client tool call waits for the browser before the coordinator gets an error result. */
const CLIENT_TOOL_TIMEOUT_MS = 120_000

/** An AG-UI client tool as a session tool: the handler waits until the next run carries the browser's result. */
const clientTool = (t: { name: string; description?: unknown; parameters?: unknown }): Tool<Record<string, unknown>> =>
  defineTool<Record<string, unknown>>(t.name, {
    description: String(t.description ?? ""),
    parameters: (t.parameters ?? { type: "object", properties: {} }) as Record<string, unknown>,
    handler: (_args: unknown, inv: { toolCallId: string }) =>
      new Promise<string>((resolve) => {
        const timer = setTimeout(
          () => (clientCalls.delete(inv.toolCallId), resolve("The UI did not run this tool in time.")),
          CLIENT_TOOL_TIMEOUT_MS,
        )
        clientCalls.set(
          inv.toolCallId,
          (content) => (clearTimeout(timer), clientCalls.delete(inv.toolCallId), resolve(content)),
        )
      }),
  })

/**
 * Give the session the run's client tools (AG-UI `tools`) next to its own. Only Copilot sessions can change
 * tools; a run without client tools (Foldkit) puts the session back to its own. Returns the client tool names.
 */
const syncClientTools = async (w: Worker, tools: unknown): Promise<Set<string>> => {
  if (!w.session.setTools) return new Set()
  const own = new Set(w.tools.map((t) => t.name))
  const list = listOf(tools).flatMap((t) => {
    const { name, description, parameters } = fieldsOf(t)
    return typeof name === "string" && !own.has(name) ? [{ name, description, parameters }] : []
  })
  const key = list
    .map((t) => t.name)
    .sort()
    .join(",")
  if (key !== w.clientToolKey) {
    try {
      await w.session.setTools([...w.tools, ...list.map(clientTool)])
      w.clientToolKey = key
    } catch (e) {
      console.error(`client tools not set on ${w.id}: ${e instanceof Error ? e.message : e}`)
      return new Set()
    }
  }
  return new Set(list.map((t) => t.name))
}

/**
 * Answer the decisions a resuming run answers (AG-UI `resume`).
 * A resolved entry answers the decision; a cancelled one leaves it open in the decision center.
 * Returns the answer prompts for the coordinator.
 */
const resumeAnswers = (resume: unknown): string[] =>
  listOf(resume).flatMap((entry) => {
    const r = fieldsOf(entry)
    const payload = fieldsOf(r.payload)
    if (r.status !== "resolved" || typeof payload.answer !== "string") return []
    try {
      const note = typeof payload.note === "string" && payload.note.trim() ? payload.note.trim() : null
      const a = factory.approvals.answer(String(r.interruptId), payload.answer, note)
      factory.publish("coordinator", "factory.approval_answered", null, now(), a)
      return improvementAnswered(a) || budgetAnswered(a) || goalAnswered(a) ? [] : [answerPrompt(a)]
    } catch (e) {
      // Answered elsewhere first, or an unknown id: the coordinator already got that answer.
      console.error(`resume ${String(r.interruptId)}: ${e instanceof Error ? e.message : e}`)
      return []
    }
  })

/** The card of a worker this run started: an AG-UI activity message, updated as the worker changes. */
const workerCard = (ev: FeedEvent): Record<string, unknown> => {
  if (ev.type === "factory.worker_stopped") return { id: ev.workerId, status: "stopped" }
  const w = ev.data as Record<string, unknown>
  const pick = ["id", "name", "status", "harness", "model", "task", "lastMessage"] as const
  return Object.fromEntries(
    pick.flatMap((k) =>
      w[k] === undefined || w[k] === null
        ? []
        : [[k, k === "lastMessage" || k === "task" ? String(w[k]).slice(0, 300) : w[k]]],
    ),
  )
}

type RunOptions = {
  /** Starts the run's work after the stream subscribed; null: nothing to do, the run finishes at once. */
  start: (() => Promise<unknown>) | null
  interrupts: boolean
  clientTools: Set<string>
  /** Client tool calls whose results this run delivers; their completion is not sent again. */
  delivered: string[]
  /** The UI draws OpenUI Lang only: card tools also send their card as an OpenUI program. */
  openUi?: boolean
}

/**
 * Stream one AG-UI run from the worker's session events until it is idle. The run is saved when it ends,
 * also when the browser left early (a reload, a closed tab): only a stop request (/api/agui/stop) aborts it.
 */
const streamAguiRun = (worker: Worker, threadId: string, runId: string, o: RunOptions): Response => {
  const tr = new Translator(threadId, runId, {
    interrupts: o.interrupts,
    pending: (id) => factory.approvals.get(id)?.status === "pending",
    clientTool: (name) => o.clientTools.has(name),
    ...(o.openUi
      ? {
          card: (name: string, result: string, args: Record<string, unknown>, prefix: string) =>
            cardOpenUi(name, result, worker.id, args, prefix),
        }
      : {}),
  })
  for (const id of o.delivered) tr.clientCalls.add(id)
  const rec = new RunRecorder()
  return sse((send, close) => {
    for (const e of tr.started()) send(e)
    if (o.start === null) {
      send(tr.finished())
      close()
      return () => {}
    }
    const mine = new Set<string>()
    let offEvents = () => {}
    let offFeed = () => {}
    const handle = (events: unknown[]) => {
      for (const e of events) {
        rec.add(e)
        send(e)
      }
      if (!tr.done) return
      offEvents()
      offFeed()
      if (activeRuns.get(threadId)?.tr === tr) activeRuns.delete(threadId)
      threads.append(threadId, ...rec.messages())
      factory.publish("coordinator", "factory.thread_updated", null, now(), { threadId })
      queueMicrotask(close)
    }
    offEvents = worker.events.subscribe((ev) => handle(tr.translate(ev)))
    offFeed = factory.feed.subscribe((ev) => {
      if (
        ev.type === "factory.worker_started" &&
        Option.exists(decodeOwner(ev.data), ({ owner }) => owner === worker.id)
      )
        mine.add(ev.workerId)
      if (!mine.has(ev.workerId) || !/^factory\.worker_(started|updated|stopped)$/.test(ev.type)) return
      handle(tr.activity(`worker-${ev.workerId}`, "worker", workerCard(ev)))
    })
    const finish = () => {
      if (tr.done) return
      const out: unknown[] = []
      tr.finish(out, { type: "cancelled" })
      handle(out)
    }
    activeRuns.set(threadId, { worker, tr, finish })
    o.start().catch((e) => {
      handle([{ type: "RUN_ERROR", message: String(e?.message ?? e) }])
      tr.done = true
      handle([])
    })
    // The browser left: keep recording so the run is saved; send() is a no-op from now on.
    return () => {}
  })
}

/** AG-UI stop: abort the thread's running coordinator. Its run ends with the cancelled outcome and is saved. */
const aguiStop = async (req: Request): Promise<Response> => {
  const { threadId } = ((await req.json().catch(() => ({}))) ?? {}) as { threadId?: string }
  const run = threadId ? activeRuns.get(threadId) : undefined
  if (!run) return json({ stopped: false })
  run.tr.cancelled = true
  await run.worker.session.abort().catch((e) => console.error(`abort ${run.worker.id}: ${e}`))
  // A session that sends no idle after the abort still ends the run.
  setTimeout(run.finish, 10_000)
  return json({ stopped: true })
}

/** AG-UI capabilities of the coordinator agent (AgentCapabilities, AG-UI 1.0). */
const CAPABILITIES = {
  identity: { name: "Software factory coordinator", type: "copilot-sdk", provider: "github" },
  transport: { streaming: true, resumable: false },
  tools: { supported: true, clientProvided: true, parallelCalls: true },
  state: { snapshots: false, deltas: false, persistentState: true, memory: true },
  multiAgent: { supported: true, delegation: true },
  reasoning: { supported: true, streaming: true },
  humanInTheLoop: { supported: true, approvals: true, interrupts: true },
  custom: { activityTypes: ["subagent", "worker"], tokenUsage: true },
}

/**
 * AG-UI run on a conversation's coordinator (or a worker). A run brings one of: a new user message, `resume`
 * answers to the decisions the last run ended with, or results of client tools the last run ended at.
 */
const aguiRun = async (id: string | null, url: URL, req: Request): Promise<Response> => {
  const input = fieldsOf(await req.json().catch(() => ({})))
  const threadId = typeof input.threadId === "string" ? input.threadId : "default"
  const prompt = newUserText(input)
  const ensureError = ensureAguiThread(threadId, prompt, req)
  if (ensureError) return ensureError
  if (!id && threads.get(threadId)?.cleanedAt)
    return bad(
      "This conversation's branch is merged and its worktree was removed. Start a new conversation in the folder.",
    )
  const worker = await findAguiWorker(id, threadId)
  if (worker instanceof Response) return worker
  const runId = typeof input.runId === "string" ? input.runId : crypto.randomUUID()
  const props = fieldsOf(input.forwardedProps)
  const format = typeof props.answer === "string" ? props.answer : url.searchParams.get("answer")
  const clientTools = await syncClientTools(worker, input.tools)
  const results = listOf(input.messages).flatMap((entry) => {
    const { role, id: messageId, toolCallId, content } = fieldsOf(entry)
    return role === "tool" && typeof toolCallId === "string" && clientCalls.has(toolCallId)
      ? [{ id: messageId, toolCallId, content }]
      : []
  })
  const answers = resumeAnswers(input.resume)
  const text = [...answers, ...(prompt === null ? [] : [prompt])].join("\n\n")
  const start = (): (() => Promise<unknown>) | null => {
    if (results.length) {
      // The browser ran the client tools: save their results and let the waiting session continue.
      threads.append(
        threadId,
        ...results.map((m) => ({
          id: String(m.id ?? crypto.randomUUID()),
          role: "tool" as const,
          toolCallId: m.toolCallId,
          content: String(m.content ?? ""),
        })),
      )
      return async () =>
        results.forEach((m) =>
          clientCalls.get(m.toolCallId)?.(typeof m.content === "string" ? m.content : JSON.stringify(m.content)),
        )
    }
    if (!text) return null
    recordAguiPrompt(worker, threadId, text)
    const full = (worker.role === "coordinator" ? factory.coordinatorPrompt(text) : text) + uiContext(input.context)
    return () => worker.send(uiFormat(full, format))
  }
  return streamAguiRun(worker, threadId, runId, {
    start: start(),
    interrupts: props.interrupts === true,
    clientTools,
    delivered: results.map((m) => m.toolCallId),
    openUi: format === "openui",
  })
}

/** Most events a reconnecting feed client gets replayed; past this it reloads instead. */
const REPLAY_LIMIT = 5000

/**
 * Raw factory feed: every worker's SDK events plus factory.* lifecycle events.
 * With ?since=SEQ (or a Last-Event-ID header) it first replays the stored events after SEQ, then a
 * factory.feed_replay marker ({ complete }) and the current worker summaries, then goes live.
 */
const feed = (req: Request, url: URL): Response => {
  const worker = url.searchParams.get("worker")
  // The browser's own reconnect sends Last-Event-ID; it is newer than a since in the URL.
  const since = Number(req.headers.get("last-event-id") ?? url.searchParams.get("since") ?? NaN)
  const wanted = (ev: FeedEvent) =>
    !ev.type.startsWith("model.") && (worker === null || ev.workerId === worker || ev.type.startsWith("factory."))
  return sse((send) => {
    // Visible heartbeat (SSE comments are invisible to EventSource), so a browser can tell a dead feed.
    // The Vite dev proxy keeps a browser's stream open, silent, when the coordinator dies; only this reveals it.
    const ping = () =>
      send({ seq: -1, workerId: "", type: "factory.ping", agentId: null, timestamp: String(Date.now()), data: null })
    ping()
    const beat = setInterval(ping, 5_000)
    // Live events that arrive during the replay wait, so none is lost or sent twice.
    let held: FeedEvent[] | null = Number.isFinite(since) && since > 0 ? [] : null
    const off = factory.feed.subscribe((ev: FeedEvent) => {
      if (!wanted(ev)) return
      if (held) held.push(ev)
      else send(ev)
    })
    if (held) {
      const replay = factory.store.after(since, REPLAY_LIMIT, worker)
      let last = since
      for (const ev of replay ?? []) {
        send(ev)
        last = ev.seq
      }
      send({
        seq: -1,
        workerId: "",
        type: "factory.feed_replay",
        agentId: null,
        timestamp: now(),
        data: { complete: replay !== null, replayed: replay?.length ?? 0 },
      })
      // Status changes are not stored; send the current state of every agent instead.
      for (const w of factory.workers.values())
        send({
          seq: -1,
          workerId: w.id,
          type: "factory.worker_updated",
          agentId: null,
          timestamp: now(),
          data: w.summary(),
        })
      for (const ev of held) if (ev.seq > last || ev.seq < 0) send(ev)
      held = null
    }
    return () => (clearInterval(beat), off())
  })
}

/** Deliver an approval answer to the coordinator of the approval's conversation, so it continues. */
const answerApproval = (a: ReturnType<typeof factory.approvals.answer>) => {
  // A config or prompt proposal applies here, on the human's answer, never in the agent's tool call.
  try {
    const settled = settleProposal(factory.root, a)
    if (settled) {
      publishConfig()
      a = { ...a, note: [a.note, `factory config ${settled}`].filter(Boolean).join("; ") }
    }
  } catch (e) {
    a = {
      ...a,
      note: [a.note, `factory config change failed: ${e instanceof Error ? e.message : e}`].filter(Boolean).join("; "),
    }
  }
  return deliverAndLog(a.threadId, answerPrompt(a))
}

/** Shadow mode: Jev predicts each new decision's answer from INSTRUCTIONS.md (re-read each time, so edits apply at once). */
factory.feed.subscribe((ev) => {
  if (ev.type !== "factory.approval_requested") return
  const requested = Option.flatMap(decodeId(ev.data), ({ id }) => Option.fromNullishOr(factory.approvals.get(id)))
  if (Option.isNone(requested)) return
  const { id } = requested.value
  predict(requested.value, readInstructions())
    .catch((e) => (console.error(`shadow prediction failed: ${e}`), null))
    .then((shadow) => {
      const a = factory.approvals.setShadow(id, shadow)
      if (a) factory.publish("coordinator", "factory.approval_shadowed", null, now(), a)
    })
})

/** An event for the Factory desk, saved in its thread, with a fresh snapshot instead of remembered state. */
const toDesk = (event: string) =>
  deliverAndLog(deskThread().id, `${event}\n\n<factory-status>\n${JSON.stringify(snapshot())}\n</factory-status>`)

/** Fire each enabled cron prompt at the coordinator on schedule, skipping while it is busy. */
const lastCron = new Map<string, number>()
loop("crons", "1 second", () => {
  const crons = factory.settings.crons
  for (const k of lastCron.keys()) if (!(k in crons)) lastCron.delete(k)
  const c = factory.workers.get("coordinator")
  if (!c) return
  for (const [name, cron] of Object.entries(crons)) {
    if (!cron.enabled) continue
    if (!lastCron.has(name)) lastCron.set(name, Date.now())
    if (Date.now() - lastCron.get(name)! < cron.everySeconds * 1000 || c.status === "running") continue
    lastCron.set(name, Date.now())
    factory.publish("coordinator", "factory.cron_fired", null, now(), { name })
    toDesk(`[cron: ${name}] ${cron.prompt}`)
  }
})

/**
 * Supervisor: every `supervisor.everySeconds`, check the workers. Stuck, failing, off-track or
 * uncollected workers go to the coordinator as one prompt. An issue is reported once until it changes.
 */
let lastSupervision = Date.now()
const reported = new Map<string, string>()
const latestWorkerActivity = (worker: Worker): string =>
  worker.log
    .filter((e) => e.type === "tool.execution_start" || e.type === "assistant.message")
    .slice(-6)
    .map((e) =>
      e.type === "tool.execution_start"
        ? Option.match(decodeToolStart(e.data), {
            onNone: () => "",
            onSome: (d) => `${d.toolName} ${JSON.stringify(d.arguments ?? {}).slice(0, 200)}`,
          })
        : Option.match(decodeContent(e.data), { onNone: () => "", onSome: (d) => d.content.slice(0, 300) }),
    )
    .join("\n")

const offTrackIssues = async (workers: Worker[]): Promise<Issue[]> => {
  const running = workers.filter((w) => w.role === "worker" && w.status === "running" && w.task)
  const scores = await onTrack(
    running.map((w) => ({ id: w.id, task: w.task!, latest: latestWorkerActivity(w) })),
  ).catch(() => ({}) as Record<string, number>)
  return running.flatMap((worker) =>
    (scores[worker.id] ?? 1) < 0.3
      ? [
          {
            worker: worker.id,
            name: worker.name,
            kind: "off-track" as const,
            detail: `Jev on-track probability ${scores[worker.id]!.toFixed(2)}`,
          },
        ]
      : [],
  )
}

const collectSupervisionIssues = async (
  workers: Worker[],
  cfg: typeof factory.settings.supervisor,
): Promise<Issue[]> => {
  const issues = findIssues(workers, Date.now(), {
    stallSeconds: cfg.stallSeconds,
    uncollectedSeconds: cfg.everySeconds,
    failedToolsInARow: 3,
  })
  if (cfg.offTrackCheck) issues.push(...(await offTrackIssues(workers)))
  return issues
}

const freshSupervisionIssues = (issues: Issue[]): Issue[] => {
  for (const key of reported.keys()) if (!factory.workers.has(key.split("|")[0]!)) reported.delete(key)
  return issues.filter((issue) => reported.get(`${issue.worker}|${issue.kind}`) !== issue.detail)
}

const groupIssuesByOwner = (issues: Issue[], coordinator: Worker): Map<string, Issue[]> => {
  const grouped = new Map<string, Issue[]>()
  for (const issue of issues) {
    const owner = factory.workers.get(issue.worker)?.owner ?? coordinator.id
    grouped.set(owner, [...(grouped.get(owner) ?? []), issue])
  }
  return grouped
}

const sendSupervisionIssues = (issues: Issue[], coordinator: Worker): void => {
  for (const [owner, list] of groupIssuesByOwner(issues, coordinator)) {
    const recipient = factory.workers.get(owner) ?? coordinator
    if (recipient.status === "running") continue
    for (const issue of list) reported.set(`${issue.worker}|${issue.kind}`, issue.detail)
    if (recipient === coordinator) toDesk(supervisorPrompt(list))
    else
      recipient
        .send(factory.coordinatorPrompt(supervisorPrompt(list)))
        .catch((e) => console.error(`supervisor prompt failed: ${e}`))
  }
}

const supervise = async () => {
  const cfg = factory.settings.supervisor
  const coordinator = factory.workers.get("coordinator")
  if (!cfg.enabled || !coordinator || Date.now() - lastSupervision < cfg.everySeconds * 1000) return
  lastSupervision = Date.now()
  const workers = [...factory.workers.values()]
  const issues = await collectSupervisionIssues(workers, cfg)
  const fresh = freshSupervisionIssues(issues)
  factory.publish("coordinator", "factory.supervisor_check", null, now(), { issues, reported: fresh.length })
  sendSupervisionIssues(fresh, coordinator)
}
loop("supervisor", "5 seconds", supervise)

// ---------- drafts ----------

const drafts = makeDrafts({
  threads,
  createThread: (prompt, folderId) => {
    if (!threads.folder(folderId)) throw new DraftError(400, "unknown folder")
    return createThread(prompt, folderId)
  },
  spawn: (spec) =>
    spawnHealing(
      factory,
      {
        id: spec.owner,
        threadId: threads.list().find((t) => t.worktree === spec.workdir)?.id ?? null,
        workdir: spec.workdir,
      },
      { ...spec, role: "worker", auth: factory.defaultAuth },
    ),
  isRunning: (workerId) => factory.workers.get(workerId)?.status === "running",
  stopOwned: async (owner) => {
    for (const w of [...factory.workers.values()]) if (w.owner === owner) await factory.stop(w.id)
  },
  discard: (t) => deleteThread(t.id),
  // Awaits the hand-off, so a failed delivery rejects and run() unlocks the draft.
  deliver: async (id, text) => {
    await (
      await deliverToThread(id, text)
    ).sent
  },
  stopSub: async (id) => {
    if (factory.workers.has(subId(id))) await factory.stop(subId(id))
  },
  enhance: enhanceWith(factory),
  stopEnhance: (id) => stopEnhance(factory, draftNodeId(id)),
  changed: (threadId) => factory.publish("coordinator", "factory.thread_updated", null, now(), { threadId }),
})

/** Read one payload shape from a feed event; a payload of another shape gives None. */
const decodeOwner = Schema.decodeUnknownOption(Schema.Struct({ owner: Schema.NullOr(Schema.String) }))
const decodeId = Schema.decodeUnknownOption(Schema.Struct({ id: Schema.String }))
const decodeToolStart = Schema.decodeUnknownOption(
  Schema.Struct({ toolName: Schema.String, arguments: Schema.optionalKey(Schema.Unknown) }),
)
const decodeContent = Schema.decodeUnknownOption(Schema.Struct({ content: Schema.String }))

const CreateBody = Schema.Struct({ folderId: Schema.String, prompt: Schema.String })
const VersionBody = Schema.Struct({ prompt: Schema.String })
const CurrentBody = Schema.Struct({ versionId: Schema.String })
const PickBody = Schema.Struct({ index: Schema.Int })

/**
 * The thread fields a PATCH may change: title, cleanedAt, archivedAt. An archivedAt that is not a number (null)
 * is sent as present but empty, so the update clears it.
 */
const threadPatch = (b: Fields): Partial<Thread> => ({
  ...(typeof b.title === "string" ? { title: b.title } : {}),
  ...(typeof b.cleanedAt === "number" ? { cleanedAt: b.cleanedAt } : {}),
  ...("archivedAt" in b ? { archivedAt: typeof b.archivedAt === "number" ? b.archivedAt : undefined } : {}),
})

/** Decode a draft request body; bad JSON or a bad shape is a 400. */
const draftBody = async <A>(req: Request, schema: Schema.Codec<A, unknown>): Promise<A> => {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    throw new DraftError(400, "body is not JSON")
  }
  try {
    return Schema.decodeUnknownSync(schema)(raw)
  } catch (e) {
    throw new DraftError(400, e instanceof Error ? e.message : String(e))
  }
}

/** JSON reply for a draft route: no value is 204, DraftError keeps its status, anything else is 500. */
const draftReply = async (run: () => unknown): Promise<Response> => {
  try {
    const v = await run()
    return v === undefined ? empty(204) : json(v)
  } catch (e) {
    if (e instanceof DraftError) return json({ error: e.message }, e.status)
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
}

// ---------- routes ----------

type Handler = (req: Request, url: URL, params: string[]) => Response | Promise<Response>
/** The repo conversation an agent works in: its own (sub-coordinator), its owner's, or the one whose worktree it uses. */
const threadOfAgent = (w: Worker): Thread | undefined =>
  threads
    .list()
    .find((t) => t.worktree && (t.worktree === w.spec?.workdir || subId(t.id) === w.id || subId(t.id) === w.owner))

/** The tool scope of a coordinator by worker id: a repo sub-coordinator's worktree, a General chat's thread, the desk. */
const cardScope = (id: string): Scope => {
  const w = factory.workers.get(id)
  const t = w ? threadOfAgent(w) : threads.list().find((x) => subId(x.id) === id || genId(x.id) === id)
  if (t?.worktree) return { id, threadId: t.id, workdir: t.worktree, ...(t.base ? { base: t.base } : {}) }
  return { id, threadId: t?.id ?? null }
}

// Per-goal state (ADR 0007) and cost limits; created before the server so every handler can use them.
const goalStates = new GoalStates(factory.root)
const goalBudgets = new GoalBudgets(factory.root)
const goals = makeGoals(
  goalsDir(),
  steps().map((step) => step.id),
)
/** prototypes/software-factory: its commit (and dirty flag) is the factory version a goal run ran on. */
const FACTORY_DIR = path.resolve(new URL(".", import.meta.url).pathname, "../..")

const [hostname, port] = (process.env.SF_ADDR ?? "127.0.0.1:7700").split(":")

/** Guided goal page (web-foldkit/public/goal-page/): routes /api/goal-page/<name>. */
const goalPage = makeGoalPage({
  proxyUrl: () => factory.proxyUrl,
  folders: () => threads.folders().filter((f) => f.path),
  knownSteps: () => steps().map((step) => step.id),
  goals,
  startResearch: async (folderId, brief) => {
    const t = drafts.create(folderId, brief)
    const d = await drafts.act(t.id, "research")
    const r = d.reports.find((x) => x.action === "research")!
    return { threadId: t.id, workerId: r.workerId, worktree: t.worktree!, report: r.path }
  },
  workerState: (id) => factory.workers.get(id)?.summary(),
  removeDraft: (id) => drafts.remove(id),
  startRun: startGoalRun(`http://${hostname}:${port}`, path.join(factory.root, "logs", "goal-runs")),
  recordUsage: (data) => factory.publish(GOAL_PAGE_AGENT, "assistant.usage", null, now(), data),
})

/** JSON reply for a goal route: GoalError is 400, anything else 500. */
const goalReply = async (run: () => unknown): Promise<Response> => {
  try {
    const v = await run()
    return v === null ? json({ error: "not found" }, 404) : json(v)
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : String(e) },
      e instanceof GoalError || e instanceof SyntaxError ? 400 : 500,
    )
  }
}

/** SDLC record of a conversation: tier, criteria and which lack PASS evidence, gates, code reviews, metrics. */
const runSdlc = (scopeId: string, workdir: string | undefined): Run["sdlc"] => {
  const sdlc = factory.sdlc.get(scopeId)
  if (!sdlc) return null
  const evidence =
    workdir && existsSync(artifact(workdir, "evidence.md"))
      ? readFileSync(artifact(workdir, "evidence.md"), "utf8")
      : null
  return {
    tier: sdlc.risk?.tier ?? null,
    criteria: sdlc.criteria,
    unproven: unprovenCriteria(sdlc.criteria, evidence),
    gates: sdlc.gates,
    codeReviews: [...factory.codeReviews.values()]
      .filter((r) => r.scopeId === scopeId)
      .map((r) => ({
        id: r.id,
        status: r.status,
        lenses: r.lenses,
        kept: r.findings.filter((x) => x.keep).length,
        dropped: r.findings.filter((x) => !x.keep).length,
      })),
    metrics: {
      minutes: Math.round((Date.now() - sdlc.startedAt) / 60_000),
      workers: sdlc.workers,
      findingsKept: sdlc.findings.kept,
      findingsDropped: sdlc.findings.dropped,
    },
  }
}

/** Newest report_up of a conversation, from the event store. */
const latestReport = (threadId: string): Run["report"] => {
  const all = factory.store.latest("factory.report_up", 500) as { threadId: string | null; report: Report }[]
  const r = all.filter((e) => e.threadId === threadId).at(-1)?.report
  return r ? { status: r.status, summary: r.summary, gaps: r.gaps } : null
}

/** The branch's PR, or why it could not be read: a gh failure is a grading error, never "no PR". */
const prOf = async (t: Thread): Promise<Pick<Run, "pr" | "prError">> => {
  const repo = threads.folder(t.folderId)?.path
  if (!repo || !t.branch) return { pr: null }
  const r = await branchPr(repo, t.branch)
  return "error" in r ? { pr: null, prError: r.error } : { pr: r.pr }
}

/** Cost of every agent, rolled up the agent tree; owners from each agent's start event (live agents win). */
const costTree = () => {
  const byId = new Map<string, AgentInfo>()
  for (const a of [...(factory.store.latest("factory.worker_started", 100_000) as AgentInfo[]), ...factory.summaries()])
    byId.set(a.id, {
      id: a.id,
      name: a.name,
      role: a.role,
      owner: a.owner,
      step: a.step ?? null,
      harness: a.harness ?? "copilot",
    })
  const usd = factoryConfig().costs.usd_per_ai_credit
  return { costs: rollUp(factory.store.usageRows(), [...byId.values()], factory.store.rates(), usd, DESK_ID), usd }
}

/** The delivery record of a repo conversation; null when the thread does not exist. */
const runRecord = async (threadId: string): Promise<Run | null> => {
  const t = threads.get(threadId)
  if (!t) return null
  const started = factory.store.latest("factory.worker_started", 100_000) as Parameters<typeof runWorkers>[0]
  const listed = runWorkers(started, subId(t.id), (id) => factory.workers.get(id)?.status)
  const invoked = factory.store.skillsInvoked(listed.map((w) => w.id))
  const workers = listed.map((w) => ({ ...w, skills: invoked.get(w.id) ?? [] }))
  return {
    threadId: t.id,
    status: statusOf(t.id),
    branch: t.branch ?? null,
    base: t.base ?? null,
    workers,
    steps: [...new Set(workers.flatMap((w) => (w.step ? [w.step] : [])))],
    approvals: factory.approvals
      .list()
      .filter((a) => a.threadId === t.id || a.reportThreadId === t.id)
      .map((a) => ({
        id: a.id,
        title: a.title,
        topic: a.topic ?? "other",
        status: a.status,
        answer: a.answer,
        options: a.options,
      })),
    securityReviews: [...factory.securityReviews.values()]
      .filter((r) => r.threadId === t.id)
      .map((r) => ({ id: r.id, status: r.status })),
    report: latestReport(t.id),
    sdlc: runSdlc(subId(t.id), t.worktree),
    ...(await prOf(t)),
    grades: gradesOf(t),
    goal: t.goalId ? goalStates.get(t.goalId) : null,
    budget: t.goalId
      ? (() => {
          const costs = costTree().costs
          const b = budgetOf(t.goalId)
          return {
            limitUsd: b.limitUsd,
            spentUsd: goalSpent(t.goalId, costs),
            runUsd: runCost(costs, t, subId, false)?.total.usd ?? 0,
            status: b.status,
          }
        })()
      : null,
    improvement: t.improvement ?? null,
    ...(t.improvementOf ? { improvementOf: t.improvementOf } : {}),
  }
}

// ---------- grading and human-gated improvement (README "Grading") ----------

const {
  enabled: GRADING,
  gradesOf,
  gradeThread,
  improvementAnswered,
  retryImprovements,
  regradePending,
} = makeGrading({
  threads,
  goals,
  approvals: factory.approvals,
  runRecord,
  openConversation,
  criteria: (id) => factory.sdlc.get(subId(id))?.criteria ?? [],
  loopManaged: (id) => !!goalStates.byThread(id),
  evaluation: (id) => {
    const e = lastEvaluation(factory.evaluations.values(), subId(id))
    return e && e.verdicts.length && e.file ? { results: verdictResults(e), file: e.file } : null
  },
  cost: (id) => {
    const t = threads.get(id)
    const r = t && runCost(costTree().costs, t, subId, true)
    return r ? gradeCost(r) : null
  },
  deskThreadId: () => deskThread().id,
  factoryDir: FACTORY_DIR,
  publish: (type, data) => factory.publish("coordinator", type, null, now(), data),
})

if (GRADING) {
  loop("improvement-retry", "1 minute", retryImprovements)
  loop("grade-pending-checks", "1 minute", regradePending)
}

const routes: [string, RegExp, Handler][] = [
  ["GET", /^\/$/, () => new Response(landing, { headers: { "content-type": "text/html" } })],
  [
    "GET",
    /^\/api\/info$/,
    () =>
      json({
        defaultAuth: factory.defaultAuth,
        defaultModel: factory.defaultModel,
        proxyUrl: factory.proxyUrl,
        workers: factory.summaries(),
      }),
  ],
  ["GET", /^\/api\/settings$/, async () => json(await factory.settingsView())],
  ["GET", /^\/api\/config$/, () => json(factoryConfigView())],
  [
    "PATCH",
    /^\/api\/config$/,
    async (req) => {
      // {key, value}: set a runtime override; value null clears it. {key, promote: true}: write it to the user file.
      try {
        const b = bodyFields(await req.json())
        const key = String(b.key)
        if (b.promote === true) config.promote(key)
        else config.setOverride(key, (b.value ?? null) as Scalar | null)
        publishConfig()
        return json(factoryConfigView())
      } catch (e) {
        return bad(e)
      }
    },
  ],
  [
    "PATCH",
    /^\/api\/settings$/,
    async (req) => {
      try {
        return json(await factory.updateSettings(await req.json()))
      } catch (e) {
        return bad(e)
      }
    },
  ],
  [
    "GET",
    /^\/api\/steps$/,
    () =>
      json({
        steps: steps(),
        decisions: factory.decisions,
        run: factory.run,
        securityReviews: [...factory.securityReviews.values()].slice(-20),
      }),
  ],
  ["GET", /^\/api\/approvals$/, () => json(factory.approvals.list().slice(-50))],
  [
    // "Start" on a report finding card: a new conversation in the report's repo runs that finding (same as the viewer).
    "POST",
    /^\/api\/cards\/start-finding$/,
    async (req) => {
      try {
        const b = fieldsOf(await req.json())
        const scope = cardScope(String(b.scope ?? DESK_ID))
        const r = findReport(threads.list(), String(b.path ?? ""), scope.threadId)
        if (!r) return bad("report not found")
        const f = reportFindings(r.content).find((x) => x.rank === Number(b.rank))
        if (!f) return bad(`finding ${String(b.rank)} not found`)
        return json(
          await startConversation(r.folderId, findingTask(r, { title: `${f.rank}. ${f.title}`, body: f.body })),
        )
      } catch (e) {
        return bad(e)
      }
    },
  ],
  [
    // A live card's current view (OpenUI Query "factory_card"): the same data its show_* tool returns, for that
    // coordinator's scope, as the view shared/cardviews.ts builds. Read-only.
    "GET",
    /^\/api\/cards$/,
    (_req, url) => {
      const name = url.searchParams.get("name") ?? ""
      if (!CARD_TOOLS.has(name)) return bad(`unknown card ${name}`)
      const cardPath = url.searchParams.get("path")
      return json(
        cardView(
          name,
          cardData(
            factory,
            cardScope(url.searchParams.get("scope") ?? DESK_ID),
            name,
            cardPath ? { path: cardPath } : {},
          ),
        ),
      )
    },
  ],
  [
    "GET",
    /^\/api\/shadow$/,
    () => json({ ...shadowStats(factory.approvals.list()), instructions: instructionsPath() }),
  ],
  ["GET", /^\/api\/folders$/, () => json(threads.folders())],
  [
    "POST",
    /^\/api\/folders$/,
    async (req) => {
      try {
        const f = threads.addFolder(String(bodyFields(await req.json()).path ?? ""))
        factory.publish("coordinator", "factory.thread_updated", null, now(), { folderId: f.id })
        return json(f)
      } catch (e) {
        return bad(e)
      }
    },
  ],
  [
    "GET",
    /^\/api\/approvals\/([^/]+)$/,
    (_req, _url, [id]) => {
      const a = factory.approvals.get(id!)
      return a
        ? json({ ...a, threadTitle: threads.list().find((t) => t.id === a.threadId)?.title ?? null })
        : new Response("unknown decision", { status: 404 })
    },
  ],
  [
    "POST",
    /^\/api\/approvals$/,
    async (req) => {
      // Open a decision directly (tests, scripts). Same shape as the coordinator tools.
      try {
        const b = bodyFields(await req.json())
        const item = factory.approvals.open({
          kind: b.kind === "question" ? "question" : "approval",
          threadId: typeof b.threadId === "string" ? b.threadId : null,
          title: String(b.title ?? ""),
          summary: String(b.summary ?? ""),
          options: Array.isArray(b.options) ? b.options.map(String) : [],
          ...(typeof b.context === "string" ? { context: b.context } : {}),
          ...(Array.isArray(b.optionDetails) ? { optionDetails: b.optionDetails.map(String) } : {}),
        })
        if (!item.title.trim()) throw new Error("title is empty")
        factory.publish("coordinator", "factory.approval_requested", null, now(), item)
        return json(item)
      } catch (e) {
        return bad(e)
      }
    },
  ],
  [
    "POST",
    /^\/api\/approvals\/([^/]+)$/,
    async (req, _url, [id]) => {
      try {
        const b = bodyFields(await req.json())
        const a = factory.approvals.answer(
          id!,
          String(b.answer),
          typeof b.note === "string" && b.note.trim() ? b.note.trim() : null,
          typeof b.by === "string" && b.by.trim() ? b.by.trim().slice(0, 200) : null,
        )
        factory.publish("coordinator", "factory.approval_answered", null, now(), a)
        if (!improvementAnswered(a) && !budgetAnswered(a) && !goalAnswered(a)) answerApproval(a)
        return json(a)
      } catch (e) {
        return bad(e)
      }
    },
  ],
  ["GET", /^\/api\/extension-errors$/, () => json([...factory.extensionErrors.values()])],
  [
    "POST",
    /^\/api\/extension-errors$/,
    async (req) => {
      // Browsers report extension failures here so the agent can see and fix them.
      const b = bodyFields(await req.json().catch(() => ({})))
      const ext = typeof b.extension === "string" ? b.extension : "?"
      const ui = typeof b.ui === "string" ? b.ui : "?"
      const entry = { extension: ext, ui, error: b.error ?? null, at: now() }
      factory.extensionErrors.set(`${ext}@${ui}`, entry)
      factory.publish("coordinator", "factory.extension_error", null, now(), entry)
      return empty(204)
    },
  ],
  ["GET", /^\/api\/workers$/, () => json(factory.summaries())],
  // Stopped agents, for a historical record (live ones are in /api/workers). Their transcripts stay in the event store.
  [
    "GET",
    /^\/api\/workers\/past$/,
    () =>
      json(
        pastWorkers(
          factory.store.latestTimed("factory.worker_started", 100_000) as { ts: number; data: WorkerSummary }[],
          (id) => factory.workers.has(id),
        ),
      ),
  ],
  [
    "DELETE",
    /^\/api\/workers\/([^/]+)$/,
    async (_req, _url, [id]) => {
      if (id === "coordinator") return bad("the coordinator cannot be stopped")
      try {
        await factory.stop(id!)
        return empty(204)
      } catch (e) {
        return bad(e)
      }
    },
  ],
  [
    "POST",
    /^\/api\/workers\/([^/]+)\/message$/,
    async (req, _url, [id]) => {
      try {
        const body = bodyFields(await req.json())
        const prompt = body.prompt
        if (typeof prompt !== "string") return bad("prompt must be a string")
        // A coordinator's prompt is saved as a turn in its conversation, so every chat shows it and the answer.
        // The caller may name the conversation (the card it answers came from); it must belong to this coordinator.
        const named = typeof body.threadId === "string" ? body.threadId : undefined
        const threadId = messageThread(threads.list(), id!, named, factory.currentThread)
        if (threadId) logFailure(await deliverToThread(threadId, prompt))
        else await factory.get(id!).send(prompt)
        return empty(202)
      } catch (e) {
        return bad(e)
      }
    },
  ],
  [
    "POST",
    /^\/api\/workers\/([^/]+)\/abort$/,
    async (_req, _url, [id]) => {
      try {
        await factory.get(id!).session.abort()
        return empty(202)
      } catch (e) {
        return bad(e)
      }
    },
  ],
  [
    "GET",
    /^\/api\/reports$/,
    (_req, url) => {
      // An agent id scopes a relative path to that agent's conversation worktree.
      const agent = url.searchParams.get("agent")
      const w = agent ? factory.workers.get(agent) : undefined
      const scope = url.searchParams.get("thread") ?? (w ? threadOfAgent(w)?.id : undefined) ?? null
      const r = findReport(threads.list(), url.searchParams.get("path") ?? "", scope)
      return r ? json(r) : new Response("report not found in any conversation worktree", { status: 404 })
    },
  ],
  [
    // One click from a report finding: a new conversation in the report's repo folder runs the delivery loop.
    "POST",
    /^\/api\/reports\/start$/,
    async (req) => {
      try {
        const b = fieldsOf(await req.json())
        const r = findReport(threads.list(), String(b.path ?? ""), typeof b.thread === "string" ? b.thread : null)
        if (!r) return bad("report not found")
        if (typeof b.title !== "string" || !b.title.trim()) return bad("finding title required")
        return json(await startConversation(r.folderId, findingTask(r, { title: b.title, body: String(b.body ?? "") })))
      } catch (e) {
        return bad(e)
      }
    },
  ],
  [
    "GET",
    /^\/api\/workers\/([^/]+)\/spec$/,
    (_req, _url, [id]) => {
      try {
        const w = factory.get(id!)
        const thread = threadOfAgent(w)
        let plugins: string[] = []
        try {
          plugins = readdirSync(path.join(w.home, "installed-plugins"))
        } catch {}
        return json(specView(w, w.spec, w.log, thread, plugins))
      } catch (e) {
        return bad(e)
      }
    },
  ],
  [
    "GET",
    /^\/api\/workers\/([^/]+)\/events$/,
    (_req, url, [id]) => {
      try {
        // ?from=SEQ&before=SEQ: the stored events older than a loaded window (to reach an old search hit).
        const from = Number(url.searchParams.get("from")),
          before = Number(url.searchParams.get("before"))
        if (from > 0 && before > 0) return json(factory.store.between(id!, from, before, KEEP_PER_WORKER))
        // A stopped agent's history comes from the event store.
        const w = factory.workers.get(id!)
        return json(w ? w.log : factory.store.load(id!, 4000))
      } catch (e) {
        return bad(e)
      }
    },
  ],
  [
    "GET",
    /^\/api\/search$/,
    // Full-text search over every agent's messages, errors and tool calls: ?q=TEXT&workers=a,b&limit=N
    (_req, url) =>
      json(
        factory.store.search(
          url.searchParams.get("q") ?? "",
          Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200),
          url.searchParams.get("workers")?.split(",").filter(Boolean),
        ),
      ),
  ],
  [
    "GET",
    /^\/api\/events$/,
    // One timeline across agents: ?workers=a,b&types=x,y&perWorker=N&since=SEQ (all optional).
    (_req, url) => {
      const list = (k: string) => url.searchParams.get(k)?.split(",").filter(Boolean)
      const since = url.searchParams.get("since")
      return new Response(
        factory.store.timeline({
          workers: list("workers"),
          types: list("types"),
          perWorker: Math.min(Number(url.searchParams.get("perWorker") ?? 4000) || 4000, 20_000),
          ...(since ? { since: Number(since) } : {}),
        }),
        { headers: { "content-type": "application/json" } },
      )
    },
  ],
  ["GET", /^\/api\/feed$/, (req, url) => feed(req, url)],
  ["POST", /^\/api\/agui\/stop$/, (req) => aguiStop(req)],
  ["GET", /^\/api\/agui\/capabilities$/, () => json(CAPABILITIES)],
  ["POST", /^\/api\/agui$/, (req, url) => aguiRun(null, url, req)],
  ["POST", /^\/api\/agui\/([^/]+)$/, (req, url, [id]) => aguiRun(id!, url, req)],
  [
    "GET",
    /^\/api\/costs$/,
    () => {
      const { costs, usd } = costTree()
      return json(costReport(costs, threads.list(), subId, usd, DESK_ID))
    },
  ],
  [
    "GET",
    /^\/api\/costs\/([^/]+)$/,
    (_req, _url, [id]) => {
      const t = threads.get(id!)
      const r = t && runCost(costTree().costs, t, subId, true)
      return r ? json(r) : json({ error: `no repo conversation ${id}` }, 404)
    },
  ],
  [
    "GET",
    /^\/api\/costs$/,
    () => {
      const { costs, usd } = costTree()
      return json(costReport(costs, threads.list(), subId, usd, DESK_ID))
    },
  ],
  [
    "GET",
    /^\/api\/costs\/([^/]+)$/,
    (_req, _url, [id]) => {
      const t = threads.get(id!)
      const r = t && runCost(costTree().costs, t, subId, true)
      return r ? json(r) : json({ error: `no repo conversation ${id}` }, 404)
    },
  ],
  [
    "GET",
    /^\/api\/runs\/([^/]+)$/,
    async (_req, _url, [id]) => {
      const run = await runRecord(id!)
      return run ? json(run) : json({ error: `no thread ${id}` }, 404)
    },
  ],
  [
    "GET",
    /^\/api\/files\/image$/,
    (_req, url) => {
      const r = servableImage(url.searchParams.get("path") ?? "", [factory.root, worktreeRoot(), ARTIFACTS_DIR])
      return "error" in r
        ? json({ error: r.error }, 404)
        : new Response(Bun.file(r.path), { headers: { "content-type": r.type, "cache-control": "no-store" } })
    },
  ],
  [
    "GET",
    /^\/api\/goals$/,
    () =>
      goalReply(() => ({
        dir: goals.dir,
        factoryCommit: checkoutCommit(FACTORY_DIR),
        goals: goals.list().map((g) => ({ ...g, state: goalStates.get(g.spec.id) })),
      })),
  ],
  ["POST", /^\/api\/goals$/, (req) => goalReply(async () => goals.save(await req.json()))],
  ["GET", /^\/api\/goals\/([^/]+)$/, (_req, _url, [id]) => goalReply(() => goals.get(id!))],
  [
    "GET",
    /^\/api\/goals\/([^/]+)\/prompt$/,
    (_req, _url, [id]) =>
      goalReply(() => {
        const spec = goals.get(id!)
        return (
          spec && {
            skill: `sf goal run ${spec.id}`,
            prompt: loopPrompt(readFileSync(path.join(FACTORY_DIR, "skills/factory-loop/SKILL.md"), "utf8"), spec),
          }
        )
      }),
  ],
  ["GET", /^\/api\/goals\/([^/]+)\/runs$/, (_req, _url, [id]) => goalReply(() => goals.runs(id!))],
  [
    "POST",
    /^\/api\/goals\/([^/]+)\/start$/,
    (_req, _url, [id]) =>
      goalReply(async () => {
        const r = await startGoal(id!)
        const s = goalStates.get(id!)
        return { ...r, loop: s?.loop ?? 1, status: s?.status ?? "running" }
      }),
  ],
  ["GET", /^\/api\/goals\/([^/]+)\/state$/, (_req, _url, [id]) => goalReply(() => goalStates.get(id!))],
  [
    "POST",
    /^\/api\/goals\/([^/]+)\/runs$/,
    (req, _url, [id]) =>
      goalReply(async () =>
        goals.appendRun(id!, { factoryCommit: checkoutCommit(FACTORY_DIR), ...(await req.json()) }),
      ),
  ],
  ["GET", /^\/api\/threads\/get$/, () => json({ threads: threads.list(), folders: threads.folders() })],
  ["GET", /^\/api\/threads\/get\/([^/]+)$/, (_req, _url, [id]) => json(threads.messages(id!))],
  // Diff panel: every change of the conversation's worktree against its base. A thread without a worktree
  // (general chat) shows the factory run worktree. Paths come from the server only, never from the request.
  [
    "GET",
    /^\/api\/threads\/([^/]+)\/diff$/,
    (_req, _url, [id]) => {
      const t = threads.get(id!)
      const wt =
        t?.worktree && !t.cleanedAt
          ? { worktree: t.worktree, base: t.base }
          : factory.run && { worktree: factory.run.worktree, base: factory.run.base }
      if (!wt?.base) return new Response("no worktree for this conversation", { status: 404 })
      try {
        return json(worktreeDiff(wt.worktree, wt.base))
      } catch (e) {
        return new Response(`git diff failed: ${e instanceof Error ? e.message : String(e)}`, { status: 500 })
      }
    },
  ],
  [
    "POST",
    /^\/api\/threads\/create$/,
    async (req) => {
      const b = fieldsOf(await req.json().catch(() => ({})))
      const first = fieldsOf(listOf(b.messages)[0]).content
      const folderId = typeof b.folderId === "string" ? b.folderId : cookieFolder(req)
      try {
        const base = typeof b.base === "string" && b.base.trim() ? b.base.trim() : undefined
        const goalId = typeof b.goalId === "string" ? b.goalId : undefined
        const goalSpec = goalId ? goals.get(goalId) : null
        if (goalId && !goalSpec) throw new Error(`no goal ${goalId}`)
        // A paused or stopped goal starts no new run; a stopped one asks the human again for a limit.
        if (goalId && goalBlocked(goalId)) {
          const gb = budgetOf(goalId)
          const item = gb.status === "stopped" ? openPause(goalId, gb, goalSpent(goalId), [], "stopped earlier") : null
          throw new Error(
            `goal ${goalId} is ${gb.status} at its cost limit ($${gb.limitUsd} for all its runs); answer approval ${item?.id ?? gb.approvalId} to raise the limit, then run it again`,
          )
        }
        const t = createThread(
          typeof first === "string" ? first : null,
          threads.folder(folderId) ? folderId : GENERAL.id,
          base,
        )
        if (goalId && goalSpec) threads.setMeta(t.id, { goalId, goalSpec })
        return json(threads.get(t.id) ?? t)
      } catch (e) {
        return bad(e)
      }
    },
  ],
  [
    "PATCH",
    /^\/api\/threads\/update\/([^/]+)$/,
    async (req, _url, [id]) => {
      const t = threads.update(id!, threadPatch(bodyFields(await req.json())))
      // Archiving a General chat stops its session; its next message starts it again.
      if (t?.archivedAt && !t.worktree && !t.desk && factory.workers.has(genId(t.id))) await factory.stop(genId(t.id))
      if (t) factory.publish("coordinator", "factory.thread_updated", null, now(), { threadId: t.id })
      return json(t ?? null)
    },
  ],
  [
    "DELETE",
    /^\/api\/threads\/delete\/([^/]+)$/,
    async (_req, _url, [id]) => {
      await deleteThread(id!)
      return empty(204)
    },
  ],
  [
    "POST",
    /^\/api\/drafts$/,
    (req) =>
      draftReply(async () => {
        const b = await draftBody(req, CreateBody)
        return drafts.create(b.folderId, b.prompt)
      }),
  ],
  [
    "POST",
    /^\/api\/drafts\/([^/]+)\/versions$/,
    (req, _url, [id]) => draftReply(async () => drafts.addVersion(id!, (await draftBody(req, VersionBody)).prompt)),
  ],
  [
    "POST",
    /^\/api\/drafts\/([^/]+)\/current$/,
    (req, _url, [id]) => draftReply(async () => drafts.setCurrent(id!, (await draftBody(req, CurrentBody)).versionId)),
  ],
  ["POST", /^\/api\/drafts\/([^/]+)\/enhance$/, (_req, _url, [id]) => draftReply(() => drafts.enhance(id!))],
  [
    "POST",
    /^\/api\/drafts\/([^/]+)\/pick$/,
    (req, _url, [id]) => draftReply(async () => drafts.pick(id!, (await draftBody(req, PickBody)).index)),
  ],
  ["POST", /^\/api\/drafts\/([^/]+)\/dismiss$/, (_req, _url, [id]) => draftReply(async () => drafts.dismiss(id!))],
  [
    "POST",
    /^\/api\/drafts\/([^/]+)\/(council|debate|research|hyperresearch)$/,
    (_req, _url, [id, action]) => draftReply(() => drafts.act(id!, action as DraftAction)),
  ],
  ["POST", /^\/api\/drafts\/([^/]+)\/run$/, (_req, _url, [id]) => draftReply(() => drafts.run(id!))],
  ["DELETE", /^\/api\/drafts\/([^/]+)$/, (_req, _url, [id]) => draftReply(() => drafts.remove(id!))],
  ["GET", /^\/api\/artifacts$/, () => json({ artifacts: [] })],
  ["GET", /^\/api\/goal-page\/(info|repos)$/, (req, _url, [name]) => goalPage.handle(req, name!)],
  ["POST", /^\/api\/goal-page\/([a-z]+(?:\/[a-z]+)?)$/, (req, _url, [name]) => goalPage.handle(req, name!)],
]

const cors = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "*",
  "access-control-allow-headers": "*",
}

const server = Bun.serve({
  hostname,
  port: Number(port),
  idleTimeout: 0,
  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors })
    const url = new URL(req.url)
    for (const [method, re, handler] of routes) {
      const m = method === req.method && url.pathname.match(re)
      if (!m) continue
      const res = await handler(req, url, m.slice(1).map(decodeURIComponent))
      for (const [k, v] of Object.entries(cors)) res.headers.set(k, v)
      return res
    }
    return empty(404)
  },
})
console.error(`software-factory coordinator on http://${server.hostname}:${server.port}`)

/** Hand a stopped conversation back to its sub-coordinator: rerun a stopped code review, then one handoff turn. */
const handoff = (t: Thread, lost: Interrupted[], at: number, event?: { tag: string; text: string }) => {
  const scopeId = subId(t.id)
  rerunInterruptedReview(factory, subScope(t))
  // Review and security workers belong to their gate (it runs again by itself), not to the sub-coordinator.
  const gateWorkers = new Set([
    ...[...factory.codeReviews.values()].flatMap((r) => (r.scopeId === scopeId ? r.workerIds : [])),
    ...[...factory.securityReviews.values()].flatMap((r) => (r.scopeId === scopeId && r.workerId ? [r.workerId] : [])),
    ...[...factory.evaluations.values()].flatMap((e) => (e.scopeId === scopeId ? e.workerIds : [])),
  ])
  const text = resumePrompt({
    at,
    ...(event ? { event } : {}),
    lost: lost.filter((w) => !gateWorkers.has(w.id) && w.id !== scopeId),
    workdir: t.worktree!,
    base: t.base,
    sdlc: factory.sdlc.get(scopeId),
  })
  deliverAndLog(t.id, text)
}

// ---------- cost limit of goals (budget.ts): no time limit; pause the goal at its limit and ask the human ----------

/** Every run (repo conversation) of a goal. */
const goalRuns = (goalId: string) => threads.list().filter((t) => t.goalId === goalId && t.worktree)
const specUsd = (goalId: string) =>
  goals.get(goalId)?.limits.usd ?? goalRuns(goalId).at(-1)?.goalSpec?.limits.usd ?? DEFAULT_RUN_USD
const budgetOf = (goalId: string): Budget => goalBudgets.get(goalId, specUsd(goalId))
/** What the goal spent: every run of it together. */
const goalSpent = (goalId: string, costs = costTree().costs): number =>
  goalRuns(goalId).reduce((n, t) => n + (runCost(costs, t, subId, false)?.total.usd ?? 0), 0)
const runAgents = (t: Thread) =>
  [...factory.workers.values()].filter((w) => w.id === subId(t.id) || w.owner === subId(t.id))
const goalBlocked = (goalId: string | undefined) => !!goalId && budgetOf(goalId).status !== "ok"

/** Open the decision card of a paused or stopped goal and record it. */
const openPause = (goalId: string, b: Budget, spent: number, paused: Budget["paused"], why?: string) => {
  const card = pauseApproval(goalId, b, spent, goalRuns(goalId).length)
  const at = paused?.[0]?.threadId ?? goalRuns(goalId).at(-1)?.id ?? null
  const item = factory.approvals.open({
    threadId: at,
    ...card,
    context: `cost limit · ${why ?? "human only"}`,
    topic: "budget",
  })
  goalBudgets.set(goalId, { ...b, status: "paused", approvalId: item.id, pausedAt: b.pausedAt ?? Date.now(), paused })
  factory.publish("coordinator", "factory.approval_requested", null, now(), item)
  return item
}

const pauseGoal = async (goalId: string, b: Budget, spent: number) => {
  const busy = goalRuns(goalId).filter((t) => runAgents(t).some((w) => w.status === "running"))
  const paused = busy.map((t) => ({
    threadId: t.id,
    lost: runAgents(t)
      .filter((w) => w.status === "running")
      .map((w) => w.summary())
      .map((w) => ({ id: w.id, name: w.name, owner: w.owner, step: w.step, task: w.task })),
  }))
  openPause(goalId, b, spent, paused)
  for (const t of busy) {
    const sub = subId(t.id)
    // A contract the pause stops is not a round, as after a restart; the handoff asks for sdlc_plan again.
    const s = factory.sdlc.get(sub)
    if (s?.contractState?.status === "running")
      factory.sdlc.set(sub, {
        ...s,
        contractRounds: Math.max(0, (s.contractRounds ?? 1) - 1),
        contractState: { ...s.contractState, status: "failed", error: PAUSE_REASON },
      })
    // Workers first, so gates waiting on them end with PAUSE_REASON (and run again when the run goes on).
    for (const w of runAgents(t).filter((x) => x.id !== sub)) await factory.interrupt(w.id, PAUSE_REASON)
    await factory.interrupt(sub, PAUSE_REASON)
    factory.publish("coordinator", "factory.thread_updated", null, now(), { threadId: t.id })
  }
  factory.publish("coordinator", "factory.budget_paused", null, now(), {
    goalId,
    limitUsd: b.limitUsd,
    spentUsd: spent,
  })
  console.error(`goal ${goalId} paused at its cost limit: $${spent.toFixed(2)} of $${b.limitUsd}`)
}

const checkBudgets = async () => {
  const costs = costTree().costs
  const ids = new Set(threads.list().flatMap((t) => (t.goalId && t.worktree && !t.cleanedAt ? [t.goalId] : [])))
  for (const goalId of ids) {
    const b = budgetOf(goalId)
    const busy = goalRuns(goalId).some((t) => runAgents(t).some((w) => w.status === "running"))
    const spent = goalSpent(goalId, costs)
    if (shouldPause(b, spent, busy)) await pauseGoal(goalId, b, spent)
  }
}
loop("goal-budgets", "30 seconds", checkBudgets)

// ---------- goal loops (goalLoop.ts, ADR 0007): code runs the loops; each loop is a fresh sub-coordinator ----------

const repoRoot = (dir: string) => {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()
  } catch {
    return dir
  }
}

/** Start a goal (a new conversation and loop 1), or return its live conversation. */
const startGoal = async (goalId: string, parentGoalId?: string): Promise<{ threadId: string; resumed: boolean }> => {
  const spec = goals.get(goalId)
  if (!spec) throw new Error(`no goal ${goalId}`)
  if (goalBlocked(goalId)) {
    const gb = budgetOf(goalId)
    const item = gb.status === "stopped" ? openPause(goalId, gb, goalSpent(goalId), [], "stopped earlier") : null
    throw new Error(
      `goal ${goalId} is ${gb.status} at its cost limit ($${gb.limitUsd} for all its loops); answer approval ${item?.id ?? gb.approvalId} to raise the limit, then run it again`,
    )
  }
  const s = goalStates.get(goalId)
  const live = s && threads.get(s.threadId)
  if (s && live?.worktree && !live.cleanedAt) {
    // A stopped goal started again continues with its next loop.
    if (s.status === "stopped") goalStates.set({ ...s, status: "running", next: true, reason: undefined })
    return { threadId: s.threadId, resumed: true }
  }
  const f = threads.folder(spec.repo) ?? threads.addFolder(spec.repo)
  const t = createThread(spec.prompt, f.id, spec.base)
  threads.setMeta(t.id, { goalId, goalSpec: spec })
  goalStates.set(newGoalState(goalId, t.id, parentGoalId))
  logFailure(await deliverToThread(t.id, spec.prompt))
  return { threadId: t.id, resumed: false }
}

/** AC results of a goal loop: the independent evaluator's verdicts, else the run's own evidence. */
const goalAcs = (t: Thread): { acs: Record<string, Verdict>; acSource: GoalState["acSource"] } => {
  const e = lastEvaluation(factory.evaluations.values(), subId(t.id))
  const criteria = factory.sdlc.get(subId(t.id))?.criteria ?? []
  if (e?.verdicts.length) {
    const v = verdictResults(e)
    return {
      acs: Object.fromEntries(criteria.map((_, i) => [`AC-${i + 1}`, v[`AC-${i + 1}`] ?? "missing"])),
      acSource: "evaluator",
    }
  }
  const ev =
    t.worktree && existsSync(artifact(t.worktree, "evidence.md"))
      ? readFileSync(artifact(t.worktree, "evidence.md"), "utf8")
      : null
  return { acs: criteriaResults(criteria, ev), acSource: criteria.length ? "evidence" : null }
}

const goalPr = async (t: Thread): Promise<GoalState["pr"]> => {
  const { pr } = await prOf(t)
  return pr ? { url: pr.url, checks: pr.checks } : null
}

/** Open a human-only decision of the goal loop and remember it. */
const askGoal = (
  s: GoalState,
  card: { title: string; summary: string; options: string[]; optionDetails: string[]; allowText: boolean },
  patch: Partial<GoalState>,
) => {
  const item = factory.approvals.open({
    threadId: s.threadId,
    ...card,
    context: `goal ${s.goalId} · human only`,
    topic: "goal",
  })
  factory.publish("coordinator", "factory.approval_requested", null, now(), item)
  return goalStates.set({ ...s, ...patch, approvalId: item.id })
}

const goalDone = (s: GoalState) => {
  const t = threads.get(s.threadId)
  if (t)
    deliverAndLog(
      reportTarget(t, threads.list(), deskThread().id),
      `[goal ${s.goalId} done] Every acceptance criterion passes and the PR is green after ${s.loop} loop(s): ${s.pr?.url ?? "no PR"}. The human merges it.`,
    )
  const parent = s.parentGoalId && goalStates.get(s.parentGoalId)
  if (parent && parent.status === "waiting-child" && parent.childGoalId === s.goalId)
    askGoal(parent, childDoneCard(parent, s), {})
}

/** report_up of a goal's loop: update the goal state, then decide in code. */
const goalReported = async (threadId: string, r: Report) => {
  const t = threads.get(threadId)
  const s = t?.goalId ? goalStates.get(t.goalId) : undefined
  if (!t || !s || s.threadId !== t.id || s.status === "stopped" || s.status === "done") return
  const { state, decision } = afterReport(s, {
    at: Date.now(),
    status: r.status,
    summary: r.summary,
    gaps: r.gaps,
    commit: r.commit,
    ...(r.factoryDefect ? { factoryDefect: r.factoryDefect } : {}),
    ...goalAcs(t),
    pr: await goalPr(t),
    usd: goalSpent(t.goalId!),
  })
  const saved = goalStates.set(state)
  factory.publish("coordinator", "factory.goal_updated", null, now(), saved)
  if (decision.kind === "done") goalDone(saved)
  else if (decision.kind === "no-progress") askGoal(saved, noProgressCard(saved), {})
  else if (decision.kind === "factory-defect")
    askGoal(saved, defectCard(saved, decision.defect), { reason: decision.defect.slice(0, 300) })
}

const conversationIdle = (t: Thread) =>
  !runAgents(t).some((w) => w.status === "running") && !factory.approvals.pending().some((a) => a.threadId === t.id)

/** Start the next loop: a fresh sub-coordinator session on the same worktree, seeded from the goal state. */
const startNextLoop = async (s: GoalState) => {
  const t = threads.get(s.threadId)
  const spec = t?.goalSpec ?? goals.get(s.goalId)
  if (!t?.worktree || t.cleanedAt || !spec)
    return void goalStates.set({ ...s, next: false, status: "stopped", reason: "the goal's conversation is gone" })
  const next = goalStates.set({ ...s, loop: s.loop + 1, next: false, note: undefined, status: "running" })
  if (factory.workers.has(subId(t.id))) await factory.stop(subId(t.id))
  factory.publish("coordinator", "factory.goal_updated", null, now(), next)
  console.error(`goal ${s.goalId}: loop ${next.loop}`)
  deliverAndLog(
    t.id,
    goalLoopPrompt(
      next,
      { id: s.goalId, prompt: spec.prompt, usd: budgetOf(s.goalId).limitUsd },
      s.note,
      // Answers given after the last loop reported are newer than its gaps: the fresh session must see them.
      factory.approvals
        .list()
        .filter(
          (a) => a.threadId === t.id && a.status === "answered" && (a.answeredAt ?? 0) > (s.loops.at(-1)?.at ?? 0),
        )
        .map((a) => ({ title: a.title, answer: a.answer ?? "", note: a.note })),
    ),
  )
}

const tickGoals = async () => {
  for (const s of goalStates.list()) {
    const t = threads.get(s.threadId)
    if (!t?.worktree || t.cleanedAt || goalBlocked(s.goalId)) continue
    if (s.status === "checking" && conversationIdle(t)) {
      const pr = await goalPr(t)
      const v = goalVerdict(s.acs, pr)
      if (v === "done") goalDone(goalStates.set({ ...s, pr, status: "done" }))
      else if (v === "not-done") goalStates.set({ ...s, pr, status: "running", next: true })
    } else if (s.status === "running" && s.next && conversationIdle(t)) await startNextLoop(s)
  }
}
loop("goal-loops", "30 seconds", tickGoals)

/** The human answered a goal-loop decision. True when `a` was one. */
const goalAnswered = (a: Approval): boolean => {
  const s = goalStates.byApproval(a.id)
  if (!s) return false
  const answer = a.answer ?? ""
  const base = { ...s, approvalId: undefined }
  if (answer === STOP_GOAL) goalStates.set({ ...base, status: "stopped", next: false, reason: "stopped by the human" })
  else if (answer === OPEN_CHILD) {
    const parent = threads.get(s.threadId)
    const spec = goals.get(s.goalId)
    const id = childGoalId(s.goalId, (x) => !!goals.get(x))
    goals.save({
      id,
      title: `Factory fix for goal ${s.goalId}`,
      repo: repoRoot(FACTORY_DIR),
      base: "main",
      prompt: childGoalPrompt({ id: s.goalId, repo: spec?.repo ?? "" }, s.reason ?? "see the parent goal", s.threadId),
      limits: { usd: spec?.limits.usd ?? DEFAULT_RUN_USD },
    })
    goalStates.set({ ...base, status: "waiting-child", childGoalId: id, next: false })
    void startGoal(id, s.goalId).catch((e) => console.error(`child goal ${id}: ${e}`))
    if (parent)
      deliverAndLog(
        reportTarget(parent, threads.list(), deskThread().id),
        `[goal ${s.goalId}] waits for child goal ${id}, which fixes a factory defect.`,
      )
  } else {
    // Run another loop, loop again without a fix, resume after a child goal, or typed direction.
    const typed = ![RUN_AGAIN, LOOP_ANYWAY, RESUME].includes(answer)
    goalStates.set({
      ...base,
      status: "running",
      next: true,
      noProgress: 0,
      reason: undefined,
      ...(typed ? { note: answer.slice(0, 2000) } : {}),
    })
  }
  factory.publish("coordinator", "factory.thread_updated", null, now(), { threadId: s.threadId })
  return true
}

/** The human answered a cost-limit pause: stop the goal, or raise its limit and resume. True when `a` was one. */
const budgetAnswered = (a: Approval): boolean => {
  const goalId = goalBudgets.byApproval(a.id)
  if (!goalId) return false
  const b = budgetOf(goalId)
  const spent = goalSpent(goalId)
  const r = readAnswer(a.answer ?? "", spent)
  if (r.kind === "stop") goalBudgets.set(goalId, { ...b, status: "stopped", approvalId: undefined })
  // Ask again with the same choices; the goal stays paused.
  else if (r.kind === "invalid") openPause(goalId, b, spent, b.paused, r.why)
  else {
    goalBudgets.set(goalId, { limitUsd: r.limitUsd, status: "ok" })
    for (const p of b.paused ?? []) {
      const t = threads.get(p.threadId)
      if (!t?.worktree || t.cleanedAt) continue
      handoff(t, p.lost, b.pausedAt ?? Date.now(), {
        tag: "cost limit raised",
        text: `Goal ${goalId} reached its cost limit of $${b.limitUsd} (all its runs together) and this run was paused; the human raised the goal's limit to $${r.limitUsd}. Continue; keep the work focused on the criteria.`,
      })
    }
  }
  for (const t of goalRuns(goalId))
    factory.publish("coordinator", "factory.thread_updated", null, now(), { threadId: t.id })
  return true
}

// Repo conversations whose work the last shutdown stopped get one handoff turn (resume.ts), after the server is up.
const resumeInterrupted = async () => {
  const shutdownRec = factory.store.latest("factory.shutdown", 1)[0] as Shutdown | undefined
  const resumed = factory.store.latest("factory.resumed", 1)[0] as Resumed | undefined
  const scopes = interruptedScopes(shutdownRec, resumed)
  if (!shutdownRec || !scopes.size) return
  const done: string[] = []
  for (const [scopeId, lost] of scopes) {
    const t = threads.list().find((x) => subId(x.id) === scopeId)
    if (!t?.worktree || t.cleanedAt || t.archivedAt) continue
    // A run of a goal paused at its cost limit stays paused; the human's answer resumes it.
    if (goalBlocked(t.goalId)) continue
    handoff(t, lost, shutdownRec.at)
    done.push(scopeId)
  }
  factory.publish("coordinator", "factory.resumed", null, now(), { shutdownAt: shutdownRec.at, scopes: done })
  console.error(`resumed ${done.length} interrupted conversation(s): ${done.join(", ")}`)
}
void resumeInterrupted().catch((e) => console.error(`resume after restart failed: ${e}`))

const shutdown = async (signal: string) => {
  // Say who asked: a restart from process-compose, a human, or a stray group signal from a tool tree.
  console.error(`coordinator: ${signal} received (ppid ${process.ppid}); stopping`)
  const running = factory
    .summaries()
    .filter((w) => w.status === "running")
    .map((w) => ({ id: w.id, name: w.name, owner: w.owner, step: w.step, task: w.task }))
  factory.publish("coordinator", "factory.shutdown", null, now(), { at: Date.now(), running } satisfies Shutdown)
  await stopLoops()
  await factory.stopAll()
  process.exit(0)
}
// The desk is a fixed session the whole service uses: when its runtime dies, restart the service (process-compose
// restarts it). Other workers are unregistered by the factory and start again on their next message.
factory.onRuntimeExit = (ids) => {
  console.error(`runtime of ${ids.join(", ")} exited without a stop`)
  if (ids.includes(DESK_ID)) void shutdown("desk runtime exit")
}
process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
