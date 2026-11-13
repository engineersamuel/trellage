// Guided goal page (web-foldkit/public/goal-page): seed → discover → interview → rewrite → inspire → expect → ready →
// launch. Routes under /api/goal-page/*. Model calls go to models.goal_page through the OpenAI API at SF_PROXY_URL;
// decisions go to the factory's decision engine (Jev). Repos are read-only here. Launch saves the GoalSpec and starts
// a scored run (`sf goal run <id>`, detached, so it outlives a coordinator restart).
import { choice, noul } from "@typesafe-ai/sdk"
import { Exit, Schema } from "effect"
import { execFile, spawn } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"
import { factoryConfig } from "./config.ts"
import { chatUsage } from "./costs.ts"
import { systemOne, type Answer, type DecideRequest } from "./decide.ts"
import { loadPrompt, promptFile } from "./prompt.ts"
import { homeFor, readHome } from "./home.ts"
import { gateDefs } from "./sdlc.ts"
import type { Goals } from "./goals.ts"
import { decodeGoal, goalProblems } from "../../shared/goal.ts"

const run = promisify(execFile)

// ---------- Shapes ----------

const Section = Schema.Literals(["task", "inputs", "constraints", "criteria", "checks"])
const Patch = Schema.Struct({ section: Section, text: Schema.String })
const Doc = Schema.Struct({
  title: Schema.String,
  id: Schema.String,
  task: Schema.String,
  inputs: Schema.Array(Schema.String),
  constraints: Schema.Array(Schema.String),
  criteria: Schema.Array(Schema.String),
  checks: Schema.Array(Schema.String),
})
type Doc = typeof Doc.Type
type Repo = { id: string; name: string; path: string; base: string }

export class PageError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

type Decodable = Schema.Top & { readonly DecodingServices: never }

/** Decode `u` with `s`; the error is the readable cause. */
const decodeWith = <S extends Decodable>(
  s: S,
  u: unknown,
): { ok: true; value: S["Type"] } | { ok: false; error: string } => {
  const exit = Schema.decodeUnknownExit(s)(u)
  return Exit.isSuccess(exit) ? { ok: true, value: exit.value } : { ok: false, error: String(exit.cause) }
}

const decode = <S extends Decodable>(s: S, u: unknown, what: string): S["Type"] => {
  const r = decodeWith(s, u)
  if (!r.ok) throw new PageError(400, `bad ${what}: ${r.error}`.slice(0, 400))
  return r.value
}

const docText = (d: Doc) =>
  [
    `Title: ${d.title}`,
    `Task: ${d.task}`,
    `Inputs:\n${d.inputs.map((x) => `- ${x}`).join("\n") || "- (none)"}`,
    `Constraints:\n${d.constraints.map((x) => `- ${x}`).join("\n") || "- (none)"}`,
    `Acceptance criteria:\n${d.criteria.map((x, i) => `AC-${i + 1}: ${x}`).join("\n") || "(none)"}`,
    `Required checks:\n${d.checks.map((x) => `- ${x}`).join("\n") || "- (none)"}`,
  ].join("\n")

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "goal"

const cap = (s: string, n = 6000) => (s.length > n ? `${s.slice(0, n)}\n… (cut at ${n} chars)` : s)
const P = (name: string, vars: Record<string, string | number> = {}) => loadPrompt(`goal-page/${name}`, vars)
const options = (name: string) => promptFile(`goal-page/${name}`).meta.options as Record<string, string>
type Answers = Record<string, Answer | undefined>
const noulOf = (a: Answer | undefined): number | null => (typeof a?.noul === "number" ? a.noul : null)
const confidenceOf = (a: Answer | undefined): number | null => (typeof a?.confidence === "number" ? a.confidence : null)
/** Arguments of a repo tool, report_fact or finish call, as the model sent them. */
type ToolArgs = {
  path?: string
  start_line?: number
  max_lines?: number
  pattern?: string
  glob?: string
  n?: number
  kind?: string
  fact?: string
  source?: string
}
type ChatReply = {
  choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[]
} & Parameters<typeof chatUsage>[1]
const log = (s: string) => console.error(`goal-page: ${s}`)

// ---------- Model calls ----------

type Msg = {
  role: "system" | "user" | "assistant" | "tool"
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}
type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } }
type Tool = { type: "function"; function: { name: string; description: string; parameters: object } }
const fn = (name: string, description: string, properties: object, required: string[]): Tool => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
})

const sectionProp = { type: "string", enum: ["task", "inputs", "constraints", "criteria", "checks"] }
const patchProps = {
  section: sectionProp,
  text: { type: "string", description: "One line to add to that section of the goal document." },
}
const patchObj = { type: "object", additionalProperties: false, required: ["section", "text"], properties: patchProps }
const strArr = { type: "array", items: { type: "string" } }
const asPatch = (p: { section: string; text: string }) => ({ section: p.section, add: p.text })
/** How often the Goal page checks a deep research worker, and when it stops waiting. */
const WEB_POLL_MS = 5000
const WEB_MAX_MS = 30 * 60_000

export type GoalPageDeps = {
  proxyUrl: () => string
  /** Repo folders of the factory. */
  folders: () => readonly { id: string; name: string; path: string }[]
  knownSteps: () => readonly string[]
  goals: Goals
  /** A draft in the folder with a research worker: rpi-research (repo context, default) or deep-research (web). */
  startResearch: (
    folderId: string,
    brief: string,
    action?: "research" | "deep-research",
  ) => Promise<{ threadId: string; workerId: string; worktree: string; report: string }>
  workerState: (id: string) => { status: string; lastMessage: string | null; eventCount: number } | undefined
  removeDraft: (threadId: string) => Promise<void>
  /** Start `sf goal run <id>`; resolves with its thread id. */
  startRun: (goalId: string) => Promise<string>
  /** Store one model call's usage (`assistant.usage` data) for cost reports. */
  recordUsage?: (data: Record<string, unknown>) => void
}

export const makeGoalPage = (d: GoalPageDeps) => {
  let calls = 0
  const model = () => factoryConfig().models.goal_page
  const cfg = () => factoryConfig().goal_page

  const chat = async (messages: Msg[], tools: Tool[], toolChoice: unknown, timeoutMs = 120_000): Promise<Msg> => {
    calls++
    const r = await fetch(`${d.proxyUrl().replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({
        model: model(),
        reasoning_effort: cfg().effort,
        messages,
        ...(tools.length ? { tools, tool_choice: toolChoice, parallel_tool_calls: true } : {}),
      }),
    })
    if (!r.ok) throw new PageError(502, `${model()} ${r.status}: ${(await r.text()).slice(0, 300)}`)
    const reply = (await r.json()) as ChatReply
    const usage = chatUsage(model(), reply)
    if (usage) d.recordUsage?.(usage)
    const msg = reply.choices?.[0]?.message
    if (!msg) throw new PageError(502, `${model()}: empty reply`)
    return { role: "assistant", content: msg.content ?? null, tool_calls: msg.tool_calls }
  }

  /** One forced tool call; its arguments decoded with `schema`. */
  const ask = async <S extends Decodable>(
    system: string,
    user: string,
    name: string,
    schema: S,
    properties: object,
    required: string[],
  ): Promise<S["Type"]> => {
    const msg = await chat(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      [fn(name, "Submit the answer.", properties, required)],
      { type: "function", function: { name } },
    )
    const call = msg.tool_calls?.find((c) => c.function.name === name)
    if (!call) throw new PageError(502, `${model()} did not call ${name}`)
    const r = decodeWith(schema, JSON.parse(call.function.arguments))
    if (!r.ok) throw new PageError(502, `${model()} ${name} reply invalid: ${r.error}`.slice(0, 300))
    return r.value
  }

  const jev = async (state: string, questions: DecideRequest["questions"]): Promise<Answers> =>
    (await systemOne({ state, questions, timeoutMs: 15_000 })).answers

  // ---------- Read-only repo tools ----------

  const SECRET = /(^|\/)(\.env[^/]*|.*secret.*|.*token.*|.*credential.*|.*\.pem|.*\.key|id_rsa.*)$/i
  const SKIP = new Set([".git", "node_modules", "target", "dist", ".venv", "__pycache__"])

  const inRepo = (root: string, rel: string | undefined): string => {
    const abs = path.resolve(root, rel || ".")
    const real = existsSync(abs) ? realpathSync(abs) : abs
    if (real !== root && !real.startsWith(`${root}/`)) throw new Error("path is outside the repository")
    if (SECRET.test(path.relative(root, real))) throw new Error("refused: file may hold secrets")
    return real
  }
  const sh = async (cmd: string, args: string[], cwd: string) => {
    try {
      return (await run(cmd, args, { cwd, timeout: 20_000, maxBuffer: 4_000_000 })).stdout
    } catch (e) {
      const x = e as { stdout?: string; message?: string }
      return x.stdout || `error: ${x.message ?? String(e)}`
    }
  }

  const repoTools: Tool[] = [
    fn("list_dir", "List a directory of the repository (relative path, '' = root).", { path: { type: "string" } }, [
      "path",
    ]),
    fn(
      "read_file",
      "Read part of a text file of the repository.",
      { path: { type: "string" }, start_line: { type: "integer" }, max_lines: { type: "integer" } },
      ["path"],
    ),
    fn(
      "search",
      "ripgrep the repository (regex). Returns matching lines with file:line.",
      { pattern: { type: "string" }, glob: { type: "string" } },
      ["pattern"],
    ),
    fn("git_log", "Recent commits, optionally for one path.", { n: { type: "integer" }, path: { type: "string" } }, []),
    fn(
      "github",
      "Open issues or recent PRs of the repository.",
      { kind: { type: "string", enum: ["issues", "prs"] } },
      ["kind"],
    ),
  ]

  const runRepoTool = async (root: string, name: string, a: ToolArgs): Promise<string> => {
    switch (name) {
      case "list_dir":
        return readdirSync(inRepo(root, a.path), { withFileTypes: true })
          .filter((e) => !SKIP.has(e.name))
          .slice(0, 200)
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .join("\n")
      case "read_file": {
        const f = inRepo(root, a.path)
        if (lstatSync(f).size > 2_000_000) return "file too large"
        const lines = readFileSync(f, "utf8").split("\n")
        const start = Math.max(1, a.start_line ?? 1)
        const n = Math.min(400, a.max_lines ?? 200)
        return cap(
          `${lines
            .slice(start - 1, start - 1 + n)
            .map((l, i) => `${start + i}: ${l}`)
            .join("\n")}\n(${lines.length} lines total)`,
        )
      }
      case "search":
        return cap(
          (await sh(
            "rg",
            [
              "-n",
              "--max-count",
              "8",
              "--max-columns",
              "200",
              ...(a.glob ? ["-g", a.glob] : []),
              "--",
              a.pattern ?? "",
              ".",
            ],
            root,
          )) || "no matches",
        )
      case "git_log":
        return cap(
          await sh(
            "git",
            [
              "log",
              "--oneline",
              "-n",
              String(Math.min(40, a.n ?? 20)),
              ...(a.path ? ["--", inRepo(root, a.path)] : []),
            ],
            root,
          ),
        )
      case "github":
        return cap(
          a.kind === "prs"
            ? await sh("gh", ["pr", "list", "--state", "all", "--limit", "20", "--json", "number,title,state"], root)
            : await sh("gh", ["issue", "list", "--limit", "25", "--json", "number,title,labels"], root),
        )
      default:
        return `unknown tool ${name}`
    }
  }

  /** A repo-reading agent loop: reads with the tools above, reports facts as it learns them, ends with `finish`. */
  const repoAgent = async <S extends Decodable>(o: {
    root: string
    task: string
    finish: { schema: S; properties: object; required: string[]; description: string }
    maxTurns: number
    /** Refuse finish until this many facts were reported (except on the last round). */
    minFacts?: number
    onEvent: (type: string, data: unknown) => void
  }): Promise<S["Type"]> => {
    const report = fn(
      "report_fact",
      "Report one fact you verified in the repository, as soon as you learn it.",
      { fact: { type: "string" }, source: { type: "string", description: "file:line or command" } },
      ["fact", "source"],
    )
    const finish = fn("finish", o.finish.description, o.finish.properties, o.finish.required)
    const messages: Msg[] = [
      { role: "system", content: `${P("system")}\n${P("repo-agent", { root: o.root, maxTurns: o.maxTurns })}` },
      { role: "user", content: o.task },
    ]
    let facts = 0
    for (let turn = 1; turn <= o.maxTurns; turn++) {
      const last = turn === o.maxTurns
      o.onEvent("status", {
        text: last ? "Writing up…" : turn === 1 ? "Reading the repository…" : `Reading (round ${turn})…`,
      })
      const msg = await chat(
        messages,
        last ? [finish] : [...repoTools, report, finish],
        last ? { type: "function", function: { name: "finish" } } : "required",
      )
      messages.push(msg)
      for (const c of msg.tool_calls ?? []) {
        let args: ToolArgs = {}
        try {
          args = JSON.parse(c.function.arguments || "{}")
        } catch {}
        if (c.function.name === "finish") {
          if (o.minFacts && facts < o.minFacts && !last) {
            messages.push({
              role: "tool",
              tool_call_id: c.id,
              content: `Not yet: you reported ${facts} facts. Call report_fact for each verified fact you found (at least ${o.minFacts}), then call finish again.`,
            })
            continue
          }
          const r = decodeWith(o.finish.schema, args)
          if (r.ok) return r.value
          messages.push({
            role: "tool",
            tool_call_id: c.id,
            content: `invalid finish: ${r.error.slice(0, 500)}. Call finish again with valid arguments.`,
          })
          continue
        }
        if (c.function.name === "report_fact") {
          facts++
          o.onEvent("fact", { fact: String(args.fact ?? ""), source: String(args.source ?? "") })
          messages.push({ role: "tool", tool_call_id: c.id, content: "noted" })
          continue
        }
        o.onEvent("tool", { text: `${c.function.name} ${args.path ?? args.pattern ?? args.kind ?? ""}`.trim() })
        let out: string
        try {
          out = await runRepoTool(o.root, c.function.name, args)
        } catch (e) {
          out = `error: ${(e as Error).message}`
        }
        messages.push({ role: "tool", tool_call_id: c.id, content: out })
      }
    }
    throw new PageError(502, "repo reader ended without finish")
  }

  // ---------- Endpoints ----------

  const reposList = async (): Promise<Repo[]> =>
    Promise.all(
      d
        .folders()
        .filter((f) => f.path && existsSync(f.path))
        .map(async (f) => {
          const base = (await sh("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], f.path))
            .trim()
            .replace(/^origin\//, "")
          return { id: f.id, name: f.name, path: f.path, base: base && !base.startsWith("error") ? base : "main" }
        }),
    )

  const repoRoot = (p: string): string => {
    if (!d.folders().some((f) => f.path === p)) throw new PageError(400, "unknown repository (not a factory folder)")
    return realpathSync(p)
  }

  /** Jev's pick = the option with the highest probability (its `choice` can disagree with them). */
  const jevPick = (a: Answer | undefined, n: number) => {
    const probabilities: (number | null)[] = Array.from({ length: n }, (_, j) => a?.probabilities?.[`o${j}`] ?? null)
    const best = probabilities.reduce<number>((b, p, j) => ((p ?? -1) > (probabilities[b] ?? -1) ? j : b), 0)
    const pick = probabilities.some((p) => p !== null) ? best : a?.choice ? Number(String(a.choice).slice(1)) : 0
    return {
      pick,
      probabilities,
      confidence: probabilities[pick] ?? confidenceOf(a),
    }
  }
  const pickQuestion = (q: { text: string; why: string; options: readonly { label: string }[] }) =>
    choice(P("jev/pick", { text: q.text, why: q.why }), Object.fromEntries(q.options.map((o, j) => [`o${j}`, o.label])))

  const QuestionOut = Schema.Struct({
    text: Schema.String,
    why: Schema.String,
    options: Schema.Array(Schema.Struct({ label: Schema.String, patch: Patch })),
  })
  const questionProps = {
    type: "object",
    additionalProperties: false,
    required: ["text", "why", "options"],
    properties: {
      text: { type: "string" },
      why: { type: "string", description: "one sentence: why the answer matters" },
      options: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label", "patch"],
          properties: { label: { type: "string" }, patch: patchObj },
        },
      },
    },
  }
  const DiscoverOut = Schema.Struct({ ...Doc.fields, questions: Schema.Array(QuestionOut) })

  const discover = async (body: unknown, send: (type: string, data: unknown) => void) => {
    const { repo, seed } = decode(Schema.Struct({ repo: Schema.String, seed: Schema.String }), body, "discover request")
    const root = repoRoot(repo)
    const facts: { fact: string; source: string }[] = []
    const home = readHome()
    const homeText = homeFor(home, d.folders().find((f) => f.path === repo)?.name ?? path.basename(root))
    if (homeText) {
      const fact = { fact: "Used the factory home file for cross-repo rules.", source: `${home!.path}@${home!.hash}` }
      facts.push(fact)
      send("fact", fact)
    }
    const out = await repoAgent({
      root,
      maxTurns: 6,
      minFacts: 4,
      onEvent: (type, data) => {
        if (type === "fact") facts.push(data as { fact: string; source: string })
        send(type, data)
      },
      task: P("discover", { seed: JSON.stringify(seed) }) + (homeText ? `\n\n${homeText}` : ""),
      finish: {
        schema: DiscoverOut,
        description: "Submit the first draft of the goal and the interview questions.",
        required: ["title", "id", "task", "inputs", "constraints", "criteria", "checks", "questions"],
        properties: {
          title: { type: "string" },
          id: { type: "string", description: "slug: lowercase letters, digits, dashes; prefix with a short repo tag" },
          task: { type: "string", description: "1-3 sentences: the outcome the human wants" },
          inputs: strArr,
          constraints: strArr,
          criteria: strArr,
          checks: strArr,
          questions: { type: "array", items: questionProps },
        },
      },
    })
    send("status", { text: "Jev is pre-answering the questions…" })
    const doc: Doc = {
      title: out.title,
      id: slug(out.id),
      task: out.task,
      inputs: out.inputs,
      constraints: out.constraints,
      criteria: out.criteria,
      checks: out.checks,
    }
    const qs = out.questions.filter((q) => q.options.length >= 2)
    let answers: Answers = {}
    try {
      answers = await jev(
        `Repository: ${repo}\nHuman idea: ${seed}\n\nDraft goal:\n${docText(doc)}`,
        Object.fromEntries(qs.map((q, i) => [`q${i + 1}`, pickQuestion(q)])),
      )
    } catch (e) {
      send("status", { text: `Jev unavailable: ${(e as Error).message}` })
    }
    const questions = qs.map((q, i) => {
      const { pick, probabilities, confidence } = jevPick(answers[`q${i + 1}`], q.options.length)
      return {
        id: `q${i + 1}`,
        text: q.text,
        why: q.why,
        options: q.options.map((o) => o.label),
        patches: q.options.map((o) => asPatch(o.patch)),
        jev: pick,
        confidence,
        probabilities,
        docPatch: asPatch(q.options[pick]!.patch),
      }
    })
    return { discovered: facts, doc, questions }
  }

  const patchFor = async (body: unknown) => {
    const { doc, question, answer } = decode(
      Schema.Struct({ doc: Doc, question: Schema.String, answer: Schema.String }),
      body,
      "patch request",
    )
    return asPatch(
      await ask(
        P("system"),
        P("patch", { doc: docText(doc), question, answer: JSON.stringify(answer) }),
        "patch",
        Patch,
        patchProps,
        ["section", "text"],
      ),
    )
  }

  const SuggestOut = Schema.Struct({
    suggestions: Schema.Array(Schema.Struct({ section: Section, text: Schema.String, from: Schema.String })),
  })
  const suggest = async (body: unknown) => {
    const { doc, facts } = decode(
      Schema.Struct({ doc: Doc, facts: Schema.optionalKey(Schema.Array(Schema.Unknown)) }),
      body,
      "suggest request",
    )
    return ask(
      P("system"),
      P("suggest", { doc: docText(doc), facts: JSON.stringify(facts ?? []) }),
      "suggest",
      SuggestOut,
      {
        suggestions: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["section", "text", "from"],
            properties: { ...patchProps, from: { type: "string" } },
          },
        },
      },
      ["suggestions"],
    )
  }

  const RewriteOut = Schema.Struct({
    rewrites: Schema.Array(Schema.Struct({ title: Schema.String, prompt: Schema.String, notes: Schema.String })),
  })
  const enhance = async (body: unknown) => {
    const { doc } = decode(Schema.Struct({ doc: Doc }), body, "enhance request")
    const out = await ask(
      `${P("system")}\n${P("enhance-system")}`,
      P("enhance", { doc: docText(doc) }),
      "rewrites",
      RewriteOut,
      {
        rewrites: {
          type: "array",
          minItems: 3,
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "prompt", "notes"],
            properties: { title: { type: "string" }, prompt: { type: "string" }, notes: { type: "string" } },
          },
        },
      },
      ["rewrites"],
    )
    const rw = out.rewrites.slice(0, 3)
    const a = (
      await jev(`Goal document:\n${docText(doc)}`, {
        best: choice(P("jev/best-rewrite"), Object.fromEntries(rw.map((r, i) => [`r${i}`, r.prompt]))),
      })
    ).best
    const scored = rw.map((r, i) => ({ ...r, jevScore: (a?.probabilities?.[`r${i}`] as number | undefined) ?? null }))
    const order = [...scored].sort((x, y) => (y.jevScore ?? 0) - (x.jevScore ?? 0))
    return { rewrites: scored.map((r) => ({ ...r, jevRank: order.indexOf(r) + 1 })) }
  }

  const TEMPLATES = [
    {
      id: "bugfix",
      title: "Bug fix",
      criteria: ["A failing test reproduces the bug", "The test passes after the fix", "No unrelated files change"],
    },
    {
      id: "feature",
      title: "Feature",
      criteria: [
        "The new behaviour is observable via a command or request",
        "New config is documented",
        "Existing tests pass",
      ],
    },
    {
      id: "resilience",
      title: "Resilience",
      criteria: [
        "A transient failure recovers",
        "A permanent failure fails fast",
        "Recoveries are observable in logs or metrics",
        "Limits are configurable",
      ],
    },
    {
      id: "refactor",
      title: "Refactor",
      criteria: [
        "Behaviour unchanged (same tests pass)",
        "Public API unchanged",
        "The changed module gets simpler (fewer lines or branches)",
      ],
    },
    {
      id: "perf",
      title: "Performance",
      criteria: ["p95 latency below a stated number on a stated benchmark", "No regression in other benchmarks"],
    },
    {
      id: "docs",
      title: "Docs",
      criteria: ["Every command in the doc runs as written", "The doc names the config keys with defaults"],
    },
  ]
  const RESEARCH = [
    { id: "council", label: "Council", desc: "3 advisers argue the goal; one summary." },
    { id: "debate", label: "Debate", desc: "Six-hats debate on the draft." },
    { id: "research", label: "Research", desc: "Adds context to the goal: repo code paths, risks, prior art (RPI)." },
    {
      id: "hyperresearch",
      label: "Hyperresearch",
      desc: "More repo context, more rounds (repo agent).",
    },
    {
      id: "deep-research",
      label: "Deep research",
      desc: "Web research on the goal's open question; cited report (minutes).",
    },
  ]

  const InspireOut = Schema.Struct({
    pastGoals: Schema.Array(Schema.Struct({ id: Schema.String, tip: Schema.String, proposal: Patch })),
    repoScan: Schema.Array(
      Schema.Struct({
        kind: Schema.Literals(["issue", "todo", "pr", "ci"]),
        ref: Schema.String,
        title: Schema.String,
        hint: Schema.String,
        proposal: Patch,
      }),
    ),
    templates: Schema.Array(Schema.String),
  })
  const inspiration = async (body: unknown) => {
    const { repo, doc } = decode(Schema.Struct({ repo: Schema.String, doc: Doc }), body, "inspiration request")
    const root = repoRoot(repo)
    const past = d.goals
      .list()
      .filter((g) => g.spec.repo === repo)
      .map((g) => {
        const runs = d.goals.runs(g.spec.id)
        return {
          id: g.spec.id,
          title: g.spec.title,
          runs: runs.length,
          pass: runs.filter((r) => r.outcome === "pass").length,
          lastUnmet: g.last?.unmet ?? [],
          prompt: g.spec.prompt.slice(0, 600),
          untouched: g.spec.expect.pr?.untouched ?? [],
          bodyIncludes: g.spec.expect.pr?.bodyIncludes ?? [],
        }
      })
    const wf = path.join(root, ".github/workflows")
    const [issues, prs, todos] = await Promise.all([
      sh("gh", ["issue", "list", "--limit", "30", "--json", "number,title"], root),
      sh("gh", ["pr", "list", "--state", "all", "--limit", "20", "--json", "number,title,state"], root),
      sh("rg", ["-n", "--max-count", "3", "--max-columns", "160", "--", "TODO|FIXME|XXX", "."], root),
    ])
    const ci = existsSync(wf)
      ? readdirSync(wf)
          .map((f) => `.github/workflows/${f}: ${cap(readFileSync(path.join(wf, f), "utf8"), 1500)}`)
          .join("\n\n")
      : "no CI workflows"
    const out = await ask(
      P("system"),
      P("inspiration", {
        doc: docText(doc),
        past: cap(JSON.stringify(past), 9000),
        issues: cap(issues, 4000),
        prs: cap(prs, 3000),
        todos: cap(todos, 4000),
        ci: cap(ci, 4000),
        templates: JSON.stringify(TEMPLATES.map((t) => ({ id: t.id, title: t.title }))),
      }),
      "inspiration",
      InspireOut,
      {
        pastGoals: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "tip", "proposal"],
            properties: { id: { type: "string" }, tip: { type: "string" }, proposal: patchObj },
          },
        },
        repoScan: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "ref", "title", "hint", "proposal"],
            properties: {
              kind: { type: "string", enum: ["issue", "todo", "pr", "ci"] },
              ref: { type: "string" },
              title: { type: "string" },
              hint: { type: "string" },
              proposal: patchObj,
            },
          },
        },
        templates: strArr,
      },
      ["pastGoals", "repoScan", "templates"],
    )
    const byId = new Map(past.map((p) => [p.id, p]))
    return {
      pastGoals: out.pastGoals.flatMap((g) => {
        const p = byId.get(g.id)
        return p
          ? [
              {
                id: p.id,
                title: p.title,
                runs: p.runs,
                pass: p.pass,
                lastUnmet: p.lastUnmet,
                tip: g.tip,
                proposal: asPatch(g.proposal),
              },
            ]
          : []
      }),
      repoScan: out.repoScan.map((r) => ({
        kind: r.kind,
        ref: r.ref,
        title: r.title,
        hint: r.hint,
        proposal: asPatch(r.proposal),
      })),
      templates: [
        ...out.templates.flatMap((id) => TEMPLATES.filter((t) => t.id === id)),
        ...TEMPLATES.filter((t) => !out.templates.includes(t.id)),
      ],
      research: RESEARCH,
    }
  }

  const ResearchOut = Schema.Struct({ summary: Schema.String, suggestion: Patch })

  /** Deep research: a real deep-research worker (web, cited) in a draft; its report becomes summary + suggestion. */
  const webResearch = async (repo: string, goal: string, send: (type: string, data: unknown) => void) => {
    const folder = d.folders().find((f) => f.path === repo)
    if (!folder) throw new PageError(400, "repo is not a factory folder")
    const r = await d.startResearch(folder.id, P("web-brief", { goal }), "deep-research")
    send("status", { text: "Deep research worker started (web search, cited sources). It takes minutes." })
    const t0 = Date.now()
    for (;;) {
      await new Promise((ok) => setTimeout(ok, WEB_POLL_MS))
      const w = d.workerState(r.workerId)
      if (w?.status === "error" || w?.status === "failed")
        throw new PageError(502, `deep research failed: ${(w.lastMessage ?? "worker failed").slice(0, 300)}`)
      if (!w || ["idle", "stopped", "done"].includes(w.status)) break
      if (Date.now() - t0 > WEB_MAX_MS)
        throw new PageError(504, "deep research took over 30 min; see its draft in the Inbox")
      send("status", {
        text: `Deep research is working (${Math.round((Date.now() - t0) / 1000)} s, ${w.eventCount} events)…`,
      })
    }
    const file = path.join(r.worktree, r.report)
    if (!existsSync(file)) throw new PageError(502, `deep research finished without a report (${file})`)
    send("status", { text: "Reading the cited report…" })
    return ask(
      P("system"),
      P("web-map", { goal, report: cap(readFileSync(file, "utf8"), 30_000), path: file }),
      "deepresearch",
      ResearchOut,
      researchProps,
      ["summary", "suggestion"],
    )
  }
  const researchProps = { summary: { type: "string", description: "2-3 sentences" }, suggestion: patchObj }
  const research = async (body: unknown, send: (type: string, data: unknown) => void) => {
    const { action, repo, doc } = decode(
      Schema.Struct({
        action: Schema.Literals(["council", "debate", "research", "hyperresearch", "deep-research"]),
        repo: Schema.String,
        doc: Doc,
      }),
      body,
      "research request",
    )
    const goal = `Goal document:\n${docText(doc)}`
    let out: typeof ResearchOut.Type
    if (action === "council") {
      const roles = P("council-roles").split("\n").filter(Boolean)
      send("status", { text: `${roles.length} advisers are reading the goal…` })
      const views = await Promise.all(
        roles.map((r) =>
          ask(
            `${P("system")}\nYou are ${r}.`,
            P("council-view", { goal }),
            "view",
            Schema.Struct({ view: Schema.String }),
            { view: { type: "string" } },
            ["view"],
          ),
        ),
      )
      views.forEach((v, i) => send("view", { role: roles[i], view: v.view }))
      send("status", { text: "Chair is writing the summary…" })
      out = await ask(
        P("system"),
        P("council-summary", { goal, views: views.map((v, i) => `${roles[i]}:\n${v.view}`).join("\n\n") }),
        "council",
        ResearchOut,
        researchProps,
        ["summary", "suggestion"],
      )
    } else if (action === "debate") {
      send("status", { text: "Six hats are debating…" })
      out = await ask(P("system"), P("debate", { goal }), "debate", ResearchOut, researchProps, [
        "summary",
        "suggestion",
      ])
    } else if (action === "deep-research") {
      out = await webResearch(repo, goal, send)
    } else {
      out = await repoAgent({
        root: repoRoot(repo),
        maxTurns: action === "hyperresearch" ? 10 : 5,
        onEvent: send,
        task: P("research", { goal }),
        finish: {
          schema: ResearchOut,
          description: "Submit the research summary and one suggestion.",
          properties: researchProps,
          required: ["summary", "suggestion"],
        },
      })
    }
    return { action, summary: out.summary, suggestion: asPatch(out.suggestion) }
  }

  const ReasonsOut = Schema.Struct({
    gates: Schema.Array(Schema.Struct({ id: Schema.String, reason: Schema.String })),
    tier: Schema.String,
    bodyIncludes: Schema.Array(Schema.String),
    untouched: Schema.Array(Schema.String),
  })
  const expectations = async (body: unknown) => {
    const { doc } = decode(Schema.Struct({ doc: Doc }), body, "expectations request")
    const state = `Planned change (goal document):\n${docText(doc)}`
    const defs = gateDefs()
    const a = await jev(state, {
      ...Object.fromEntries(defs.map((g) => [g.id, noul(P("jev/gate", { question: g.question }))])),
      tier: choice(P("jev/tier"), options("jev/tier")),
    })
    const gates = defs.map((g) => {
      const p = noulOf(a[g.id])
      return { id: g.id, p, threshold: g.threshold, run: p === null || p >= g.threshold }
    })
    const tier = { value: String(a.tier?.choice ?? "T1"), p: confidenceOf(a.tier) }
    const r = await ask(
      P("system"),
      P("reasons", {
        state,
        gates: JSON.stringify(gates),
        tier: tier.value,
        meanings: JSON.stringify(Object.fromEntries(defs.map((g) => [g.id, g.question]))),
      }),
      "reasons",
      ReasonsOut,
      {
        gates: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "reason"],
            properties: { id: { type: "string" }, reason: { type: "string" } },
          },
        },
        tier: { type: "string" },
        bodyIncludes: strArr,
        untouched: strArr,
      },
      ["gates", "tier", "bodyIncludes", "untouched"],
    )
    const why = new Map(r.gates.map((g) => [g.id, g.reason]))
    return {
      steps: [
        { id: "implement", min: 1, max: null, on: true, reason: "The goal changes code.", p: null, floor: false },
        {
          id: "verify",
          min: 1,
          max: null,
          on: true,
          reason: "Floor: always verify after implement.",
          p: 1,
          floor: true,
        },
        { id: "security", min: 1, max: null, on: true, reason: "Floor: security review runs last.", p: 1, floor: true },
        { id: "finish", min: 1, max: 1, on: true, reason: "One PR.", p: null, floor: false },
      ],
      gates: gates.map((g) => ({
        ...g,
        reason:
          why.get(g.id) ??
          (g.p === null ? "Jev unavailable; run (fail safe)." : `Jev ${g.p.toFixed(2)} vs ${g.threshold}`),
      })),
      tier: { ...tier, reason: r.tier },
      pr: { state: "OPEN", checks: "SUCCESS", bodyIncludes: r.bodyIncludes, untouched: r.untouched },
      approvals: { plan: "auto", findings: "auto", ship: "auto", other: "human" },
      limits: { runs: 5, minutesPerRun: 720 },
    }
  }

  const DIMS = [
    { dim: "Clear", q: "jev/clear" },
    { dim: "Testable", q: "jev/testable" },
    { dim: "In scope", q: "jev/in-scope" },
  ]
  const jevScores = async (doc: Doc) => {
    const a = await jev(
      `Goal document:\n${docText(doc)}`,
      Object.fromEntries(DIMS.map((x, i) => [`d${i}`, noul(P(x.q))])),
    )
    return DIMS.map((x, i) => ({ dim: x.dim, p: noulOf(a[`d${i}`]) }))
  }
  const readiness = async (body: unknown) => {
    const { doc, notes } = decode(
      Schema.Struct({ doc: Doc, notes: Schema.optionalKey(Schema.Boolean) }),
      body,
      "readiness request",
    )
    const [scores, n] = await Promise.all([
      jevScores(doc),
      notes === false
        ? Promise.resolve(null)
        : ask(
            P("system"),
            P("readiness-notes", { state: `Goal document:\n${docText(doc)}` }),
            "notes",
            Schema.Struct({ clear: Schema.String, testable: Schema.String, inScope: Schema.String }),
            { clear: { type: "string" }, testable: { type: "string" }, inScope: { type: "string" } },
            ["clear", "testable", "inScope"],
          ),
    ])
    const noteOf = [n?.clear, n?.testable, n?.inScope]
    return { threshold: cfg().ready_threshold, scores: scores.map((s, i) => ({ ...s, note: noteOf[i] ?? "" })) }
  }

  /** Chat about one interview question: pros and cons of its options, follow-ups. Plain text reply. */
  const askChat = async (body: unknown) => {
    const {
      doc,
      question,
      options: opts,
      history,
    } = decode(
      Schema.Struct({
        doc: Doc,
        question: Schema.String,
        options: Schema.Array(Schema.String),
        history: Schema.Array(Schema.Struct({ role: Schema.Literals(["user", "assistant"]), content: Schema.String })),
      }),
      body,
      "ask request",
    )
    const msg = await chat(
      [
        {
          role: "system",
          content: `${P("system")}\n${P("ask", { doc: docText(doc), question, options: opts.map((o, i) => `${i + 1}. ${o}`).join("\n") })}`,
        },
        ...history.map((h) => ({ role: h.role, content: h.content }) as Msg),
      ],
      [],
      "none",
    )
    return { reply: msg.content ?? "" }
  }

  /** For a weak readiness dimension: concrete fixes, each an add / replace / remove on one section line. */
  const Fix = Schema.Struct({
    title: Schema.String,
    why: Schema.String,
    section: Section,
    op: Schema.Literals(["add", "replace", "remove"]),
    index: Schema.NullOr(Schema.Number),
    text: Schema.String,
  })
  const refine = async (body: unknown) => {
    const { doc, dim, note } = decode(
      Schema.Struct({ doc: Doc, dim: Schema.String, note: Schema.String }),
      body,
      "refine request",
    )
    const lines = (["inputs", "constraints", "criteria", "checks"] as const)
      .map((k) => `${k}:\n${doc[k].map((x, i) => `  [${i}] ${x}`).join("\n") || "  (none)"}`)
      .join("\n")
    return ask(
      P("system"),
      P("refine", { title: doc.title, task: doc.task, lines, dim, note }),
      "fixes",
      Schema.Struct({ fixes: Schema.Array(Fix) }),
      {
        fixes: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "why", "section", "op", "index", "text"],
            properties: {
              title: { type: "string" },
              why: { type: "string" },
              section: sectionProp,
              op: { type: "string", enum: ["add", "replace", "remove"] },
              index: { type: ["integer", "null"] },
              text: { type: "string" },
            },
          },
        },
      },
      ["fixes"],
    )
  }

  /** Jev "what if": readiness now and with each candidate change, plus Jev's yes/no on each change. All Jev, parallel. */
  const impact = async (body: unknown) => {
    const { doc, items } = decode(
      Schema.Struct({
        doc: Doc,
        items: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String, doc: Doc })),
      }),
      body,
      "impact request",
    )
    if (items.length > 40) throw new PageError(400, "at most 40 items")
    const [base, worth, ...each] = await Promise.all([
      jevScores(doc),
      items.length
        ? jev(
            `Goal document:\n${docText(doc)}`,
            Object.fromEntries(
              items.map((it, i) => [`c${i}`, noul(P("jev/worth", { change: JSON.stringify(it.label) }))]),
            ),
          )
        : Promise.resolve<Answers>({}),
      ...items.map((it) => jevScores(it.doc)),
    ])
    return {
      base,
      items: items.map((it, i) => {
        const scores = each[i]!
        return {
          id: it.id,
          worth: noulOf(worth[`c${i}`]),
          scores,
          delta: scores.map((s, j) => (s.p === null || base[j]!.p === null ? null : +(s.p - base[j]!.p!).toFixed(2))),
        }
      }),
    }
  }

  // ---------- RPI research: hve-core rpi-research adds context to the goal (not web deep research); Jev decides if and how deep ----------

  const deepDecide = async (body: unknown) => {
    const { doc } = decode(Schema.Struct({ doc: Doc }), body, "deep decide request")
    const a = await jev(`Goal document:\n${docText(doc)}`, {
      need: noul(P("jev/deep-need")),
      stable: noul(P("jev/deep-stable")),
      depth: choice(P("jev/deep-depth"), options("jev/deep-depth")),
    })
    const need = noulOf(a.need)
    const stable = noulOf(a.stable)
    const pr: Record<string, number> = a.depth?.probabilities ?? {}
    const best = Object.entries(pr).sort((x, y) => y[1] - x[1])[0]
    return {
      need: { p: need, threshold: cfg().deep_need, yes: need !== null && need >= cfg().deep_need },
      stable: { p: stable, threshold: cfg().deep_stable, yes: stable !== null && stable >= cfg().deep_stable },
      depth: {
        value: best?.[0] ?? String(a.depth?.choice ?? "balanced"),
        p: best?.[1] ?? confidenceOf(a.depth),
        probabilities: pr,
      },
      available: need !== null,
    }
  }

  type DeepRun = {
    threadId: string
    workerId: string
    worktree: string
    report: string
    startedAt: number
    result?: unknown
    mapping?: Promise<unknown>
  }
  const deepRuns = new Map<string, DeepRun>()

  const deepStart = async (body: unknown) => {
    const { repo, doc, depth } = decode(
      Schema.Struct({ repo: Schema.String, doc: Doc, depth: Schema.String }),
      body,
      "deep start request",
    )
    const folder = d.folders().find((f) => f.path === repo)
    if (!folder) throw new PageError(400, "repo is not a factory folder")
    const r = await d.startResearch(folder.id, P("deep-brief", { title: doc.title, depth, doc: docText(doc) }))
    deepRuns.set(r.threadId, { ...r, startedAt: Date.now() })
    return {
      threadId: r.threadId,
      workerId: r.workerId,
      worktree: r.worktree,
      reportPath: path.join(r.worktree, r.report),
    }
  }

  const DeepOut = Schema.Struct({
    summary: Schema.String,
    readiness: Schema.Literals(["Ready", "Not ready", "Not applicable", "Blocked"]),
    findings: Schema.Array(
      Schema.Struct({
        title: Schema.String,
        why: Schema.String,
        evidence: Schema.String,
        contrarian: Schema.Boolean,
        patch: Patch,
      }),
    ),
    decisions: Schema.Array(QuestionOut),
  })

  const findArtifact = (worktree: string): string | null => {
    const dir = path.join(worktree, ".copilot-tracking/research")
    if (!existsSync(dir)) return null
    const files = readdirSync(dir, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith("-research.md") && !f.includes("subagents"))
    return files.length ? path.join(dir, files.sort().at(-1)!) : null
  }

  const mapDeep = async (r: DeepRun, doc: Doc) => {
    const artifact = findArtifact(r.worktree)
    const reportFile = path.join(r.worktree, r.report)
    const text = [
      artifact ? `RPI research artifact:\n${cap(readFileSync(artifact, "utf8"), 30_000)}` : "",
      existsSync(reportFile) ? `Summary report:\n${cap(readFileSync(reportFile, "utf8"), 8000)}` : "",
    ]
      .filter(Boolean)
      .join("\n\n")
    if (!text) throw new PageError(502, "research finished without an artifact or report")
    const out = await ask(
      P("system"),
      P("deep-map", { doc: docText(doc), text }),
      "deep",
      DeepOut,
      {
        summary: { type: "string" },
        readiness: { type: "string", enum: ["Ready", "Not ready", "Not applicable", "Blocked"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "why", "evidence", "contrarian", "patch"],
            properties: {
              title: { type: "string" },
              why: { type: "string" },
              evidence: { type: "string" },
              contrarian: { type: "boolean" },
              patch: patchObj,
            },
          },
        },
        decisions: { type: "array", items: questionProps },
      },
      ["summary", "readiness", "findings", "decisions"],
    )
    const a = await jev(`Goal document:\n${docText(doc)}\n\nResearch summary: ${out.summary}`, {
      ...Object.fromEntries(
        out.findings.map((f, i) => [
          `f${i}`,
          noul(P("jev/finding", { finding: JSON.stringify(`${f.title}: ${f.why}`) })),
        ]),
      ),
      ...Object.fromEntries(out.decisions.map((q, i) => [`q${i}`, pickQuestion(q)])),
    })
    const bar = cfg().finding_change
    return {
      summary: out.summary,
      readiness: out.readiness,
      artifactPath: artifact,
      reportPath: reportFile,
      findings: out.findings.map((f, i) => {
        const p = noulOf(a[`f${i}`])
        return {
          title: f.title,
          why: f.why,
          evidence: f.evidence,
          contrarian: f.contrarian,
          proposal: asPatch(f.patch),
          jev: { p, threshold: bar, change: p !== null && p >= bar },
        }
      }),
      decisions: out.decisions.map((q, i) => {
        const { pick, probabilities, confidence } = jevPick(a[`q${i}`], q.options.length)
        return {
          id: `d${i}`,
          text: q.text,
          why: q.why,
          options: q.options.map((o) => o.label),
          patches: q.options.map((o) => asPatch(o.patch)),
          jev: pick,
          confidence,
          probabilities,
        }
      }),
    }
  }

  const deepStatus = async (body: unknown) => {
    const { threadId, doc } = decode(Schema.Struct({ threadId: Schema.String, doc: Doc }), body, "deep status request")
    const r = deepRuns.get(threadId)
    if (!r) throw new PageError(404, "no RPI research run with that id (the coordinator restarted?)")
    const w = d.workerState(r.workerId)
    const elapsed = Math.round((Date.now() - r.startedAt) / 1000)
    const artifact = findArtifact(r.worktree)
    if (w?.status === "error" || w?.status === "failed")
      return { state: "failed", elapsed, error: (w.lastMessage ?? "worker failed").slice(0, 300) }
    const done = !w || w.status === "idle" || w.status === "stopped" || w.status === "done"
    if (!done)
      return {
        state: "running",
        elapsed,
        worker: w.status,
        events: w.eventCount,
        artifact: !!artifact,
        threadId,
        workerId: r.workerId,
      }
    if (r.result) return { state: "done", elapsed, result: r.result }
    r.mapping ??= mapDeep(r, doc).then(
      (x) => (r.result = x),
      (e) => {
        r.mapping = undefined
        log(`deep map failed: ${(e as Error).message}`)
      },
    )
    return { state: "mapping", elapsed, artifact: !!artifact }
  }

  const deepCancel = async (body: unknown) => {
    const { threadId } = decode(Schema.Struct({ threadId: Schema.String }), body, "deep cancel request")
    deepRuns.delete(threadId)
    await d.removeDraft(threadId).catch(() => {})
    return { ok: true }
  }

  const goalPrompt = (doc: Doc) =>
    [
      doc.task,
      doc.inputs.length ? `\nInputs:\n${doc.inputs.map((x) => `- ${x}`).join("\n")}` : "",
      doc.constraints.length ? `\nConstraints:\n${doc.constraints.map((x) => `- ${x}`).join("\n")}` : "",
      `\n${P("launch-criteria", { n: doc.criteria.length })}\n${doc.criteria.map((c, i) => `AC-${i + 1}: ${c}`).join("\n")}`,
      doc.checks.length ? `\nRequired checks:\n${doc.checks.map((x) => `- ${x}`).join("\n")}` : "",
    ].join("\n")

  /** Save the spec to the goals folder, then start a scored run of it. */
  const launch = async (body: unknown) => {
    const {
      repo,
      base,
      doc,
      expect,
      approvals,
      limits,
      override,
      research: artifact,
    } = decode(
      Schema.Struct({
        repo: Schema.String,
        base: Schema.String,
        doc: Doc,
        expect: Schema.Unknown,
        approvals: Schema.optionalKey(Schema.Unknown),
        limits: Schema.optionalKey(Schema.Unknown),
        override: Schema.optionalKey(Schema.NullOr(Schema.String)),
        research: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
      body,
      "launch request",
    )
    const raw = {
      id: slug(doc.id),
      title: doc.title,
      repo,
      base,
      prompt: goalPrompt(doc) + (artifact ? `\n\n${P("launch-research", { path: artifact })}` : ""),
      expect,
      approvals: approvals ?? {},
      limits: limits ?? {},
      ...(override?.trim() ? { readinessOverride: override.trim() } : {}),
    }
    const exit = decodeGoal(raw)
    if (!Exit.isSuccess(exit)) throw new PageError(400, `not a valid goal: ${String(exit.cause)}`.slice(0, 500))
    const problems = goalProblems(exit.value, d.knownSteps())
    if (problems.length) throw new PageError(400, `not a valid goal: ${problems.join("; ")}`)
    const spec = d.goals.save(exit.value)
    const threadId = await d.startRun(spec.id)
    return {
      live: true,
      savedPath: path.join(d.goals.dir, `${spec.id}.json`),
      command: `sf goal run ${spec.id}`,
      threadId,
      spec,
    }
  }

  const ROUTES: Record<string, (b: unknown) => Promise<unknown>> = {
    patch: patchFor,
    suggest,
    enhance,
    inspiration,
    expectations,
    readiness,
    ask: askChat,
    refine,
    impact,
    "deep/decide": deepDecide,
    "deep/start": deepStart,
    "deep/status": deepStatus,
    "deep/cancel": deepCancel,
    launch,
  }
  const STREAMS: Record<string, (b: unknown, send: (t: string, d: unknown) => void) => Promise<unknown>> = {
    discover,
    research,
  }

  const json = (data: unknown, status = 200) => Response.json(data, { status })

  /** Server-sent events: progress events, then `done` with the result or `error`. */
  const sse = (work: (send: (type: string, data: unknown) => void) => Promise<unknown>) => {
    const enc = new TextEncoder()
    return new Response(
      new ReadableStream({
        async start(ctl) {
          const send = (type: string, data: unknown) => {
            try {
              ctl.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`))
            } catch {}
          }
          try {
            send("done", await work(send))
          } catch (e) {
            log((e as Error).message)
            send("error", { error: (e as Error).message })
          }
          ctl.close()
        },
      }),
      { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
    )
  }

  /** GET info|repos, POST one of ROUTES or STREAMS. */
  const handle = async (req: Request, name: string): Promise<Response> => {
    try {
      if (req.method === "GET" && name === "info")
        return json({ model: model(), effort: cfg().effort, proxy: d.proxyUrl(), liveLaunch: true, calls })
      if (req.method === "GET" && name === "repos") return json(await reposList())
      const route = ROUTES[name]
      const stream = STREAMS[name]
      if (req.method !== "POST" || (!route && !stream)) return json({ error: "not found" }, 404)
      let body: unknown
      try {
        body = await req.json()
      } catch {
        return json({ error: "body is not JSON" }, 400)
      }
      if (stream) return sse((send) => stream(body, send))
      return json(await route!(body))
    } catch (e) {
      const status = e instanceof PageError ? e.status : 500
      log(`${name} ${status}: ${(e as Error).message}`)
      return json({ error: (e as Error).message }, status)
    }
  }
  return { handle }
}

/**
 * `sf goal run <id>` as a detached process (its own group, no pipes, so it survives a coordinator restart). Its output
 * goes to `logDir/goal-<id>-<time>.log`. Resolves with the thread id the CLI prints first; rejects if none comes in 60 s.
 */
export const startGoalRun =
  (coordinatorUrl: string, logDir: string, cli = path.join(import.meta.dir, "..", "cli.ts")) =>
  (goalId: string): Promise<string> => {
    mkdirSync(logDir, { recursive: true })
    const logFile = path.join(logDir, `goal-${goalId}-${new Date().toISOString().replace(/[:.]/g, "-")}.log`)
    const out = openSync(logFile, "a")
    const child = spawn(process.execPath, [cli, "goal", "run", goalId], {
      cwd: path.join(import.meta.dir, ".."),
      env: { ...process.env, SF_URL: coordinatorUrl },
      detached: true,
      stdio: ["ignore", out, out],
    })
    child.unref()
    let exited: number | null | undefined
    child.once("exit", (code) => (exited = code))
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const poll = setInterval(() => {
        const text = readFileSync(logFile, "utf8")
        const m = /^thread ([0-9a-f-]{36})$/m.exec(text)
        const fail = (why: string) => (
          clearInterval(poll),
          reject(new Error(`${why}; log ${logFile}: ${text.slice(-300)}`))
        )
        if (m) return (clearInterval(poll), resolve(m[1]!))
        if (exited !== undefined) return fail(`sf goal run exited ${exited} before it started a thread`)
        if (Date.now() - started > 60_000) fail("sf goal run started no thread in 60 s")
      }, 300)
    })
  }
