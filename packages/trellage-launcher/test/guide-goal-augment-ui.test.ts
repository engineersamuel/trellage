import { stripVTControlCharacters } from "node:util"
import React from "react"
import { renderToString, type Key } from "ink"
import stringWidth from "string-width"
import { describe, expect, it, vi } from "vitest"

import {
  GuideGoalPanel,
  createGuideGoalPanelState,
  guideGoalPanelReducer,
  type GuideGoalPanelAction,
  type GuideGoalPanelState,
} from "../src/guide-goal-augment-ui.tsx"
import {
  guideGoalAnswerMaximumLength,
  renderGuideGoalProposal,
  type GuideGoalDraft,
  type GuideGoalQuestion,
  type GuideGoalRequest,
  type GuideGoalResponse,
} from "../src/guide-goal-augment.ts"
import { goalDraft, goalMeSkill } from "./fixtures/goal-me-skill.ts"

const handlers = vi.hoisted(() => ({
  input: undefined as ((input: string, key: Key) => void) | undefined,
  paste: undefined as ((text: string) => void) | undefined,
}))

vi.mock("ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("ink")>()),
  useInput: (handler: (input: string, key: Key) => void) => { handlers.input = handler },
  usePaste: (handler: (text: string) => void) => { handlers.paste = handler },
}))

const emptyKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  home: false,
  end: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
}

const question = (overrides: Partial<GuideGoalQuestion> = {}): GuideGoalRequest => ({
  kind: "question",
  runId: 9,
  requestId: 3,
  question: {
    question: "Which artifact should the goal produce?",
    choices: ["A design document", "An API client"],
    allowFreeform: true,
    ...overrides,
  },
})

const review = (draft: GuideGoalDraft = goalDraft): GuideGoalRequest => ({
  kind: "review",
  runId: 9,
  requestId: 4,
  proposal: renderGuideGoalProposal(goalMeSkill, draft),
})

const reduce = (state: GuideGoalPanelState, ...actions: ReadonlyArray<GuideGoalPanelAction>): GuideGoalPanelState =>
  actions.reduce(guideGoalPanelReducer, state)

const panel = (
  initial: GuideGoalPanelState,
  dimensions = { columns: 80, rows: 20 },
  initialAutoAcceptRecommended = false,
) => {
  let state = initial
  let autoAcceptRecommended = initialAutoAcceptRecommended
  const onSetAutoAcceptRecommended = vi.fn((enabled: boolean) => { autoAcceptRecommended = enabled })
  const onAction = vi.fn((action: GuideGoalPanelAction) => { state = guideGoalPanelReducer(state, action) })
  const onSubmit = vi.fn<(response: GuideGoalResponse) => void>()
  const onPark = vi.fn<() => void>()
  const onDiscard = vi.fn<() => void>()
  const screen = () => stripVTControlCharacters(renderToString(React.createElement(GuideGoalPanel, {
    state,
    autoAcceptRecommended,
    onSetAutoAcceptRecommended,
    onAction,
    onSubmit,
    onPark,
    onDiscard,
    ...dimensions,
  }), { columns: dimensions.columns }))
  const pressRendered = (input: string, key: Partial<Key> = {}) => {
    handlers.input?.(input, { ...emptyKey, ...key })
  }
  const press = (input: string, key: Partial<Key> = {}) => {
    screen()
    pressRendered(input, key)
  }
  const paste = (text: string) => {
    screen()
    handlers.paste?.(text)
  }
  return { state: () => state, screen, press, pressRendered, paste, onAction, onSubmit, onPark, onDiscard, onSetAutoAcceptRecommended }
}

const readDocument = (ui: ReturnType<typeof panel>, inspect: (screen: string) => void): ReadonlyArray<string> => {
  const document: string[] = []
  ui.press("", { home: true })
  for (let page = 0; page < 200; page += 1) {
    const screen = ui.screen()
    inspect(screen)
    const rows = screen.split("\n")
    const position = rows.findIndex((line) => /\d+–\d+\/\d+ · PgUp\/PgDn/u.test(line))
    const range = rows[position]?.match(/(\d+)–(\d+)\/(\d+)/u)
    if (range === undefined || range === null) throw new Error("Missing document scroll position")
    const start = Number(range[1])
    const end = Number(range[2])
    rows.slice(position - (end - start + 1), position).forEach((line, index) => {
      document[start - 1 + index] = line.replace(/^ /u, "")
    })
    if (end === Number(range[3])) return document
    ui.pressRendered("", { pageDown: true })
  }
  throw new Error("Could not scroll to the end of the document")
}

describe("Goal me choice and editor state", () => {
  it("offers a to enable automatic recommendations, then lets a stop them", () => {
    const ui = panel(createGuideGoalPanelState(question()), { columns: 40, rows: 10 })
    expect(ui.screen()).toContain("a accept all recommended answers")
    ui.press("a", { ctrl: true })
    ui.press("a", { meta: true })
    ui.press("a", { eventType: "release" })
    ui.paste("a")
    expect(ui.onSetAutoAcceptRecommended).not.toHaveBeenCalled()
    ui.press("a")
    expect(ui.onSetAutoAcceptRecommended).toHaveBeenLastCalledWith(true)
    expect(ui.onSubmit).not.toHaveBeenCalled()
    expect(ui.screen()).toContain("a stop automatic answers")
    ui.press("", { escape: true })
    expect(ui.onPark).toHaveBeenCalledOnce()
    expect(ui.screen()).toContain("a stop automatic answers")
    ui.press("a")
    expect(ui.onSetAutoAcceptRecommended).toHaveBeenLastCalledWith(false)
    expect(ui.screen()).toContain("a accept all recommended answers")
    expect(ui.screen().split("\n").length).toBeLessThanOrEqual(9)
  })

  it("does not interpret a as automation or approval in a goal review or discard dialog", () => {
    const ui = panel(createGuideGoalPanelState(review()))
    ui.press("a")
    expect(ui.onSetAutoAcceptRecommended).not.toHaveBeenCalled()
    expect(ui.onSubmit).not.toHaveBeenCalled()
    const automatic = panel(createGuideGoalPanelState(review()), { columns: 40, rows: 10 }, true)
    automatic.press("a")
    expect(automatic.onSetAutoAcceptRecommended).toHaveBeenCalledExactlyOnceWith(false)
    expect(automatic.onSubmit).not.toHaveBeenCalled()
    const discarding = panel(reduce(createGuideGoalPanelState(question()), { type: "confirm-discard" }))
    discarding.press("a")
    expect(discarding.onSetAutoAcceptRecommended).not.toHaveBeenCalled()
    expect(discarding.onDiscard).not.toHaveBeenCalled()
  })

  it.each(["answer", "feedback"] as const)("keeps a literal in an %s editor while automatic answers are enabled", (view) => {
    const state = view === "answer"
      ? createGuideGoalPanelState(question({ choices: [] }))
      : reduce(createGuideGoalPanelState(review()), { type: "edit" })
    const ui = panel(state, { columns: 80, rows: 20 }, true)
    if (view === "answer") expect(ui.screen()).toContain("no single recommended choice")
    ui.press("a")
    ui.paste("a")
    expect(ui.state().draft).toBe("aa")
    expect(ui.onSetAutoAcceptRecommended).not.toHaveBeenCalled()
    expect(ui.onSubmit).not.toHaveBeenCalled()
  })

  it("waits for Enter and sends exactly the selected SDK choice", () => {
    const exact = "  API client: q x L p a 123 `\t界 😀\nKeep this line.  "
    const ui = panel(createGuideGoalPanelState(question({ choices: ["First", exact] })))
    ui.screen()
    ui.paste("First\n")
    expect(ui.onSubmit).not.toHaveBeenCalled()
    expect(ui.state().draft).toBe("")
    ui.press("", { downArrow: true })
    expect(ui.onSubmit).not.toHaveBeenCalled()
    ui.press("", { return: true })
    expect(ui.onSubmit).toHaveBeenCalledExactlyOnceWith({
      kind: "answer",
      answer: { answer: exact, wasFreeform: false },
    })
  })

  it("opens Type your own only when allowed and preserves typed whitespace", () => {
    const ui = panel(createGuideGoalPanelState(question()))
    ui.press("", { upArrow: true })
    expect(ui.state().choiceIndex).toBe(2)
    expect(ui.screen()).toContain("Type your own")
    ui.press("", { return: true })
    expect(ui.state().view).toBe("answer")
    expect(ui.onSubmit).not.toHaveBeenCalled()
    ui.press("  My artifact  ")
    ui.press("", { return: true })
    expect(ui.onSubmit).toHaveBeenCalledExactlyOnceWith({
      kind: "answer",
      answer: { answer: "  My artifact  ", wasFreeform: true },
    })
  })

  it("cycles only supplied choices when freeform is forbidden", () => {
    const start = createGuideGoalPanelState(question({ allowFreeform: false }))
    const ui = panel(start)
    expect(ui.screen()).not.toContain("Type your own")
    ui.press("", { upArrow: true })
    expect(ui.state().choiceIndex).toBe(1)
    ui.press("", { downArrow: true })
    expect(ui.state().choiceIndex).toBe(0)
    ui.press("qxLpa123`")
    expect(ui.state().draft).toBe("")
    const denied = guideGoalPanelReducer(start, { type: "edit" })
    expect(denied.view).toBe("choices")
    expect(denied.error).toContain("does not allow a typed answer")
    expect(guideGoalPanelReducer(denied, { type: "paste", text: "Not a choice" }).draft).toBe("")
  })

  it("starts text-only questions in the editor without answering", () => {
    const ui = panel(createGuideGoalPanelState(question({ choices: [] })))
    expect(ui.state().view).toBe("answer")
    expect(ui.screen()).toContain("Which artifact")
    expect(ui.onSubmit).not.toHaveBeenCalled()
    ui.press("", { return: true })
    expect(ui.onSubmit).not.toHaveBeenCalled()
    expect(ui.screen()).toContain("Enter an answer before you submit")
    ui.press("A report")
    ui.press("", { return: true })
    expect(ui.onSubmit).toHaveBeenCalledExactlyOnceWith({
      kind: "answer",
      answer: { answer: "A report", wasFreeform: true },
    })
  })

  it("preserves the view, selection, draft, and both scroll positions when parked and reopened", () => {
    const saved = reduce(
      createGuideGoalPanelState(question()),
      { type: "move", delta: -1 },
      { type: "scroll", offset: 7 },
      { type: "edit" },
      { type: "paste", text: "Keep this draft\nand this line." },
      { type: "scroll", offset: 2 },
    )
    const ui = panel(saved)
    ui.press("", { escape: true })
    expect(ui.state()).toBe(saved)
    expect(ui.onPark).toHaveBeenCalledOnce()
    expect(ui.onSubmit).not.toHaveBeenCalled()
    const restored: GuideGoalPanelState = JSON.parse(JSON.stringify(ui.state()))
    const resumed = panel(restored)
    resumed.press("b", { ctrl: true })
    expect(resumed.state()).toMatchObject({
      view: "choices", choiceIndex: 2, contentScroll: 7, editorScroll: 2, draft: saved.draft,
    })
    resumed.press("", { return: true })
    expect(resumed.state()).toMatchObject({ view: "answer", editorScroll: 2, draft: saved.draft })
    resumed.press("", { return: true })
    expect(resumed.onSubmit).toHaveBeenCalledExactlyOnceWith({
      kind: "answer",
      answer: { answer: saved.draft, wasFreeform: true },
    })
    expect(resumed.state().request).toEqual(saved.request)
  })
})

describe("Goal me text input", () => {
  it("leaves Markdown in questions, choices, and typed answers as literal text", () => {
    const prompt = "# Exact question\nKeep **bold** and `code` literal?"
    const choice = "- **An exact choice** with `code`"
    const answer = "# My answer\n- Keep `command` and **word** unchanged."
    const ui = panel(createGuideGoalPanelState(question({ question: prompt, choices: [choice] })))
    expect(ui.screen()).toContain("# Exact question")
    expect(ui.screen()).toContain("Keep **bold** and `code` literal?")
    expect(ui.screen()).toContain(choice)
    ui.press("", { downArrow: true })
    ui.press("", { return: true })
    ui.paste(answer)
    expect(ui.screen()).toContain("# My answer")
    expect(ui.screen()).toContain("- Keep `command` and **word** unchanged.")
    ui.press("", { return: true })
    expect(ui.onSubmit).toHaveBeenCalledExactlyOnceWith({
      kind: "answer",
      answer: { answer, wasFreeform: true },
    })
  })

  it("treats command letters, digits, and backticks as ordinary text", () => {
    const ui = panel(createGuideGoalPanelState(question({ choices: [] })))
    for (const letter of "qxLpa1234567890`") ui.press(letter, { shift: letter === "L" })
    expect(ui.state().draft).toBe("qxLpa1234567890`")
    expect(ui.onSubmit).not.toHaveBeenCalled()
    expect(ui.onDiscard).not.toHaveBeenCalled()
    expect(ui.onPark).not.toHaveBeenCalled()
    ui.press("c", { ctrl: true })
    ui.press("\u0003")
    ui.press("q", { eventType: "release" })
    expect(ui.state().draft).toBe("qxLpa1234567890`")
    expect(ui.state().discardOpen).toBe(false)
    expect(ui.onPark).not.toHaveBeenCalled()
  })

  it("keeps multiline paste and modified Enter as text until plain Enter", () => {
    const ui = panel(createGuideGoalPanelState(question({ choices: [] })))
    ui.paste("q\r\nx\rL\tpa123`")
    ui.press("", { return: true, shift: true })
    ui.press("one")
    ui.press("", { return: true, meta: true })
    ui.press("two")
    ui.paste("\n")
    const draft = "q\nx\nL\tpa123`\none\ntwo\n"
    expect(ui.state().draft).toBe(draft)
    expect(ui.onSubmit).not.toHaveBeenCalled()
    expect(ui.screen()).toContain("Alt/Shift+Enter newline")
    ui.press("", { return: true })
    expect(ui.onSubmit).toHaveBeenCalledExactlyOnceWith({
      kind: "answer",
      answer: { answer: draft, wasFreeform: true },
    })
  })

  it("rejects invalid paste without corrupting the saved draft or activating commands", () => {
    const start = reduce(createGuideGoalPanelState(question({ choices: [] })), { type: "append", text: "Saved" })
    const ui = panel(start)
    ui.paste("x\u001b[31m\nq\u0000")
    expect(ui.state().draft).toBe("Saved")
    expect(ui.screen()).toContain("unsupported control characters")
    expect(ui.state().discardOpen).toBe(false)
    expect(ui.onDiscard).not.toHaveBeenCalled()
    ui.paste(" safely")
    expect(ui.state().draft).toBe("Saved safely")
    expect(ui.state().error).toBeNull()
  })

  it("counts Unicode code points and rejects an entire overlength addition", () => {
    const text = "😀".repeat(guideGoalAnswerMaximumLength - 1) + "界"
    const full = reduce(
      createGuideGoalPanelState(question({ choices: [] })),
      { type: "paste", text },
    )
    expect(full.draft).toBe(text)
    expect(full.error).toBeNull()
    const rejected = guideGoalPanelReducer(full, { type: "append", text: "😀" })
    expect(rejected.draft).toBe(text)
    expect(rejected.error).toContain("Nothing was added")
    const overlong = guideGoalPanelReducer(full, { type: "paste", text: "keep neither part" })
    expect(overlong.draft).toBe(text)
    const ui = panel(full)
    ui.press("", { return: true })
    expect(ui.onSubmit).toHaveBeenCalledExactlyOnceWith({
      kind: "answer",
      answer: { answer: text, wasFreeform: true },
    })
  })

  it("removes whole visible graphemes, including combining accents and joined emoji", () => {
    const start = reduce(
      createGuideGoalPanelState(question({ choices: [] })),
      { type: "append", text: "a👩🏽‍💻e\u0301" },
    )
    const accent = guideGoalPanelReducer(start, { type: "backspace" })
    expect(accent.draft).toBe("a👩🏽‍💻")
    const emoji = guideGoalPanelReducer(accent, { type: "backspace" })
    expect(emoji.draft).toBe("a")
    expect(guideGoalPanelReducer(emoji, { type: "backspace" }).draft).toBe("")
  })

  it("keeps parent validation errors actionable and clears them on an edit", () => {
    const errored = reduce(
      createGuideGoalPanelState(question({ choices: [] })),
      { type: "paste", text: " \n\t " },
      { type: "error", message: "This answer was rejected. Edit it or park the interview." },
    )
    const ui = panel(errored, { columns: 40, rows: 10 })
    expect(ui.screen()).toContain("Error:")
    expect(ui.screen()).toContain("Esc park")
    ui.press("", { return: true })
    expect(ui.onSubmit).not.toHaveBeenCalled()
    expect(ui.state().error).toContain("Enter an answer")
    ui.press("x")
    expect(ui.state().error).toBeNull()
    ui.press("", { return: true })
    expect(ui.onSubmit).toHaveBeenCalledWith({
      kind: "answer",
      answer: { answer: " \n\t x", wasFreeform: true },
    })
  })
})

describe("Goal me review and discard", () => {
  it("approves only Use goal, never on render, scroll, or selection", () => {
    const ui = panel(createGuideGoalPanelState(review()))
    ui.screen()
    ui.press("", { pageDown: true })
    ui.press("", { downArrow: true })
    ui.press("", { upArrow: true })
    expect(ui.onSubmit).not.toHaveBeenCalled()
    ui.press("", { return: true })
    expect(ui.onSubmit).toHaveBeenCalledExactlyOnceWith({ kind: "review", review: { decision: "use" } })
  })

  it("requires feedback and retains it when returning to review", () => {
    const ui = panel(createGuideGoalPanelState(review()))
    ui.press("", { pageDown: true })
    const reviewScroll = ui.state().contentScroll
    ui.press("", { downArrow: true })
    ui.press("", { return: true })
    expect(ui.state().view).toBe("feedback")
    ui.press("", { return: true })
    expect(ui.onSubmit).not.toHaveBeenCalled()
    expect(ui.screen()).toContain("Enter revision feedback")
    ui.paste("Specify a cap of three attempts.\nKeep permanent failures separate.")
    ui.press("b", { ctrl: true })
    expect(ui.state().view).toBe("review")
    expect(ui.state().contentScroll).toBe(reviewScroll)
    ui.press("", { return: true })
    expect(ui.state().view).toBe("feedback")
    ui.press("", { return: true })
    expect(ui.onSubmit).toHaveBeenCalledExactlyOnceWith({
      kind: "review",
      review: {
        decision: "revise",
        feedback: "Specify a cap of three attempts.\nKeep permanent failures separate.",
      },
    })
  })

  it("confirms Cancel and discards without submitting a response", () => {
    const ui = panel(createGuideGoalPanelState(review()))
    ui.press("", { upArrow: true })
    expect(ui.state().reviewIndex).toBe(2)
    ui.press("", { return: true })
    expect(ui.state().discardOpen).toBe(true)
    expect(ui.screen()).toContain("The original prompt stays unchanged.")
    expect(ui.onDiscard).not.toHaveBeenCalled()
    ui.press("", { downArrow: true })
    ui.press("", { return: true })
    expect(ui.onDiscard).toHaveBeenCalledOnce()
    expect(ui.onSubmit).not.toHaveBeenCalled()
  })

  it("parks or returns from discard confirmation without losing an active answer", () => {
    const ui = panel(createGuideGoalPanelState(question({ choices: [] })))
    ui.press("Keep my draft")
    ui.press("x", { ctrl: true })
    const confirming = ui.state()
    ui.press("", { escape: true })
    expect(ui.state()).toBe(confirming)
    expect(ui.onPark).toHaveBeenCalledOnce()
    expect(ui.onDiscard).not.toHaveBeenCalled()
    ui.press("", { return: true })
    expect(ui.state().discardOpen).toBe(false)
    expect(ui.state().draft).toBe("Keep my draft")
    ui.press("x", { ctrl: true })
    ui.press("", { downArrow: true })
    ui.press("b", { ctrl: true })
    expect(ui.state().discardOpen).toBe(false)
    expect(ui.state().draft).toBe("Keep my draft")
    expect(ui.onSubmit).not.toHaveBeenCalled()
  })
})

describe("Goal me text viewports", () => {
  it("keeps long questions and full choices reachable with a visible selection and actions", () => {
    const option = `FIRST CHOICE\n${"Long Unicode option 界 👩🏽‍💻. ".repeat(18)}\nFIRST CHOICE END`
    const second = `SECOND CHOICE\n${"Another complete option. ".repeat(12)}\nSECOND CHOICE END`
    const ui = panel(createGuideGoalPanelState(question({
      question: `QUESTION START\n${"Explain the artifact and its limits. ".repeat(18)}\nQUESTION END`,
      choices: [option, second],
      allowFreeform: false,
    })), { columns: 40, rows: 10 })
    const seen: string[] = []
    for (let page = 0; page < 80; page += 1) {
      const screen = ui.screen()
      seen.push(screen)
      expect(screen).toContain("❯ 1/2")
      expect(screen).toContain("Enter answer")
      expect(screen).toContain("Esc park")
      expect(screen.split("\n").length).toBeLessThanOrEqual(9)
      expect(screen.split("\n").every((line) => stringWidth(line) <= 40)).toBe(true)
      const previous = ui.state().contentScroll
      ui.press("", { pageDown: true })
      if (ui.state().contentScroll === previous) break
    }
    for (const marker of ["QUESTION START", "QUESTION END", "FIRST CHOICE END", "SECOND CHOICE END"]) {
      expect(seen.join("\n")).toContain(marker)
    }
    ui.press("", { downArrow: true })
    expect(ui.screen()).toContain("❯ 2/2 SECOND CHOICE")
    expect(ui.screen()).toContain("Another complete option")
    ui.press("", { return: true })
    expect(ui.onSubmit).toHaveBeenCalledExactlyOnceWith({
      kind: "answer",
      answer: { answer: second, wasFreeform: false },
    })
  })

  it("exposes every line of the rendered goal through scrolling without hiding review actions", () => {
    const request = review()
    if (request.kind !== "review") throw new Error("Expected a review fixture")
    const ui = panel(createGuideGoalPanelState(request), { columns: 120, rows: 10 })
    const seen = readDocument(ui, (screen) => {
      for (const action of ["Use goal", "Revise", "Cancel", "Esc park"]) expect(screen).toContain(action)
      expect(screen.split("\n").length).toBeLessThanOrEqual(9)
    })
    for (const line of request.proposal.prompt.split("\n").filter((line) => line.length > 0)) {
      expect(seen.join("\n")).toContain(line.replace(/^-(?= |$)/u, "•"))
    }
    expect(ui.onSubmit).not.toHaveBeenCalled()
  })

  it.each(["review", "feedback"] as const)(
    "keeps the full Markdown goal readable in a narrow %s without changing approval or input",
    (view) => {
      const command = "npm run verify --workspace=packages/trellage-launcher -- --include=complete-command-tail"
      const criterionCommand = "node scripts/check-evidence.mjs --criteria=all --report=complete-criterion-tail"
      const request = review({
        ...goalDraft,
        task: `## Deliverable\nWrite **bounded retries**.\nRun \`${command}\`.`,
        criteria: [`The command \`${criterionCommand}\` succeeds.`, ...goalDraft.criteria.slice(1)],
      })
      if (request.kind !== "review") throw new Error("Expected a review fixture")
      const approvedPrompt = request.proposal.prompt
      const feedback = "# Keep feedback literal\n- `draft command` **exact**"
      const ui = panel(createGuideGoalPanelState(request), { columns: 40, rows: 10 })
      if (view === "feedback") {
        ui.press("", { downArrow: true })
        ui.press("", { return: true })
        ui.paste(feedback)
      }
      const document = readDocument(ui, (screen) => {
        expect(screen.split("\n").length).toBeLessThanOrEqual(9)
        expect(screen.split("\n").every((line) => stringWidth(line) <= 40)).toBe(true)
        expect(screen).toContain("Esc park")
        if (view === "review") {
          for (const label of ["Use goal", "Revise", "Cancel"]) expect(screen).toContain(label)
        } else {
          expect(screen).toContain("Enter")
          expect(screen).toContain("Feedback ·")
        }
      }).join("\n")
      const goal = document.split("Revision feedback:")[0] ?? ""
      const compactGoal = goal.replace(/\s/gu, "")
      for (const value of [command, criterionCommand]) {
        expect(compactGoal).toContain(value.replace(/\s/gu, ""))
      }
      expect(goal).toContain("Deliverable\n\nWrite bounded retries.")
      expect(goal).toContain("\nTASK:\n\nArtifact:")
      expect(goal).toContain("\nRULES:\n\n• Never call it done")
      expect(goal).not.toContain("`")
      expect(goal).not.toContain("**")
      expect(goal).not.toContain("## ")
      for (const [index, step] of ["READ", "PLAN", "DO", "VERIFY", "DECIDE"].entries()) {
        expect(goal).toContain(`${index + 1}. ${step}`)
      }
      expect(ui.onSubmit).not.toHaveBeenCalled()
      if (view === "feedback") {
        expect(document).toContain(feedback)
        expect(ui.state().draft).toBe(feedback)
      }
      ui.press("", { return: true })
      expect(ui.onSubmit).toHaveBeenCalledExactlyOnceWith({
        kind: "review",
        review: view === "feedback" ? { decision: "revise", feedback } : { decision: "use" },
      })
      expect(ui.state().request).toBe(request)
      expect(request.proposal.prompt).toBe(approvedPrompt)
    },
  )

  it.each([question(), question({ choices: [] }), review()])(
    "keeps the selection, input, and park controls inside a short terminal",
    (request) => {
      const ui = panel(createGuideGoalPanelState(request), { columns: 40, rows: 8 })
      const screen = ui.screen()
      expect(screen.split("\n").length).toBeLessThanOrEqual(7)
      expect(screen.split("\n").every((line) => stringWidth(line) <= 40)).toBe(true)
      expect(screen).toContain("Enter")
      expect(screen).toContain("Esc park")
      if (request.kind === "review") {
        for (const label of ["Use goal", "Revise", "Cancel"]) expect(screen).toContain(label)
      }
    },
  )
})
