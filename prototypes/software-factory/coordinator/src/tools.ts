// Tools the coordinator session uses to run the factory.
import { execFileSync } from "node:child_process"
import { readFileSync, statSync, existsSync } from "node:fs"
import path from "node:path"
import { defineTool, type Tool } from "@github/copilot-sdk"
import { finishPermissions, maxFixRounds, now, type Factory, type SpawnSpec, type Worker } from "./factory.ts"
import { SETTINGS_TOOL_DOC } from "./prompts.ts"
import { configStore, factoryConfig, pinnedConfig, type Scalar } from "./config.ts"
import {
  APPLY,
  REJECT,
  checkProposal,
  describe as describeProposal,
  saveProposal,
  type Proposal,
} from "./configChanges.ts"
import { promptErrors, promptFile, promptNames, stalePrompts } from "./prompt.ts"
import { evaluatePrompt } from "./promptEval.ts"
import type { ShipGrant } from "./approvals.ts"
import { parseReport, type Report, type ReportInput } from "./report.ts"
import { briefProblem } from "./reports.ts"
import { diffSummary, reportFindings } from "./cards.ts"
import { pendingReview, reviewIn } from "./security.ts"
import { codeReviewIn, pendingCodeReview } from "./review.ts"
import { evaluationIn, evaluationMarkdown, lastEvaluation, pendingEvaluation } from "./evaluate.ts"
import {
  afterImplement,
  afterVerify,
  inRun,
  countWorker,
  planApprovalCheck,
  planSdlc,
  sdlcBusy,
  sdlcShipBlockers,
  sdlcTask,
  startEvaluation,
  startFinalSecurity,
} from "./gates.ts"
import { addLessons, artifact, prBody, unprovenCriteria } from "./sdlc.ts"
import { decideNext, selectableSteps, SkillPreflightError } from "./steps.ts"
import { fanoutCatalog, routeFanout, type FanoutSelection } from "./workflows.ts"

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
})

type Args = Record<string, unknown>

const str = (args: Args | null | undefined, key: string): string => {
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
  /** Repo folder id; its lessons file is read at start and appended by report_up. */ folderId?: string
  /** Sends a sub-coordinator's report_up to the human. */ report?: (r: Report) => void | Promise<void>
  /** A conversation exists and is not cleaned up; checks request_approval's reportThreadId. */ knownThread?: (
    threadId: string,
  ) => boolean
}

export const coordinatorTools = (f: Factory, scope: Scope = { id: "coordinator", threadId: null }): Tool<Args>[] => [
  spawnWorker(f, scope),
  fanoutTool(
    "fanout",
    `For a research, design-decision or find-optimizations request, ask Jev which workers fit, then start each selected worker (at most ${factoryConfig().fanout.max_workers}) in this conversation's worktree. Workers: ${fanoutCatalog()
      .map((e) => e.id)
      .join(
        ", ",
      )}. Each saves reports/<step>.md. Takes the exact user request, not worker names. Read every returned worker with wait=true before spawning a synthesis worker.`,
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
    handler: async (a: Args) => {
      const pending = pendingReview(f.securityReviews.values(), scope.id)
      if (pending)
        return json({
          step: "wait_security_review",
          securityReview: { id: pending.id, status: pending.status, workerId: pending.workerId ?? null },
          note: "The automatic security review of the last implement step is still running. Wait for its current worker with read_worker wait=true, then call next_step again.",
        })
      if (f.sdlc.get(scope.id)?.contractState?.status === "running")
        return json({
          step: "wait_contract",
          note: "The independent evaluator is agreeing a check per acceptance criterion. Call next_step again in a moment; then ask for the plan approval.",
        })
      const ev = pendingEvaluation(f.evaluations.values(), scope.id)
      if (ev)
        return json({
          step: "wait_evaluation",
          evaluation: { id: ev.id, status: ev.status, round: ev.round, workerId: ev.workerId ?? null },
          note: "The independent evaluator is checking the acceptance criteria (and fixing failed ones). Wait for its current worker with read_worker wait=true, then call next_step again.",
        })
      const cr = pendingCodeReview(f.codeReviews.values(), scope.id)
      if (cr)
        return json({
          step: "wait_code_review",
          codeReview: { id: cr.id, status: cr.status, lenses: cr.lenses, workerId: cr.workerId ?? null },
          note: "The code review gate is running (Jev-picked lenses, synthesis, Jev-scored fixes). Wait for its current worker with read_worker wait=true, then call next_step again.",
        })
      const busy = sdlcBusy(f, scope.id)
      if (busy) return json({ step: "wait_gates", note: `${busy}. Call next_step again in a moment.` })
      const state = { request: str(a, "request"), progress: str(a, "progress"), lastOutput: str(a, "lastOutput") }
      try {
        const d = await inRun(f, f.sdlc.get(scope.id), () => decideNext(state))
        if (scope.workdir) f.turn(scope.id).moreWork = d.moreWork
        // Tagged with the deciding coordinator, so each conversation's delivery card shows only its own steps.
        const entry = {
          ...d,
          request: state.request.slice(0, 200),
          at: Date.now(),
          scopeId: scope.id,
          threadId: scope.threadId,
        }
        f.publish("coordinator", "factory.step_decided", null, String(Date.now()), entry)
        return json({ ...d, steps: selectableSteps().map(({ id, description }) => ({ id, description })) })
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e), steps: selectableSteps() })
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
    handler: async (a: Args) => {
      await f.get(str(a, "id")).send(str(a, "prompt"))
      return json({ sent: true })
    },
  }),
  defineTool("read_worker", {
    description:
      "Read a worker's latest assistant message. With wait=true, wait (max timeout_s, default 300) until the worker is idle first.",
    parameters: obj({ id: { type: "string" }, wait: { type: "boolean" }, timeout_s: { type: "integer" } }, ["id"]),
    handler: async (a: Args) => {
      const w = f.get(str(a, "id"))
      const idle =
        a.wait === true ? await w.waitIdle(((a.timeout_s as number | undefined) ?? 300) * 1000) : w.status !== "running"
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
    handler: async (a: Args) => {
      await f.stop(str(a, "id"))
      return json({ stopped: true })
    },
  }),
  defineTool("show_worker_board", {
    description:
      "Show the human a live board of the worker fleet in the chat (counts, status, model, memory, context use). Use it instead of render_ui whenever the answer is the fleet's status. It takes no arguments and updates live.",
    parameters: obj({}),
    handler: (a: Args) => json(cardData(f, scope, "show_worker_board", a ?? {})),
  }),
  defineTool("show_decisions", {
    description:
      "Show every decision waiting for the human (approvals and questions from all conversations) as one card the human can answer in place. Use it when the human asks what needs them or several decisions are open.",
    parameters: obj({}),
    handler: (a: Args) => json(cardData(f, scope, "show_decisions", a ?? {})),
  }),
  defineTool("show_security_review", {
    description:
      "Show the security review of this conversation as a live card: status, each finding with severity and Jev's keep/discard verdict and reason, and the fix/verify progress. Use it when the human asks about security or when a review finishes, instead of listing findings in text.",
    parameters: obj({}),
    handler: (a: Args) => json(cardData(f, scope, "show_security_review", a ?? {})),
  }),
  defineTool("show_code_review", {
    description:
      "Show this conversation's latest code review as a live card: the Jev-picked reviewer lenses, every synthesized finding with severity, Jev's real/worth scores, and whether it was kept (fixed) or dropped. Use it when a code review finishes and when the human asks about the review.",
    parameters: obj({}),
    handler: (a: Args) => json(cardData(f, scope, "show_code_review", a ?? {})),
  }),
  defineTool("show_sdlc", {
    description:
      "Show this conversation's SDLC gates as a live card: risk tier, each gate (floor or Jev probability vs threshold, status), criteria proven, review findings kept, and what still blocks shipping. Use it after sdlc_plan, after implement, and before asking to ship.",
    parameters: obj({}),
    handler: (a: Args) => json(cardData(f, scope, "show_sdlc", a ?? {})),
  }),
  defineTool("show_delivery_run", {
    description:
      "Show this conversation's delivery run as a live card: branch, Jev's step decisions with confidence, and how much work is left (moreWork). Only in a conversation that runs the delivery loop (next_step); in a General chat use factory_status instead.",
    parameters: obj({}),
    handler: (a: Args) => json(cardData(f, scope, "show_delivery_run", a ?? {})),
  }),
  defineTool("show_diff_summary", {
    description:
      "Show the files changed in this conversation's worktree (against its base commit) as a card with +/- per file. Use it before asking for approval to ship, and when the human asks what changed.",
    parameters: obj({}),
    handler: (a: Args) => json(cardData(f, scope, "show_diff_summary", a ?? {})),
  }),
  defineTool("show_report_findings", {
    description:
      "Show a saved report's ranked findings (## 1. Title sections) as a card with a 'Start in Factory' button per finding. `path` is the report path, e.g. reports/synthesis.md. Use it to present a synthesis or optimization report instead of pasting it.",
    parameters: obj({ path: { type: "string", description: "Report path, e.g. reports/synthesis.md" } }, ["path"]),
    handler: (a: Args) => json(cardData(f, scope, "show_report_findings", a ?? {})),
  }),
  defineTool("render_ui", {
    description:
      "Show generative UI inline in the chat. `program` is an OpenUI Lang program (see the OpenUI Lang section of your instructions).",
    parameters: obj({ title: { type: "string" }, program: { type: "string", description: "OpenUI Lang program." } }, [
      "program",
    ]),
    handler: () => json({ rendered: true }),
  }),
  ...browserTools(f, scope),
  ...configTools(f, scope),
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
    handler: async (a: Args) => {
      try {
        return json({ applied: true, settings: await f.updateSettings(a.patch) })
      } catch (e) {
        return json({ applied: false, error: e instanceof Error ? e.message : String(e) })
      }
    },
  }),
  ...(scope.workdir ? [reportUp(f, scope, scope.workdir), sdlcPlanTool(f, scope), sdlcStatusTool(f, scope)] : []),
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

/** sdlc_plan: acceptance criteria plus Jev's plan-phase gates (design note, tests first). */
const sdlcPlanTool = (f: Factory, scope: Scope) =>
  defineTool("sdlc_plan", {
    description:
      "Call once before the plan approval (and again if the plan changes). Saves numbered, testable acceptance criteria to .factory/acceptance.md, reads the repo's CI checks, and asks Jev which plan-phase gates this change needs (design note, tests first). Returns the gates and the checks verify will run.",
    parameters: obj(
      {
        request: { type: "string", description: "The user's request, verbatim." },
        plan: { type: "string", description: "The plan in a few bullets." },
        criteria: {
          ...list,
          description:
            "2-8 testable acceptance criteria, each one observable with a command (e.g. 'GET /health on 18080 returns 200').",
        },
      },
      ["request", "plan", "criteria"],
    ),
    handler: async (a: Args) => {
      const criteria = Array.isArray(a.criteria) ? a.criteria.map(String).filter((c: string) => c.trim()) : []
      if (!criteria.length) return json({ error: "criteria must have at least one item" })
      const s = await planSdlc(f, scope, str(a, "request"), criteria, str(a, "plan"))
      return json({
        criteria: s.criteria.map((c, i) => `AC-${i + 1}: ${c}`),
        ...(s.contractState?.status === "running"
          ? {
              contract:
                "The independent evaluator is agreeing a check per criterion in the background (.factory/contract.md). The plan approval waits for it; meanwhile you may spawn step=plan for a design note.",
            }
          : {}),
        checks: s.checks,
        gates: s.gates,
        next: [
          s.gates.find((g) => g.id === "design")?.chosen
            ? "Design gate on: spawn step=plan to write .factory/design.md (decision, alternatives, rollback) before implement."
            : null,
          "Put the criteria in the plan approval summary (request_approval topic=plan).",
          "Implement and verify tasks get the criteria and gate rules appended by the factory.",
        ].filter(Boolean),
      })
    },
  })

/** sdlc_status: tier, gates, what still blocks shipping, and the PR body to use. */
const sdlcStatusTool = (f: Factory, scope: Scope) =>
  defineTool("sdlc_status", {
    description:
      "The conversation's SDLC state: risk tier, each gate (chosen by Jev or a floor, with probability and status), and what still blocks shipping. With summary set, also writes .factory/pr.md (criteria with checks, tier, gates, evidence, rollback) for the finish worker's `gh pr create --body-file`.",
    parameters: obj({
      summary: { type: "string", description: "Optional PR summary in 1-3 sentences; writes .factory/pr.md." },
    }),
    handler: async (a: Args) => {
      const s = f.sdlc.get(scope.id)
      const blockers = sdlcShipBlockers(f, scope)
      let prFile: string | null = null
      if (s && typeof a.summary === "string" && a.summary.trim() && scope.workdir) {
        prFile = `${scope.workdir}/.factory/pr.md`
        const ev = lastEvaluation(f.evaluations.values(), scope.id)
        await Bun.write(
          prFile,
          prBody(s, scope.workdir, a.summary, ev && ev.verdicts.length ? evaluationMarkdown(ev) : undefined),
        )
      }
      return json({
        tier: s?.risk ?? null,
        gates: s?.gates ?? [],
        criteria: s?.criteria ?? [],
        scopeWarning: s?.scopeWarning ?? null,
        blockers,
        readyToShip: blockers.length === 0,
        ...(prFile ? { prBody: prFile } : {}),
      })
    },
  })

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
    const key = e.failures
      .map((x) => x.name)
      .sort()
      .join(",")
    f.publish(scope.id, "factory.skill_preflight_failed", null, now(), {
      step: e.step,
      worker: spec.name,
      error: e.message,
    })
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
      throw new Error(
        `${again instanceof Error ? again.message : String(again)} (skill-doctor: ${report.slice(0, 400)})`,
        { cause: again },
      )
    }
  }
}

/** Why no worker may start: a security review is unfinished in the same worktree. */
const spawnBlocked = (f: Factory, scope: Scope): string | null => {
  const workdir = scope.workdir ?? f.run?.worktree
  const r = workdir
    ? (reviewIn(f.securityReviews.values(), workdir) ??
      codeReviewIn(f.codeReviews.values(), workdir) ??
      evaluationIn(f.evaluations.values(), workdir))
    : undefined
  if (!r) return null
  const wait = r.workerId ? `wait for worker ${r.workerId} with read_worker wait=true` : "call next_step to wait for it"
  const what = r.id.startsWith("cr-")
    ? "code review"
    : r.id.startsWith("ev-")
      ? "independent evaluation"
      : "security review"
  return `${what} ${r.id} is ${r.status} in this worktree; ${wait}, then spawn again.`
}

const fanoutTool = (name: string, description: string, run: (request: string) => Promise<unknown>) =>
  defineTool<Args>(name, {
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
    const e = fanoutCatalog().find((x) => x.id === id)!
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

/** Fix-round limit of the conversation's delivery run (its pinned config). */
const runFixRounds = (f: Factory, scope: Scope) => maxFixRounds(pinnedConfig(f.root, f.sdlc.get(scope.id)?.configId))

/** The branch an accepted ship approval lets this conversation's finish worker push, or why there is none. */
export const shipGrant = (f: Factory, scope: Scope): ShipGrant | string => {
  if (!scope.workdir) return "step=finish runs only in a repo conversation"
  const branch = gitOr(scope.workdir, "--abbrev-ref", "HEAD")
  const accepted = f.approvals.acceptedShips(scope.id, branch)
  const limit = runFixRounds(f, scope)
  const open = accepted.find((g) => g.pushes <= limit)
  if (open) return open
  return accepted.length
    ? `Fix round limit reached for ${branch} (${limit} after the first push). report_up blocked, or ask for a new ship approval.`
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
          enum: selectableSteps().map((x) => x.id),
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
    handler: async (a: Args) => {
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
        task: sdlcTask(f, scope, a.step as string | undefined, str(a, "task")),
        ...(typeof a.step === "string" ? { step: a.step } : {}),
        ...(ship
          ? {
              permissions: finishPermissions(
                ship,
                (g) => f.approvals.setPushes(g),
                runFixRounds(f, scope),
                () => f.settings.workers.forceWithLease,
              ),
            }
          : {}),
        ...(!ship && (a.harness === "claude" || a.harness === "pi")
          ? { harness: { kind: a.harness, profiles: Array.isArray(a.profiles) ? a.profiles.map(String) : [] } }
          : {}),
        owner: scope.id,
        ...(scope.workdir ? { workdir: scope.workdir } : {}),
        // Review workers are spawned by the reviews directly, so a review fix never triggers another review.
        ...(a.step === "implement"
          ? { onDone: (done: { id: string }) => void afterImplement(f, scope, done.id, scopeAuth) }
          : a.step === "verify"
            ? { onDone: () => void afterVerify(f, scope) }
            : {}),
      })
      countWorker(f, scope.id)
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
        topic: {
          type: "string",
          enum: ["plan", "findings", "other"],
          description:
            "plan: approve a plan before implement. findings: apply review findings. other: anything else. A ship request is always topic ship.",
        },
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
    handler: (a: Args) => {
      const reportThreadId = relays && typeof a.reportThreadId === "string" ? a.reportThreadId : undefined
      if (reportThreadId !== undefined && !scope.knownThread?.(reportThreadId))
        return json({
          error: `unknown or cleaned-up conversation ${JSON.stringify(reportThreadId)}; use an id from list_conversations`,
        })
      const shipBranch = ships && a.ship === true ? gitOr(scope.workdir!, "--abbrev-ref", "HEAD") : null
      if (shipBranch !== null && !shipBranch.startsWith("factory/"))
        return json({ error: `Only factory/* branches ship; this worktree is on ${shipBranch}` })
      // A plan approval waits for the contract and names the criteria the evaluator could not test.
      const plan = ships && a.topic === "plan" && !shipBranch ? planApprovalCheck(f, scope.id) : null
      if (plan?.wait) return json({ error: `Not ready for the plan approval: ${plan.wait}` })
      // The independent evaluation runs before the final security review, so security sees the evaluator's fixes.
      const evaluation = shipBranch !== null ? startEvaluation(f, scope) : null
      if (evaluation) return json({ error: `Not ready to ship yet: ${evaluation}` })
      const security = shipBranch !== null ? startFinalSecurity(f, scope) : null
      if (security) return json({ error: `Not ready to ship yet: ${security}` })
      const blockers = shipBranch !== null ? sdlcShipBlockers(f, scope) : []
      if (blockers.length)
        return json({
          error: `Not ready to ship:\n- ${blockers.join("\n- ")}\nFix these (sdlc_status shows the gates), then ask again.`,
        })
      const item = f.approvals.open({
        kind: name === "ask_user" ? "question" : "approval",
        threadId: scope.threadId ?? f.currentThread,
        title: str(a, "title"),
        summary: plan?.notes.length
          ? `${str(a, "summary")}\n\n**Untestable criteria (independent evaluator):**\n- ${plan.notes.join("\n- ")}`
          : str(a, "summary"),
        options:
          Array.isArray(a.options) && a.options.length
            ? a.options.map(String)
            : name === "ask_user"
              ? []
              : ["Approve", "Reject"],
        context: typeof a.context === "string" ? a.context : (scope.label ?? "coordinator"),
        ...(Array.isArray(a.optionDetails) ? { optionDetails: a.optionDetails.map(String) } : {}),
        ...(reportThreadId !== undefined ? { reportThreadId } : {}),
        topic: shipBranch ? "ship" : a.topic === "plan" || a.topic === "findings" ? a.topic : "other",
      })
      if (shipBranch) f.approvals.addShip(item.id, scope.id, shipBranch)
      f.publish("coordinator", "factory.approval_requested", null, String(Date.now()), item)
      return json({ id: item.id, status: "pending", note: "Shown to the human. End your turn now." })
    },
  })
}

/** Read the factory config; propose a change to it or to a prompt. Only the human's answer applies a proposal. */
const configTools = (f: Factory, scope: Scope): Tool<Args>[] => [
  defineTool("get_factory_config", {
    description:
      "Read the factory config: every key with its value, source (default, file, override) and reload rule (live: next use; run: a delivery run keeps the value it started with), the prompt names, and load errors.",
    parameters: obj({}),
    handler: async () => json(factoryConfigView()),
  }),
  defineTool("propose_config_change", {
    description:
      "Propose a change to one factory config key (key + value) or to one prompt's full text (prompt + text). You cannot apply it: it opens a decision, and only the human's Apply writes it. Use it when the human asks to change factory behavior, thresholds, models or prompt wording. Keep every {{placeholder}} the prompt uses. End your turn after calling it.",
    parameters: obj(
      {
        key: { type: "string", description: "Config key from get_factory_config, e.g. review.lens_threshold." },
        value: {
          description: "New value, same type as the current one (number, string, boolean, or list of strings).",
        },
        prompt: { type: "string", description: "Prompt name from get_factory_config, e.g. jev/lens." },
        text: { type: "string", description: "The prompt's complete new text." },
        reason: { type: "string", description: "Why, in one or two sentences, for the human." },
      },
      ["reason"],
    ),
    handler: async (a: Args) => {
      try {
        const reason = str(a, "reason")
        const p: Proposal =
          typeof a.prompt === "string"
            ? { kind: "prompt", name: a.prompt, text: str(a, "text"), reason }
            : { kind: "config", key: str(a, "key"), value: a.value as Scalar, reason }
        checkProposal(p)
        // Prompt proposals: replay recorded decisions with the current and the new text (bounded; never blocks).
        const evaluation =
          p.kind === "prompt"
            ? await evaluatePrompt(f.root, f.approvals.list(), p.name, promptFile(p.name).body, p.text)
            : undefined
        const item = f.approvals.open({
          kind: "approval",
          threadId: scope.threadId ?? f.currentThread,
          ...describeProposal(p, evaluation),
          options: [APPLY, REJECT],
          optionDetails: ["Write the change now", "Keep the current value"],
          context: scope.label ?? "coordinator",
          topic: "other",
        })
        saveProposal(f.root, item.id, p)
        f.publish("coordinator", "factory.approval_requested", null, String(Date.now()), item)
        return json({ id: item.id, status: "pending", note: "Shown to the human. End your turn now." })
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) })
      }
    },
  }),
]

/** Config values, prompt names and errors: what the UI and get_factory_config show. */
export const factoryConfigView = () => {
  const store = configStore()
  return {
    path: store.user,
    error: store.error,
    values: store.values(),
    prompts: promptNames(),
    promptErrors: Object.fromEntries(promptErrors),
    /** Your prompt copies made from an older shipped version: compare them with the new default. */
    stalePrompts: stalePrompts(),
  }
}

/**
 * Point the human at things in the UI. Each tool publishes a feed event every open UI applies, so it works with any
 * frontend (or none: the call still succeeds). They do not wait for the human.
 */
const browserTools = (f: Factory, scope: Scope): Tool<Args>[] => [
  defineTool("focus_agent", {
    description:
      "Show one agent (coordinator or worker id) in the human's Inbox. Use it when you point the human at a worker.",
    parameters: obj({ id: { type: "string", description: "Agent id, e.g. w-1a2b3c4d or coordinator." } }, ["id"]),
    handler: async (a: Args) => {
      const id = str(a, "id")
      if (!f.workers.has(id)) return json({ error: `unknown agent ${id}; use an id from list_workers` })
      await f.updateSettings({ focus: id })
      return json({ shown: id })
    },
  }),
  defineTool("open_report", {
    description:
      "Open a saved report (e.g. reports/synthesis.md) in the human's report viewer. A relative path is read in this conversation's worktree.",
    parameters: obj({ path: { type: "string", description: "reports/<name>.md, or an absolute path ending in .md" } }, [
      "path",
    ]),
    handler: (a: Args) => {
      const p = str(a, "path")
      if (!/^(?:\/[^\s`'"]+\/)?reports\/[\w.-]+\.mdx?$/.test(p))
        return json({ error: "path must look like reports/<name>.md" })
      f.publish(scope.id, "factory.ui_open_report", null, now(), { path: p, agent: scope.id, threadId: scope.threadId })
      return json({ opened: p })
    },
  }),
  defineTool("confirm_action", {
    description:
      "Ask the human for a quick yes/no before a destructive step they did not ask for in this turn (stopping several workers, abandoning a branch). Shown as a decision card with Confirm and Cancel. End your turn after calling it; the answer comes back as an [approval ID answered] message: Confirm means go on, Cancel means do not.",
    parameters: obj(
      {
        title: { type: "string", description: "The step, in one short line." },
        detail: { type: "string", description: "What it does and what cannot be undone." },
        confirmLabel: { type: "string", description: "Label of the yes option. Default Confirm." },
      },
      ["title"],
    ),
    handler: (a: Args) => {
      const confirm = typeof a.confirmLabel === "string" && a.confirmLabel.trim() ? a.confirmLabel.trim() : "Confirm"
      const item = f.approvals.open({
        kind: "approval",
        threadId: scope.threadId ?? f.currentThread,
        title: str(a, "title"),
        summary: typeof a.detail === "string" ? a.detail : "",
        options: [confirm, "Cancel"],
        context: scope.label ?? "coordinator",
        topic: "other",
      })
      f.publish("coordinator", "factory.approval_requested", null, now(), item)
      return json({ id: item.id, status: "pending", note: "Shown to the human. End your turn now." })
    },
  }),
]

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
        lessons: {
          ...list,
          description:
            "0-3 short lessons about this repo for the next conversation (a check that failed in CI, a tool quirk, a convention). Saved per repo.",
        },
        factoryDefect: {
          type: "string",
          description:
            "Only when a defect in the software factory itself (its tools, gates, workers or prompts; not this repo) stops your work: what it is and how you saw it. A goal then asks the human to open a goal that fixes the factory.",
        },
      },
      ["status", "summary"],
    ),
    handler: async (a: Args) => {
      let input: ReportInput
      try {
        input = parseReport(a)
      } catch (e) {
        return json({ error: e instanceof Error ? e.message : String(e) })
      }
      const brief = input.status === "done" ? briefProblem(workdir) : null
      if (brief)
        return json({
          error: `Not sent: ${brief}. Fix the brief (or spawn a synthesis worker to fix it), then call report_up again.`,
        })
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
      if (scope.folderId && Array.isArray(a.lessons) && a.lessons.length)
        addLessons(f.root, scope.folderId, a.lessons.map(String).slice(0, 3))
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
export const globalTools = (c: Conversations): Tool<Args>[] => [
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
    handler: async (a: Args) => json(await c.start(str(a, "folder"), str(a, "task"))),
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
    handler: async (a: Args) => json(await c.start(str(a, "folder"), optimizeRepoTask(str(a, "request")))),
  }),
  defineTool("message_conversation", {
    description:
      "Send instructions to a conversation's sub-coordinator. It is saved in that conversation, so the human sees it.",
    parameters: obj({ threadId: { type: "string" }, text: { type: "string" } }, ["threadId", "text"]),
    handler: async (a: Args) => {
      await c.message(str(a, "threadId"), str(a, "text"))
      return json({ sent: true })
    },
  }),
  defineTool("read_conversation", {
    description:
      "Read a conversation's sub-coordinator status and last message. wait=true waits (max 5 min) until it is idle.",
    parameters: obj({ threadId: { type: "string" }, wait: { type: "boolean" } }, ["threadId"]),
    handler: async (a: Args) => json(await c.read(str(a, "threadId"), a.wait === true)),
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

/** Jev decisions made by one coordinator. Untagged (older) decisions belong to the Factory desk ("coordinator"). */
export const ownDecisions = (all: readonly unknown[], scopeId: string): unknown[] =>
  all.filter((d) => ((d as { scopeId?: unknown }).scopeId ?? "coordinator") === scopeId)

/**
 * The data of one card (show_* tool), for a coordinator's scope. The tool returns it, and GET /api/cards returns
 * its view (shared/cardviews.ts) so a card in an OpenUI-only UI refreshes live.
 */
export const cardData = (f: Factory, scope: Scope, name: string, a: Record<string, unknown>): unknown => {
  switch (name) {
    case "show_worker_board":
      return { workers: f.summaries(), at: Date.now() }
    case "show_decisions":
      return {
        pending: f.approvals
          .list()
          .filter((x) => x.status === "pending")
          .map((x) => ({
            id: x.id,
            title: x.title,
            kind: x.kind ?? "approval",
            context: x.context ?? "coordinator",
            options: x.options,
          })),
      }
    case "show_security_review": {
      const all = [...f.securityReviews.values()]
      const mine = all.filter(
        (r) => r.scopeId === scope.id || (scope.threadId !== null && r.threadId === scope.threadId),
      )
      const r = (mine.length ? mine : all).at(-1)
      if (!r) return { reviewId: null, note: "No security review yet." }
      const findings = r.findings.map((x) => ({
        title: x.title,
        severity: x.severity,
        file: x.file,
        verdict: x.verdict ?? "",
        reason: x.reason ?? "",
      }))
      return { reviewId: r.id, status: r.status, model: r.model, ...(r.error ? { error: r.error } : {}), findings }
    }
    case "show_code_review": {
      const r = [...f.codeReviews.values()].filter((x) => x.scopeId === scope.id).at(-1)
      if (!r) return { note: "No code review yet." }
      return {
        reviewId: r.id,
        status: r.status,
        lenses: r.lenses,
        lensProbabilities: r.lensProbabilities,
        findings: r.findings,
        ...(r.error ? { error: r.error } : {}),
      }
    }
    case "show_sdlc": {
      const s = f.sdlc.get(scope.id)
      if (!s) return { note: "No SDLC plan yet (sdlc_plan)." }
      const sec = [...f.securityReviews.values()].filter((r) => r.scopeId === scope.id).at(-1)
      const evidence =
        scope.workdir && existsSync(artifact(scope.workdir, "evidence.md"))
          ? readFileSync(artifact(scope.workdir, "evidence.md"), "utf8")
          : null
      return {
        tier: s.risk?.tier ?? null,
        reasons: s.risk?.reasons ?? [],
        criteria: s.criteria,
        unproven: unprovenCriteria(s.criteria, evidence),
        gates: s.gates,
        security: sec?.status ?? null,
        verified: s.verifyDoneAt !== null && s.implementDoneAt !== null && s.verifyDoneAt >= s.implementDoneAt,
        kept: s.findings.kept,
        dropped: s.findings.dropped,
        blockers: sdlcShipBlockers(f, scope),
      }
    }
    case "show_delivery_run": {
      const wt = scope.workdir
      const decisions = ownDecisions(f.decisions, scope.id).slice(-8)
      return {
        scopeId: scope.id,
        branch: wt ? currentBranch(wt) : (f.run?.branch ?? null),
        worktree: wt ?? f.run?.worktree ?? null,
        base: scope.base ?? f.run?.base ?? null,
        decisions,
        ...(decisions.length
          ? {}
          : {
              note: "No delivery run in this conversation yet. Answer from factory_status or your last step instead.",
            }),
      }
    }
    case "show_diff_summary": {
      const wt = scope.workdir ?? f.run?.worktree
      const base = scope.base ?? f.run?.base
      if (!wt || !base) return { error: "No worktree or base commit in this conversation." }
      try {
        return diffSummary(wt, base)
      } catch (e) {
        return { error: `git diff failed: ${e instanceof Error ? e.message : String(e)}` }
      }
    }
    case "show_report_findings": {
      const p = typeof a.path === "string" ? a.path : ""
      const file = scope.workdir ? path.resolve(scope.workdir, p) : null
      if (!file || !file.startsWith(path.resolve(scope.workdir!) + path.sep))
        return { path: p, findings: [], note: "The UI loads the report." }
      try {
        return { path: p, findings: reportFindings(readFileSync(file, "utf8")) }
      } catch {
        return { path: p, findings: [], error: "report not found" }
      }
    }
    default:
      return { error: `unknown card ${name}` }
  }
}
