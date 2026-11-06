// Tools the coordinator session uses to run the factory.
import { execFileSync } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import path from "node:path"
import { defineTool, type Tool } from "@github/copilot-sdk"
import { finishPermissions, MAX_FIX_ROUNDS, now, type Factory, type SpawnSpec, type Worker } from "./factory.ts"
import { SETTINGS_TOOL_DOC } from "./prompts.ts"
import type { ShipGrant } from "./approvals.ts"
import { parseReport, type Report, type ReportInput } from "./report.ts"
import { briefProblem } from "./reports.ts"
import { diffSummary, reportFindings } from "./cards.ts"
import { pendingReview, reviewIn, securityReview } from "./security.ts"
import { decideNext, SELECTABLE_STEPS, SkillPreflightError } from "./steps.ts"
import { FANOUT_CATALOG, MAX_FANOUT, routeFanout, type FanoutSelection } from "./workflows.ts"

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
})

const str = (args: any, key: string): string => {
  const v = args?.[key]
  if (typeof v !== "string") throw new Error(`missing \`${key}\``)
  return v
}

const json = (v: unknown) => JSON.stringify(v)

/** Which coordinator owns these tools: the global one, or a conversation's sub-coordinator in its worktree. */
export type Scope = {
  id: string
  threadId: string | null
  workdir?: string
  /** Commit the worktree branched from; the security review diffs against it. */ base?: string
  /** Default decision context, e.g. the repo folder name. */ label?: string
  /** Sends a sub-coordinator's report_up to the human. */ report?: (r: Report) => void | Promise<void>
  /** A conversation exists and is not cleaned up; checks request_approval's reportThreadId. */ knownThread?: (
    threadId: string,
  ) => boolean
}

export const coordinatorTools = (f: Factory, scope: Scope = { id: "coordinator", threadId: null }): Tool<any>[] => [
  spawnWorker(f, scope),
  fanoutTool(
    "fanout",
    `For a research, design-decision or find-optimizations request, ask Jev which workers fit, then start each selected worker (at most ${MAX_FANOUT}) in this conversation's worktree. Workers: ${FANOUT_CATALOG.map((e) => e.id).join(", ")}. Each saves reports/<step>.md. Takes the exact user request, not worker names. Read every returned worker with wait=true before spawning a synthesis worker.`,
    (request) => fanout(f, scope, request),
  ),
  defineTool("next_step", {
    description:
      "Ask Jev (a fast decision model) whether more work is useful and which SDLC step runs next. Call it at the start and after every step. Pass the user's request, a short progress summary, and the last step's output.",
    parameters: obj({ request: { type: "string" }, progress: { type: "string" }, lastOutput: { type: "string" } }, [
      "request",
      "progress",
      "lastOutput",
    ]),
    handler: async (a: any) => {
      const pending = pendingReview(f.securityReviews.values(), scope.id)
      if (pending)
        return json({
          step: "wait_security_review",
          securityReview: { id: pending.id, status: pending.status, workerId: pending.workerId ?? null },
          note: "The automatic security review of the last implement step is still running. Wait for its current worker with read_worker wait=true, then call next_step again.",
        })
      const state = { request: str(a, "request"), progress: str(a, "progress"), lastOutput: str(a, "lastOutput") }
      try {
        const d = await decideNext(state)
        if (scope.workdir) f.turn(scope.id).moreWork = d.moreWork
        const entry = { ...d, request: state.request.slice(0, 200), at: Date.now() }
        f.publish("coordinator", "factory.step_decided", null, String(Date.now()), entry)
        return json({ ...d, steps: SELECTABLE_STEPS.map(({ id, description }) => ({ id, description })) })
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e), steps: SELECTABLE_STEPS })
      }
    },
  }),
  decisionTool(f, scope, "request_approval"),
  decisionTool(f, scope, "ask_user"),
  defineTool("list_workers", {
    description: "List all workers with status, model, pid and last message.",
    parameters: obj({}),
    handler: () => json(f.summaries()),
  }),
  defineTool("message_worker", {
    description: "Send a follow-up prompt to a worker.",
    parameters: obj({ id: { type: "string" }, prompt: { type: "string" } }, ["id", "prompt"]),
    handler: async (a: any) => {
      await f.get(str(a, "id")).send(str(a, "prompt"))
      return json({ sent: true })
    },
  }),
  defineTool("read_worker", {
    description:
      "Read a worker's latest assistant message. With wait=true, wait (max timeout_s, default 300) until the worker is idle first.",
    parameters: obj({ id: { type: "string" }, wait: { type: "boolean" }, timeout_s: { type: "integer" } }, ["id"]),
    handler: async (a: any) => {
      const w = f.get(str(a, "id"))
      const idle = a.wait === true ? await w.waitIdle((a.timeout_s ?? 300) * 1000) : w.status !== "running"
      if (idle) w.collected = true
      const review = [...f.securityReviews.values()].find((r) => r.implementWorkerId === w.id)
      return json({
        id: w.id,
        status: w.status,
        idle,
        lastMessage: w.lastMessage,
        ...(review ? { securityReview: review.status } : w.onDone ? { securityReview: "after_idle" } : {}),
      })
    },
  }),
  defineTool("stop_worker", {
    description: "Stop a worker and terminate its runtime process.",
    parameters: obj({ id: { type: "string" } }, ["id"]),
    handler: async (a: any) => {
      await f.stop(str(a, "id"))
      return json({ stopped: true })
    },
  }),
  defineTool("show_worker_board", {
    description:
      "Show the human a live board of the worker fleet in the chat (counts, status, model, memory, context use). Use it instead of render_ui whenever the answer is the fleet's status. It takes no arguments and updates live.",
    parameters: obj({}),
    handler: () => json({ workers: f.summaries(), at: Date.now() }),
  }),
  defineTool("show_decisions", {
    description:
      "Show every decision waiting for the human (approvals and questions from all conversations) as one card the human can answer in place. Use it when the human asks what needs them or several decisions are open.",
    parameters: obj({}),
    handler: () => json({ pending: f.approvals.list().filter((a) => a.status === "pending").length }),
  }),
  defineTool("show_security_review", {
    description:
      "Show the security review of this conversation as a live card: status, each finding with severity and Jev's keep/discard verdict and reason, and the fix/verify progress. Use it when the human asks about security or when a review finishes, instead of listing findings in text.",
    parameters: obj({}),
    handler: () => {
      const all = [...f.securityReviews.values()]
      const mine = all.filter((r) => r.scopeId === scope.id || (scope.threadId !== null && r.threadId === scope.threadId))
      const r = (mine.length ? mine : all).at(-1)
      return json(r ? { reviewId: r.id, status: r.status, findings: r.findings.length } : { reviewId: null, note: "No security review yet." })
    },
  }),
  defineTool("show_delivery_run", {
    description:
      "Show the delivery run as a live card: branch, Jev's latest step decisions with confidence, and how much work is left (moreWork). Use it to answer 'where are we?' and after each next_step instead of a long text status.",
    parameters: obj({}),
    handler: () => {
      const wt = scope.workdir
      const branch = wt ? currentBranch(wt) : (f.run?.branch ?? null)
      return json({ branch, worktree: wt ?? f.run?.worktree ?? null, base: scope.base ?? f.run?.base ?? null, decisions: f.decisions.slice(-8) })
    },
  }),
  defineTool("show_diff_summary", {
    description:
      "Show the files changed in this conversation's worktree (against its base commit) as a card with +/- per file. Use it before asking for approval to ship, and when the human asks what changed.",
    parameters: obj({}),
    handler: () => {
      const wt = scope.workdir ?? f.run?.worktree
      const base = scope.base ?? f.run?.base
      if (!wt || !base) return json({ error: "No worktree or base commit in this conversation." })
      try {
        return json(diffSummary(wt, base))
      } catch (e) {
        return json({ error: `git diff failed: ${e instanceof Error ? e.message : String(e)}` })
      }
    },
  }),
  defineTool("show_report_findings", {
    description:
      "Show a saved report's ranked findings (## 1. Title sections) as a card with a 'Start in Factory' button per finding. `path` is the report path, e.g. reports/synthesis.md. Use it to present a synthesis or optimization report instead of pasting it.",
    parameters: obj({ path: { type: "string", description: "Report path, e.g. reports/synthesis.md" } }, ["path"]),
    handler: (a: any) => {
      const p = str(a, "path")
      const file = scope.workdir ? path.resolve(scope.workdir, p) : null
      if (!file || !file.startsWith(path.resolve(scope.workdir!) + path.sep)) return json({ path: p, findings: [], note: "The UI loads the report." })
      try {
        return json({ path: p, findings: reportFindings(readFileSync(file, "utf8")) })
      } catch {
        return json({ path: p, findings: [], error: "report not found" })
      }
    },
  }),
  defineTool("render_ui", {
    description:
      "Show generative UI inline in the chat. `program` is an OpenUI Lang program (see the OpenUI Lang section of your instructions).",
    parameters: obj({ title: { type: "string" }, program: { type: "string", description: "OpenUI Lang program." } }, [
      "program",
    ]),
    handler: () => json({ rendered: true }),
  }),
  defineTool("get_settings", {
    description: "Read the factory settings (the same document the UI edits) and the allowed values for each field.",
    parameters: obj({}),
    handler: async () => json(await f.settingsView()),
  }),
  defineTool("update_settings", {
    description: SETTINGS_TOOL_DOC,
    parameters: obj({ patch: { type: "object", description: "JSON merge patch over the settings document." } }, [
      "patch",
    ]),
    handler: async (a: any) => {
      try {
        return json({ applied: true, settings: await f.updateSettings(a.patch) })
      } catch (e) {
        return json({ applied: false, error: e instanceof Error ? e.message : String(e) })
      }
    },
  }),
  ...(scope.workdir ? [reportUp(f, scope, scope.workdir)] : []),
  defineTool("extension_errors", {
    description:
      "Runtime errors that UI extensions threw in the browsers (per extension and UI). Call this a few seconds after installing or changing an extension, and fix any error with update_settings.",
    parameters: obj({}),
    handler: async () => {
      await Bun.sleep(2000)
      return json([...f.extensionErrors.values()])
    },
  }),
]

/** One doctor per broken skill set at a time; concurrent spawns share it. */
const healing = new Map<string, Promise<string>>()

export const doctorTask = (e: SkillPreflightError, healRoot: string) =>
  [
    `A factory worker for step ${e.step} did not start. Its skill preflight failed:`,
    ...e.failures.map((f) => `- skill ${f.name}: ${f.problem}. Folder: ${f.dir ?? "not found"}.`),
    `Diagnose the cause. Make each skill usable by a model-invoked worker without editing its source: copy the skill folder to ${healRoot}/<skill name>/ and apply the smallest fix there. Keep the skill's name, purpose and instructions. If a skill cannot be fixed (for example it does not exist upstream), do not create a copy; say why.`,
    "Do not edit any repository. End with one line per skill: healed or not healed, and why.",
  ].join("\n")

/**
 * Spawn a worker; when its skill preflight fails, start one skill-doctor worker, wait for it, and retry once.
 * The doctor writes fixed copies under the factory's heal folder, which the preflight prefers.
 */
export const spawnHealing = async (
  f: Factory,
  scope: Scope,
  spec: SpawnSpec,
  waitMs = 10 * 60_000,
): Promise<Worker> => {
  try {
    return await f.spawn(spec)
  } catch (e) {
    if (!(e instanceof SkillPreflightError)) throw e
    const key = e.failures.map((x) => x.name).sort().join(",")
    f.publish(scope.id, "factory.skill_preflight_failed", null, now(), { step: e.step, worker: spec.name, error: e.message })
    if (!healing.has(key)) {
      const run = (async () => {
        const doctor = await f.spawn({
          name: `skill-doctor-${key.replaceAll(",", "-")}`.slice(0, 60),
          role: "worker",
          auth: spec.auth ?? "native",
          owner: scope.id,
          workdir: f.healRoot,
          task: doctorTask(e, f.healRoot),
        })
        await doctor.waitIdle(waitMs)
        return doctor.lastMessage ?? ""
      })().finally(() => healing.delete(key))
      healing.set(key, run)
    }
    const report = await healing.get(key)!
    try {
      const w = await f.spawn(spec)
      f.publish(scope.id, "factory.skill_healed", null, now(), { step: e.step, worker: w.id })
      return w
    } catch (again) {
      throw new Error(`${again instanceof Error ? again.message : String(again)} (skill-doctor: ${report.slice(0, 400)})`)
    }
  }
}

/** Why no worker may start: a security review is unfinished in the same worktree. */
const spawnBlocked = (f: Factory, scope: Scope): string | null => {
  const workdir = scope.workdir ?? f.run?.worktree
  const r = workdir ? reviewIn(f.securityReviews.values(), workdir) : undefined
  if (!r) return null
  const wait = r.workerId ? `wait for worker ${r.workerId} with read_worker wait=true` : "call next_step to wait for it"
  return `security review ${r.id} is ${r.status} in this worktree; ${wait}, then spawn again.`
}

const fanoutTool = (name: string, description: string, run: (request: string) => Promise<unknown>) =>
  defineTool(name, {
    description,
    parameters: obj({ request: { type: "string" } }, ["request"]),
    handler: async (a: unknown) => {
      try {
        if (
          typeof a !== "object" ||
          a === null ||
          !("request" in a) ||
          typeof a.request !== "string" ||
          !a.request.trim()
        )
          throw new Error(`${name} requires a nonempty request`)
        return json(await run(a.request))
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) })
      }
    },
  })

/** Start one worker per selected item in the conversation worktree; synthesis waits for all of them. */
export const fanout = async (
  f: Factory,
  scope: Scope,
  request: string,
  route: (request: string) => Promise<FanoutSelection> = routeFanout,
) => {
  if (!scope.workdir) throw new Error("Start a repo conversation first; research workers require its own worktree")
  const blocked = spawnBlocked(f, scope)
  if (blocked) throw new Error(blocked)
  const selection = await route(request)
  const decision = { ...selection, request, scopeId: scope.id, at: Date.now() }
  f.publish(scope.id, "factory.workflows_selected", null, now(), decision)
  const plans = selection.selected.map((id) => {
    const e = FANOUT_CATALOG.find((x) => x.id === id)!
    return { step: e.step, report: e.step, kind: e.kind, task: e.task(request) }
  })
  const results = await Promise.allSettled(
    plans.map(({ step, task }) =>
      spawnHealing(f, scope, {
        name: step,
        role: "worker",
        auth: f.workers.get(scope.id)?.auth ?? "native",
        step,
        owner: scope.id,
        workdir: scope.workdir,
        task,
      }),
    ),
  )
  f.researchBatches.set(scope.id, {
    workers: results.flatMap((r, i) =>
      r.status === "fulfilled" ? [{ id: r.value.id, workflow: plans[i]!.report }] : [],
    ),
    errors: results.flatMap((r) =>
      r.status === "rejected" ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : [],
    ),
  })
  return {
    ...selection,
    workers: results.flatMap((r) => (r.status === "fulfilled" ? [r.value.summary()] : [])),
    kinds: [...new Set(plans.map((p) => p.kind))],
    reports: plans.map(({ report }) => `reports/${report}.md`),
    errors: results.flatMap((r, i) =>
      r.status === "rejected"
        ? [{ workflow: selection.selected[i], error: r.reason instanceof Error ? r.reason.message : String(r.reason) }]
        : [],
    ),
    next: selection.selected.length
      ? "Collect every selected worker. On errors, report a blocked or partial run, not success. Only then spawn step=synthesis with all report paths and the exact user request."
      : "Nothing matched. Use next_step for an SDLC request, or answer directly. Do not run synthesis.",
  }
}

const researchWorkerBlocked = (
  f: Factory,
  workdir: string,
  { id, workflow }: { id: string; workflow: string },
): string | null => {
  const worker = f.workers.get(id)
  if (!worker || worker.status !== "idle" || !worker.collected) return `Collect completed worker ${id} before synthesis`
  try {
    const report = statSync(path.join(workdir, "reports", `${workflow}.md`))
    return report.isFile() && report.size > 0 ? null : `Missing or empty ${workflow} report`
  } catch (e) {
    return `Cannot read ${workflow} report: ${e instanceof Error ? e.message : String(e)}`
  }
}

export const synthesisBlocked = (f: Factory, scope: Scope): string | null => {
  const workdir = scope.workdir
  const batch = f.researchBatches.get(scope.id)
  if (!workdir) return "Start a repo conversation before synthesis"
  if (!batch) return "Run fanout before synthesis"
  if (batch.errors.length) return `Research launch failed: ${batch.errors.join("; ")}`
  if (!batch.workers.length) return "No research workflows were selected"
  return batch.workers.map((worker) => researchWorkerBlocked(f, workdir, worker)).find(Boolean) ?? null
}

/** The branch an accepted ship approval lets this conversation's finish worker push, or why there is none. */
export const shipGrant = (f: Factory, scope: Scope): ShipGrant | string => {
  if (!scope.workdir) return "step=finish runs only in a repo conversation"
  const branch = gitOr(scope.workdir, "--abbrev-ref", "HEAD")
  const accepted = f.approvals.acceptedShips(scope.id, branch)
  const open = accepted.find((g) => g.pushes <= MAX_FIX_ROUNDS)
  if (open) return open
  return accepted.length
    ? `Fix round limit reached for ${branch} (${MAX_FIX_ROUNDS} after the first push). report_up blocked, or ask for a new ship approval.`
    : `No accepted ship approval for branch ${branch}. Call request_approval with ship=true, end your turn, and spawn step=finish after the human picks the first option.`
}

/** Start a worker; every step waits while a security review is unfinished in the same worktree. */
const spawnWorker = (f: Factory, scope: Scope) =>
  defineTool("spawn_worker", {
    description: "Start a new isolated worker agent (separate Copilot runtime process) and give it a task.",
    parameters: obj(
      {
        name: { type: "string", description: "Short worker name, e.g. 'api-designer'." },
        task: { type: "string", description: "Self-contained task for the worker." },
        model: {
          type: "string",
          description: "Optional model id. Omit it to let copilot-proxy-rs Jev routing pick the model for the task.",
        },
        step: {
          type: "string",
          enum: SELECTABLE_STEPS.map((x) => x.id),
          description:
            "SDLC step this worker performs. 'implement' loads ub-mode and the crapper/dryer/mutator tools; a security review runs automatically when it finishes.",
        },
        harness: {
          type: "string",
          enum: ["copilot", "claude", "pi"],
          description:
            "Agent harness. Default copilot. Use claude only for skills or plugins built for Claude, pi only for skills built for Pi. A step that needs one sets it itself.",
        },
        profiles: {
          type: "array",
          items: { type: "string" },
          description: "trx profiles composed into a claude or pi worker (see `trx list`).",
        },
      },
      ["name", "task"],
    ),
    handler: async (a: any) => {
      const blocked = spawnBlocked(f, scope) ?? (a.step === "synthesis" ? synthesisBlocked(f, scope) : null)
      if (blocked) return json({ error: blocked })
      const ship = a.step === "finish" ? shipGrant(f, scope) : null
      if (typeof ship === "string") return json({ error: ship })
      const scopeAuth = f.workers.get(scope.id)?.auth
      const auth = scopeAuth ?? "native"
      const w = await spawnHealing(f, scope, {
        name: str(a, "name"),
        role: "worker",
        auth,
        ...(typeof a.model === "string" ? { model: a.model } : {}),
        task: str(a, "task"),
        ...(typeof a.step === "string" ? { step: a.step } : {}),
        ...(ship ? { permissions: finishPermissions(ship, (g) => f.approvals.setPushes(g)) } : {}),
        ...(!ship && (a.harness === "claude" || a.harness === "pi")
          ? { harness: { kind: a.harness, profiles: Array.isArray(a.profiles) ? a.profiles.map(String) : [] } }
          : {}),
        owner: scope.id,
        ...(scope.workdir ? { workdir: scope.workdir } : {}),
        // Review workers are spawned by securityReview directly, so a security fix never triggers another review.
        ...(a.step === "implement"
          ? { onDone: (w: { id: string }) => void securityReview(f, scope, w.id, scopeAuth) }
          : {}),
      })
      return json({ ...w.summary(), ...(scope.workdir ? { worktree: scope.workdir } : { run: f.run }) })
    },
  })

/** request_approval and ask_user: open a decision card for the human. */
const decisionTool = (f: Factory, scope: Scope, name: "request_approval" | "ask_user") => {
  // Only the global coordinator's approvals answer a report and relay the answer.
  const relays = name === "request_approval" && !scope.workdir
  // Only a sub-coordinator asks to ship its own branch.
  const ships = name === "request_approval" && !!scope.workdir
  return defineTool(name, {
    description:
      name === "request_approval"
        ? "Ask the human to approve before you continue (plans before implement, review findings before applying them). Every UI alerts the human at once with a decision card and a deep link. After calling it, end your turn with one short line. The answer comes back as an [approval ID answered] message. Never ask for approval with buttons or text alone."
        : "Ask the human a question you cannot answer from the code or docs (missing context, a choice between designs). Every UI alerts the human at once with a question card and a deep link. Give likely answers as options; the human may also type a free answer. After calling it, end your turn with one short line. The answer comes back as a [question ID answered] message.",
    parameters: obj(
      {
        title: { type: "string", description: "The decision or question in one short line." },
        summary: {
          type: "string",
          description:
            "Markdown the human reads before deciding: context in 1-3 bullets, the items to decide on, and what each option does next. Short.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description: "2-4 short choices; the first is your recommendation.",
        },
        optionDetails: {
          type: "array",
          items: { type: "string" },
          description: "Optional, one per option: what happens next if the human picks it, in under 12 words.",
        },
        context: { type: "string", description: "Who asks and about what, e.g. 'coordinator · review of b39040eb'." },
        ...(ships
          ? {
              ship: {
                type: "boolean",
                description:
                  "Ask to push this worktree's branch and open a PR. The first option means ship; when the human picks it, spawn_worker step=finish may push. Ask only after verify passed and the security review finished.",
              },
            }
          : {}),
        ...(relays
          ? {
              reportThreadId: {
                type: "string",
                description:
                  "On a [report from ...] turn: the reporting conversation's id. The answer then comes back with a reminder to relay it there.",
              },
            }
          : {}),
      },
      ["title", "summary", "options"],
    ),
    handler: (a: any) => {
      const reportThreadId = relays && typeof a.reportThreadId === "string" ? a.reportThreadId : undefined
      if (reportThreadId !== undefined && !scope.knownThread?.(reportThreadId))
        return json({
          error: `unknown or cleaned-up conversation ${JSON.stringify(reportThreadId)}; use an id from list_conversations`,
        })
      const shipBranch = ships && a.ship === true ? gitOr(scope.workdir!, "--abbrev-ref", "HEAD") : null
      if (shipBranch !== null && !shipBranch.startsWith("factory/"))
        return json({ error: `Only factory/* branches ship; this worktree is on ${shipBranch}` })
      const item = f.approvals.open({
        kind: name === "ask_user" ? "question" : "approval",
        threadId: scope.threadId ?? f.currentThread,
        title: str(a, "title"),
        summary: str(a, "summary"),
        options:
          Array.isArray(a.options) && a.options.length
            ? a.options.map(String)
            : name === "ask_user"
              ? []
              : ["Approve", "Reject"],
        context: typeof a.context === "string" ? a.context : (scope.label ?? "coordinator"),
        ...(Array.isArray(a.optionDetails) ? { optionDetails: a.optionDetails.map(String) } : {}),
        ...(reportThreadId !== undefined ? { reportThreadId } : {}),
      })
      if (shipBranch) f.approvals.addShip(item.id, scope.id, shipBranch)
      f.publish("coordinator", "factory.approval_requested", null, String(Date.now()), item)
      return json({ id: item.id, status: "pending", note: "Shown to the human. End your turn now." })
    },
  })
}

const list = { type: "array", items: { type: "string" } }

/** Sub-coordinator tool: report a finished or blocked delivery loop up to the human. */
const reportUp = (f: Factory, scope: Scope, workdir: string) =>
  defineTool("report_up", {
    description:
      "Report your delivery loop to the human through the global coordinator when it is done, blocked, or needs a decision. Call it once per outcome, then end your turn.",
    parameters: obj(
      {
        status: { type: "string", enum: ["done", "blocked", "needs-decision"] },
        summary: { type: "string", description: "What changed or what blocks you, in 1-3 sentences." },
        checks: {
          type: "array",
          items: obj({ name: { type: "string" }, result: { type: "string" }, evidence: { type: "string" } }, [
            "name",
            "result",
            "evidence",
          ]),
        },
        gaps: { ...list, description: "What is not done or not proven." },
        nextSteps: { ...list, description: "Options for the human; the first is your recommendation." },
      },
      ["status", "summary"],
    ),
    handler: async (a: any) => {
      let input: ReportInput
      try {
        input = parseReport(a)
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) })
      }
      const brief = input.status === "done" ? briefProblem(workdir) : null
      if (brief) return json({ error: `Not sent: ${brief}. Fix the brief (or spawn a synthesis worker to fix it), then call report_up again.` })
      const r: Report = { ...input, branch: gitOr(workdir, "--abbrev-ref", "HEAD"), commit: gitOr(workdir, "HEAD") }
      const turn = f.turn(scope.id)
      const key = `${turn.start}|${r.commit}|${r.status}`
      if (f.lastReports.get(scope.id) === key)
        return json({
          sent: false,
          note: "This report was already sent this turn for this commit and status. End your turn.",
        })
      try {
        await scope.report?.(r)
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) })
      }
      turn.reported = true
      f.lastReports.set(scope.id, key)
      f.publish(scope.id, "factory.report_up", null, now(), { threadId: scope.threadId, report: r })
      return json({ sent: true, note: "The human decides the next step. End your turn now." })
    },
  })

/** `git rev-parse` in the worktree, or "unknown" when git fails. */
const gitOr = (workdir: string, ...args: string[]): string => {
  try {
    return execFileSync("git", ["-C", workdir, "rev-parse", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return "unknown"
  }
}

/** The sub-coordinator task optimize_repo sends: fan out, then fan in. */
export const optimizeRepoTask = (request: string) =>
  `Optimize: ${request.replace(/\s+/g, " ").trim()}\n\nUser request (exact): ${JSON.stringify(request)}\n\nCall fanout with this exact request. Do not analyze the repo yourself. Collect every worker, spawn step=synthesis with all report paths, and report_up with the ranked result and reports/synthesis.md.`

/** What the global coordinator can do with conversations; main.ts implements it. */
export type Conversations = {
  list: () => unknown
  folders: () => unknown
  start: (folder: string, task: string) => Promise<unknown>
  message: (threadId: string, text: string) => Promise<void>
  read: (threadId: string, wait: boolean) => Promise<unknown>
  /** Compact live snapshot of every conversation, worker and pending decision. */
  status: () => unknown
}

/** Tools only the global coordinator gets: manage repo conversations and their sub-coordinators. */
export const globalTools = (c: Conversations): Tool<any>[] => [
  defineTool("factory_status", {
    description:
      "The whole factory right now, as live state: every repo conversation (status running|idle|error|stopped|merged, branch, workers, last message, pending decisions), every General chat, and what needs attention. Call it before you answer about other conversations or decide to wait; it is fresh every time, unlike your memory.",
    parameters: obj({}),
    handler: () => json(c.status()),
  }),
  defineTool("list_conversations", {
    description:
      "List folders and every conversation with its folder, worktree, sub-coordinator status, and pending decision count.",
    parameters: obj({}),
    handler: () => json({ folders: c.folders(), conversations: c.list() }),
  }),
  defineTool("start_conversation", {
    description:
      "Open a new conversation in a repo folder and give its sub-coordinator a task. It gets its own git worktree and branch.",
    parameters: obj(
      {
        folder: {
          type: "string",
          description:
            "Folder id from list_conversations, or an absolute path inside a git repo (adds the repo as a folder).",
        },
        task: { type: "string", description: "Self-contained task for the sub-coordinator." },
      },
      ["folder", "task"],
    ),
    handler: async (a: any) => json(await c.start(str(a, "folder"), str(a, "task"))),
  }),
  defineTool("optimize_repo", {
    description:
      "Find and rank optimizations in a repo. Always starts a NEW conversation in that folder whose sub-coordinator fans out the `trx guide --optimize` skills (fanout) and fans in with a synthesis. Use it for every optimization request, even one asked before; never answer from an earlier conversation.",
    parameters: obj(
      {
        folder: { type: "string", description: "Folder id from list_conversations, or an absolute repo path." },
        request: { type: "string", description: "The user's exact request." },
      },
      ["folder", "request"],
    ),
    handler: async (a: any) => json(await c.start(str(a, "folder"), optimizeRepoTask(str(a, "request")))),
  }),
  defineTool("message_conversation", {
    description:
      "Send instructions to a conversation's sub-coordinator. It is saved in that conversation, so the human sees it.",
    parameters: obj({ threadId: { type: "string" }, text: { type: "string" } }, ["threadId", "text"]),
    handler: async (a: any) => {
      await c.message(str(a, "threadId"), str(a, "text"))
      return json({ sent: true })
    },
  }),
  defineTool("read_conversation", {
    description:
      "Read a conversation's sub-coordinator status and last message. wait=true waits (max 5 min) until it is idle.",
    parameters: obj({ threadId: { type: "string" }, wait: { type: "boolean" } }, ["threadId"]),
    handler: async (a: any) => json(await c.read(str(a, "threadId"), a.wait === true)),
  }),
]

/** The checked-out branch of a worktree, or null when git cannot tell. */
const currentBranch = (wt: string): string | null => {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: wt, encoding: "utf8" }).trim() || null
  } catch {
    return null
  }
}
