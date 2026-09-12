import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Terminal } from "@xterm/headless"
import { bunArguments, bunExecutable } from "@trellage/runtime"
import { expect, test, vi, type TestContext } from "vitest"
import { spawnSourcePty, type SourcePty } from "./helpers/source-pty.ts"
import { ContinuationActionStatus, ContinuationPlacementKind, type ContinuationDraft } from "@trellage/guide-core"
import {
  ContinuationFixtureEventKind,
  ContinuationFixtureMode as FixtureMode,
  type ContinuationFixtureEvent,
} from "./helpers/continuation-ui-fixtures.ts"

const entry = fileURLToPath(new URL("./fixtures/continuation-integration.tsx", import.meta.url))

interface FixtureReport {
  readonly draft: ContinuationDraft
  readonly events: ReadonlyArray<ContinuationFixtureEvent>
  readonly code: number
}

const createTerminal = async (onTestFailed: TestContext["onTestFailed"]) => {
  const root = await mkdtemp(path.join(tmpdir(), "trellage-continuation-ui-"))
  await mkdir(path.join(root, "home"), { recursive: true, mode: 0o700 })
  await mkdir(path.join(root, "scratch"), { mode: 0o700 })
  const terminal = new Terminal({ cols: 110, rows: 38, scrollback: 0, allowProposedApi: true })
  let child: SourcePty | undefined
  let exit: { readonly exitCode: number; readonly signal?: number } | undefined
  let screen = ""
  let output = ""
  const inputs: string[] = []
  onTestFailed(() => {
    console.error(
      `Continuation inputs: ${JSON.stringify(inputs)}\nScreen:\n${screen}\nPTY tail: ${JSON.stringify(output.slice(-2000))}`,
    )
  })
  const waitForText = async (...expected: ReadonlyArray<string>): Promise<void> => {
    await vi.waitFor(
      () => {
        expect(exit, "Continuation closed before the expected screen").toBeUndefined()
        for (const text of expected) expect(screen).toContain(text)
      },
      { timeout: 5000, interval: 20 },
    )
  }
  const press = (keys: string): void => {
    if (child === undefined || exit !== undefined) throw new Error("Input requires a running continuation fixture.")
    inputs.push(keys)
    child.write(keys)
  }
  const events = async (): Promise<ReadonlyArray<ContinuationFixtureEvent>> => {
    const text = (await readFile(path.join(root, "events.jsonl"), "utf8")).trim()
    return text ? text.split("\n").map((line) => JSON.parse(line) as ContinuationFixtureEvent) : []
  }
  return {
    press,
    resize: (columns: number, rows: number): void => {
      terminal.resize(columns, rows)
      child?.resize(columns, rows)
    },
    waitForText,
    events,
    text: () => screen,
    async start(mode: FixtureMode, columns = 110, rows = 38): Promise<void> {
      if (child !== undefined) throw new Error("Each test requires a fresh continuation process.")
      terminal.resize(columns, rows)
      const processUnderTest = spawnSourcePty(bunExecutable(), bunArguments(entry, [root, mode]), {
        name: "xterm-256color",
        cols: columns,
        rows,
        cwd: root,
        env: {
          HOME: path.join(root, "home"),
          XDG_CONFIG_HOME: path.join(root, "home"),
          XDG_CACHE_HOME: path.join(root, "home"),
          TMPDIR: path.join(root, "scratch"),
          TMP: path.join(root, "scratch"),
          TEMP: path.join(root, "scratch"),
          PATH: path.dirname(bunExecutable()),
          TERM: "xterm-256color",
          CI: "true",
          // Ink still needs redraws for keyboard focus under CI.
          FORCE_COLOR: "1",
        },
      })
      child = processUnderTest
      terminal.onData((data) => processUnderTest.write(data))
      processUnderTest.onData((data) => {
        output = (output + data).slice(-12000)
        terminal.write(data, () => {
          const buffer = terminal.buffer.active
          screen = Array.from(
            { length: terminal.rows },
            (_, row) => buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "",
          ).join("\n")
        })
      })
      processUnderTest.onExit((status) => {
        exit = status
      })
      await waitForText("TRX conversation next steps")
      await vi.waitFor(
        () => {
          expect(exit, "Continuation closed before enabling terminal input").toBeUndefined()
          expect(terminal.modes.bracketedPasteMode, "Continuation terminal input is not enabled").toBe(true)
        },
        { timeout: 5000, interval: 20 },
      )
    },
    async pressAndWait(keys: string, ...texts: ReadonlyArray<string>): Promise<void> {
      if (texts.every((text) => screen.includes(text))) {
        throw new Error(
          `Transition already matches before input ${JSON.stringify(keys)}. Wait for a changed screen, focus marker, or saved state.`,
        )
      }
      press(keys)
      await waitForText(...texts)
    },
    async waitForInput(input: string): Promise<void> {
      await vi.waitFor(
        async () => {
          expect(
            (await events()).some(
              (event) => event.kind === ContinuationFixtureEventKind.Input && event.input === input,
            ),
          ).toBe(true)
        },
        { timeout: 5000, interval: 20 },
      )
    },
    async finish(keys = "q"): Promise<FixtureReport> {
      press(keys)
      await vi.waitFor(() => expect(exit).toMatchObject({ exitCode: 0 }), { timeout: 5000, interval: 20 })
      expect(exit?.signal ?? 0).toBe(0)
      return JSON.parse(await readFile(path.join(root, "result.json"), "utf8")) as FixtureReport
    },
    async close(): Promise<void> {
      try {
        if (child !== undefined && exit === undefined) {
          child.kill("SIGKILL")
          await vi.waitFor(() => expect(exit).toBeDefined(), { timeout: 5000, interval: 20 })
        }
      } finally {
        await new Promise<void>((resolve) => terminal.write("", resolve))
        terminal.dispose()
        await rm(root, { recursive: true, force: true })
      }
    },
  }
}

type ContinuationTerminal = Awaited<ReturnType<typeof createTerminal>>
const it = test.extend<{ ui: ContinuationTerminal }>({
  ui: async ({ onTestFailed }, use) => {
    const ui = await createTerminal(onTestFailed)
    try {
      await use(ui)
    } finally {
      await ui.close()
    }
  },
})

const enter = "\r"
const escape = "\u001b"
const down = "\u001b[B"
const up = "\u001b[A"
const right = "\u001b[C"
const home = "\u001b[H"
const end = "\u001b[F"
const clear = "\u0015"
const controlC = "\u0003"
const paste = (text: string): string => `\u001b[200~${text}\u001b[201~`

const editField = async (
  ui: ContinuationTerminal,
  key: string,
  title: string,
  value: string,
  returnTitle: string,
): Promise<void> => {
  await ui.pressAndWait(key, `Edit ${title}`)
  ui.press(clear)
  await ui.waitForInput(clear)
  await ui.pressAndWait(paste(value), value.split("\n")[0]!)
  await ui.pressAndWait(enter, returnTitle, "Draft saved")
}

const prepareFirst = async (ui: ContinuationTerminal): Promise<void> => {
  await ui.pressAndWait("r", "Continuation assessment")
  await ui.pressAndWait(" ", "[x] 1. Review reported changes")
  await ui.pressAndWait(enter, "Action 1: Review reported changes")
  await ui.pressAndWait("g", "Prompt choice 1 of 3")
  await ui.pressAndWait(enter, "Full outgoing prompt - action 1", "WORKFLOW START")
}

it("opens model/call review with zero inference and explicitly analyzes five ranked actions", async ({ ui }) => {
  await ui.start(FixtureMode.Fresh)
  await ui.waitForText(
    "Review source before analysis",
    "fixture-pane",
    "Cutoff: message-2",
    "INCOMPLETE SOURCE HISTORY",
    "2 summary + 1 assessment",
  )
  expect((await ui.events()).filter(({ kind }) => kind !== ContinuationFixtureEventKind.Input)).toEqual([])
  await editField(ui, "m", "Analysis and preparation model", "gpt-5.5", "Review source before analysis")
  await editField(ui, "e", "Reasoning effort", "xhigh", "Review source before analysis")
  await ui.pressAndWait("a", "Continuation assessment", "Reported progress - not independently verified")
  for (const [index, title] of [
    "Review reported changes",
    "Visualize the design",
    "Check failure cases",
    "Compare alternatives",
    "Implement the checked next step",
  ].entries()) {
    const focused = `> [ ] ${index + 1}. ${title}`
    if (index === 0) await ui.waitForText(focused)
    else await ui.pressAndWait(String(index + 1), focused)
    await ui.pressAndWait(enter, `Action ${index + 1}: ${title}`)
    await ui.pressAndWait(escape, "Continuation assessment")
  }
  const report = await ui.finish()
  expect(
    report.events
      .filter(({ kind }) => kind === ContinuationFixtureEventKind.Analyze)
      .map(({ draft }) => [draft?.model, draft?.effort]),
  ).toEqual([["gpt-5.5", "xhigh"]])
  expect(report.draft.actions.every((edit) => !edit.selected)).toBe(true)
  expect(report.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
})

it(
  "preserves independent briefs, profile/workflow, prompt edits and placements through explicit batch review",
  { timeout: 30_000 },
  async ({ ui }) => {
    await ui.start(FixtureMode.Resume)
    await ui.pressAndWait("r", "Continuation assessment")
    await ui.pressAndWait(" ", "[x] 1. Review reported changes")
    await ui.pressAndWait(enter, "Action 1: Review reported changes")
    await editField(ui, "b", "Action brief", "First independent edited brief.", "Action 1:")
    await ui.pressAndWait("p", "Choose profile", "Implementation specialist")
    await ui.pressAndWait(down, "> Implementation specialist")
    await ui.pressAndWait(enter, "Action 1:", "native:cdx/builder")
    await ui.pressAndWait("w", "Choose workflow", "verify")
    await ui.pressAndWait(down, "> verify")
    await ui.pressAndWait(enter, "Action 1:", "workflow: verify")
    await ui.pressAndWait("g", "Prompt choice 1 of 3")
    await ui.pressAndWait(right, "Prompt choice 2 of 3", "Evidence first")
    await ui.pressAndWait(enter, "Full outgoing prompt - action 1", "Choice: Evidence first.")
    await ui.pressAndWait("e", "Edit Full outgoing prompt")
    await ui.pressAndWait(paste("\nq stays literal in the full prompt."), "q stays literal")
    await ui.pressAndWait(
      enter,
      "Full outgoing prompt - action 1",
      "q stays literal",
      "Edited from candidate: candidate-2",
    )
    await ui.pressAndWait("c", "Prompt choice 2 of 3", "Edited from candidate: candidate-2")
    await ui.pressAndWait(escape, "Action 1:")
    await ui.pressAndWait(
      "o",
      "Full outgoing prompt - action 1",
      "q stays literal",
      "Edited from candidate: candidate-2",
    )
    await ui.pressAndWait("d", "Destination - action 1")
    await editField(ui, "b", "New worktree branch", "next/first-action", "Destination - action 1")
    await editField(ui, "f", "Worktree base ref", "release", "Destination - action 1")
    await ui.pressAndWait("t", "[x] New worktree uses committed files only")
    await ui.pressAndWait(escape, "Action 1:")
    await ui.pressAndWait(escape, "Continuation assessment")
    await ui.pressAndWait("2", "> [ ] 2. Visualize the design")
    await ui.pressAndWait(" ", "> [x] 2. Visualize the design")
    await ui.pressAndWait(enter, "Action 2: Visualize the design")
    await editField(ui, "b", "Action brief", "Second separate brief.", "Action 2:")
    await ui.pressAndWait("g", "Prompt choice 1 of 3")
    await ui.pressAndWait(enter, "Full outgoing prompt - action 2", "Second separate brief.")
    await ui.pressAndWait("d", "Destination - action 2")
    await ui.pressAndWait("3", "New tab: shared writable")
    await ui.pressAndWait("s", "[x] I explicitly allow")
    await ui.pressAndWait(escape, "Action 2:")
    await ui.pressAndWait("l", "Confirm launch - nothing sent yet", "Ready to launch: 2")
    expect((await ui.events()).some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
    await ui.pressAndWait(end, "END OF PROMPT", "Second separate brief.")
    await ui.pressAndWait(enter, "Continuation assessment", "Launch results saved")
    const report = await ui.finish()
    expect(report.events.filter(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toHaveLength(1)
    expect(report.draft.actions[0]).toMatchObject({
      brief: "First independent edited brief.",
      profileRef: "native:cdx/builder",
      workflowId: "verify",
      selectedCandidateId: "candidate-2",
      prompt: expect.stringContaining("q stays literal in the full prompt."),
      placement: { kind: ContinuationPlacementKind.NewWorktree, branch: "next/first-action", baseRef: "release" },
      uncommittedChangesConfirmed: true,
      status: ContinuationActionStatus.Launched,
    })
    const delivered = report.events.find(({ kind }) => kind === ContinuationFixtureEventKind.Launch)?.draft?.actions[0]
    expect(delivered).toMatchObject({
      selectedCandidateId: "candidate-2",
      prompt: report.draft.actions[0]?.prompt,
      candidates: report.draft.actions[0]?.candidates,
    })
    expect(delivered?.prompt).not.toBe(delivered?.candidates?.[1]?.prompt)
    expect(report.draft.actions[1]).toMatchObject({
      brief: "Second separate brief.",
      profileRef: "native:cpx/reviewer",
      placement: { kind: ContinuationPlacementKind.NewTab },
      sharedWriteConfirmed: true,
      status: ContinuationActionStatus.Launched,
    })
    expect(report.draft.actions.slice(2).every((edit) => !edit.selected)).toBe(true)
    expect(report.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Analyze)).toBe(false)
  },
)

for (const mode of [FixtureMode.CancelAnalysis, FixtureMode.CancelPreparation]) {
  it(`cancels the real fake-service AbortSignal and returns to overview: ${mode}`, async ({ ui }) => {
    await ui.start(mode)
    if (mode === FixtureMode.CancelPreparation) {
      await ui.pressAndWait("r", "Continuation assessment")
      await ui.pressAndWait(enter, "Action 1:")
      await ui.pressAndWait("g", "Synthetic provider is active")
    } else await ui.pressAndWait("a", "Synthetic provider is active")
    await ui.pressAndWait(
      controlC,
      mode === FixtureMode.CancelPreparation ? "Continuation assessment" : "Continuation overview",
      "Cancelled",
    )
    const report = await ui.finish()
    expect(report.events.filter(({ kind }) => kind === ContinuationFixtureEventKind.Abort)).toHaveLength(1)
    expect(report.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
  })
}

for (const mode of [FixtureMode.CancelSaveFailure, FixtureMode.CancelCleanupFailure]) {
  it(`keeps service failure visible after keyboard cancellation: ${mode}`, async ({ ui }) => {
    await ui.start(mode)
    if (mode === FixtureMode.CancelCleanupFailure) {
      await ui.pressAndWait("r", "Continuation assessment")
      await ui.pressAndWait(enter, "Action 1:")
      await ui.pressAndWait("g", "Synthetic provider is active")
    } else await ui.pressAndWait("a", "Synthetic provider is active")
    const error = mode === FixtureMode.CancelSaveFailure ? "Summary cache save failed." : "cleanup failed: force-stop"
    await ui.pressAndWait(controlC, error, "Saved state reloaded")
    expect(ui.text()).not.toContain("Cancelled. Saved work")
    const report = await ui.finish()
    expect(report.events.filter(({ kind }) => kind === ContinuationFixtureEventKind.Abort)).toHaveLength(1)
    expect(report.events.filter(({ kind }) => kind === ContinuationFixtureEventKind.Reload)).toHaveLength(1)
    expect(report.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
    if (mode === FixtureMode.CancelSaveFailure) expect(report.draft.summaries).toMatchObject([{ key: "saved-summary" }])
  })
}

it("keeps a failed save visible and refuses q until the saved edit is durable", async ({ ui }) => {
  await ui.start(FixtureMode.SaveFailure)
  await ui.pressAndWait("r", "Continuation assessment")
  await ui.pressAndWait(" ", "Save failed. Fixture disk is full.", "SAVE FAILED")
  await ui.pressAndWait("q", "Close blocked", "Fixture disk is full")
  await ui.pressAndWait("s", "Draft saved", "[x] 1. Review reported changes")
  const report = await ui.finish()
  expect(report.draft.actions[0]?.selected).toBe(true)
  expect(report.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
})

it("requires advanced-source acknowledgement and explicit launch", async ({ ui }) => {
  await ui.start(FixtureMode.Advanced)
  await prepareFirst(ui)
  await ui.pressAndWait("l", "Confirm launch - nothing sent yet", "conversation advanced")
  await ui.pressAndWait("l", "Press a to acknowledge")
  await ui.pressAndWait("a", "[x] I acknowledge")
  await ui.pressAndWait("l", "Continuation assessment", "Launch results saved")
  const report = await ui.finish()
  expect(report.events.filter(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toEqual([
    expect.objectContaining({ acknowledgeAdvanced: true }),
  ])
})

it("blocks changed source identity without launching or choosing another pane", async ({ ui }) => {
  await ui.start(FixtureMode.Different)
  await prepareFirst(ui)
  await ui.pressAndWait("l", "Launch blocked", "different conversation")
  const report = await ui.finish()
  expect(report.events.some(({ kind }) => kind === ContinuationFixtureEventKind.CheckSource)).toBe(true)
  expect(report.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
  expect(report.draft.snapshot.source.paneId).toBe("fixture-pane")
})

it("preserves unknown delivery receipts and never resends them", async ({ ui }) => {
  await ui.start(FixtureMode.Unknown)
  await prepareFirst(ui)
  await ui.pressAndWait("l", "Confirm launch - nothing sent yet")
  await ui.pressAndWait(enter, "Continuation assessment", "Needs reconciliation")
  await ui.pressAndWait("l", "needs reconciliation; do not resend")
  await ui.pressAndWait(enter, "Action 1:")
  await ui.waitForText("already-created-pane", "30000000-0000-4000-8000-000000000001")
  const report = await ui.finish()
  expect(report.events.filter(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toHaveLength(1)
  expect(report.draft.actions[0]).toMatchObject({
    status: ContinuationActionStatus.Unknown,
    launch: { paneId: "already-created-pane" },
  })
})

for (const mode of [FixtureMode.Clarification, FixtureMode.NoAction]) {
  it(`shows a legitimate non-recommendation outcome without inventing cards: ${mode}`, async ({ ui }) => {
    await ui.start(mode)
    await ui.pressAndWait(
      "r",
      mode === FixtureMode.Clarification ? "Needs clarification" : "No further action is recommended",
    )
    if (mode === FixtureMode.Clarification) await ui.waitForText("Which export format is required?")
    const report = await ui.finish()
    expect(report.draft.actions).toEqual([])
    expect(report.events.filter(({ kind }) => kind !== ContinuationFixtureEventKind.Input)).toEqual([])
  })
}

it("pages through complete evidence in a small terminal with bounded scrollback", async ({ ui }) => {
  await ui.start(FixtureMode.LongEvidence, 58, 19)
  await ui.pressAndWait("r", "Continuation assessment")
  await ui.pressAndWait("v", "Evidence 1 of 2")
  await ui.pressAndWait(right, "Evidence 2 of 2", "message-2")
  await ui.pressAndWait(end, "LONG EVIDENCE END", "(end)")
  await ui.pressAndWait(home, "Message ID: message-2")
  expect(ui.text().split("\n")).toHaveLength(19)
  const report = await ui.finish()
  expect(report.draft.snapshot.messages[1]?.text).toContain("LONG EVIDENCE START")
  expect(report.draft.snapshot.messages[1]?.text).toContain("LONG EVIDENCE END")
  expect(report.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Analyze)).toBe(false)
})

it("opens the full message browser, keeps the sidebar fixed while reading, and returns without effects", async ({
  ui,
}) => {
  await ui.start(FixtureMode.LongEvidence, 110, 24)
  await ui.pressAndWait("r", "Continuation assessment")
  await ui.pressAndWait("t", "Messages 1 of 2", "MESSAGES", "user")
  expect(ui.text()).toContain("Make the synthetic export reliable.")
  await ui.pressAndWait(right, "Messages 2 of 2", "assistant")
  await ui.pressAndWait(end, "LONG EVIDENCE END", "assistant")
  await ui.pressAndWait(home, "Lines 1-", "assistant")
  ui.press("\u001b[6~")
  await vi.waitFor(() => expect(ui.text()).not.toContain("Lines 1-"))
  expect(ui.text()).toContain("Messages 2 of 2")
  await ui.pressAndWait("\u001b[5~", "Lines 1-", "assistant")
  await ui.pressAndWait(escape, "Continuation assessment")
  const report = await ui.finish()
  expect(report.events.filter(({ kind }) => kind !== ContinuationFixtureEventKind.Input)).toEqual([])
  expect(report.draft.snapshot.messages[1]?.text).toContain("LONG EVIDENCE START")
})

it("keeps the selected role and message navigation usable in a narrow terminal", async ({ ui }) => {
  await ui.start(FixtureMode.LongEvidence, 58, 19)
  await ui.pressAndWait("r", "Continuation assessment")
  await ui.pressAndWait("t", "Messages 1 of 2", "Message 1 of 2", "user")
  await ui.pressAndWait("j", "Messages 2 of 2", "assistant")
  await ui.pressAndWait("k", "Messages 1 of 2", "user")
  await ui.pressAndWait("}", "Messages 2 of 2", "assistant")
  await ui.pressAndWait(escape, "Continuation assessment")
  const report = await ui.finish()
  expect(report.events.filter(({ kind }) => kind !== ContinuationFixtureEventKind.Input)).toEqual([])
})

it("keeps message text reachable in a short terminal", async ({ ui }) => {
  await ui.start(FixtureMode.LongEvidence, 58, 12)
  await ui.pressAndWait("t", "Messages 1 of 2")
  await ui.pressAndWait("]", "Messages 2 of 2")
  await ui.pressAndWait(end, "LONG EVIDENCE END")
  await ui.pressAndWait(home, "LONG EVIDENCE START")
  expect(ui.text().split("\n")).toHaveLength(12)
  const report = await ui.finish()
  expect(report.events.filter(({ kind }) => kind !== ContinuationFixtureEventKind.Input)).toEqual([])
})

it("keeps first and last selections visible with more messages than the sidebar", async ({ ui }) => {
  await ui.start(FixtureMode.ManyMessages, 110, 24)
  await ui.pressAndWait("r", "Continuation assessment")
  await ui.pressAndWait("t", "Messages 1 of 30", ">   1 user")
  await ui.pressAndWait(down, "Messages 2 of 30", ">   2 assistant", "Message body 2")
  await ui.pressAndWait("j", "Messages 3 of 30", ">   3 user", "Message body 3")
  await ui.pressAndWait(up, "Messages 2 of 30", ">   2 assistant")
  await ui.pressAndWait("k", "Messages 1 of 30", ">   1 user")
  await ui.pressAndWait("}", "Messages 30 of 30", ">  30 assistant")
  await ui.pressAndWait("{", "Messages 1 of 30", ">   1 user")
  const report = await ui.finish()
  expect(report.events.filter(({ kind }) => kind !== ContinuationFixtureEventKind.Input)).toEqual([])
})

it("preserves each message scroll position across navigation and terminal resize", async ({ ui }) => {
  await ui.start(FixtureMode.LongEvidence, 110, 24)
  await ui.pressAndWait("r", "Continuation assessment")
  await ui.pressAndWait("t", "Messages 1 of 2", "MESSAGES")
  await ui.pressAndWait("]", "Messages 2 of 2", "assistant")
  await ui.pressAndWait(end, "LONG EVIDENCE END")
  ui.resize(58, 19)
  await ui.waitForText("Messages 2 of 2", "assistant")
  ui.resize(110, 24)
  await ui.waitForText("Messages 2 of 2", "MESSAGES")
  await ui.pressAndWait("[", "Messages 1 of 2", "user")
  await ui.pressAndWait("]", "Messages 2 of 2", "LONG EVIDENCE END")
  const report = await ui.finish()
  expect(report.events.filter(({ kind }) => kind !== ContinuationFixtureEventKind.Input)).toEqual([])
})

it("opens the full browser from filtered Evidence and preserves both return levels", async ({ ui }) => {
  await ui.start(FixtureMode.Resume, 110, 24)
  await ui.pressAndWait("r", "Continuation assessment")
  await ui.pressAndWait("v", "Evidence 1 of 2")
  await ui.pressAndWait("t", "Messages 1 of 2", "MESSAGES")
  await ui.pressAndWait(escape, "Evidence 1 of 2", "message-1")
  await ui.pressAndWait(escape, "Continuation assessment")
  const report = await ui.finish()
  expect(report.events.filter(({ kind }) => kind !== ContinuationFixtureEventKind.Input)).toEqual([])
})

it("redacts credentials and controls in display while preserving the original snapshot", async ({ ui }) => {
  const credential = ["gh", "p_", "runtimeSyntheticCredentialValue123456"].join("")
  const control = String.fromCodePoint(0x202e)
  await ui.start(FixtureMode.RedactedMessages, 110, 24)
  await ui.pressAndWait("r", "Continuation assessment")
  await ui.pressAndWait("t", "Messages 1 of 2", "[REDACTED credential]", "visible text")
  expect(ui.text()).not.toContain(credential)
  expect(ui.text()).not.toContain(control)
  const report = await ui.finish()
  expect(report.draft.snapshot.messages[0]?.text).toContain(credential)
  expect(report.draft.snapshot.messages[0]?.text).toContain(control)
  expect(report.events.filter(({ kind }) => kind !== ContinuationFixtureEventKind.Input)).toEqual([])
})

it("views and edits a long full prompt while keeping the keyboard cursor in view", async ({ ui }) => {
  await ui.start(FixtureMode.LongPrompt, 66, 22)
  await ui.pressAndWait("r", "Continuation assessment")
  await ui.pressAndWait(enter, "Action 1:")
  await ui.pressAndWait("o", "Full outgoing prompt - action 1", "LONG PROMPT START")
  await ui.pressAndWait(end, "LONG PROMPT END")
  await ui.pressAndWait("e", "Edit Full outgoing prompt", "LONG PROMPT END")
  await ui.pressAndWait("\u0001", "▌LONG PROMPT START")
  await ui.pressAndWait("\u0005", "LONG PROMPT END▌")
  await ui.pressAndWait("q", "LONG PROMPT ENDq▌")
  const report = await ui.finish(controlC)
  expect(report.draft.actions[0]?.prompt).toMatch(/^LONG PROMPT START\n[\s\S]+LONG PROMPT ENDq$/u)
  expect(report.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
})

it("captures latest only after confirmation, then returns to zero-inference model review", async ({ ui }) => {
  await ui.start(FixtureMode.Resume)
  await ui.pressAndWait("n", "Analyze latest - keep previous draft")
  await ui.pressAndWait(escape, "Continuation assessment")
  expect((await ui.events()).some(({ kind }) => kind === ContinuationFixtureEventKind.Latest)).toBe(false)
  await ui.pressAndWait("n", "Analyze latest - keep previous draft")
  await ui.pressAndWait("y", "Review source before analysis", "Latest snapshot saved")
  const report = await ui.finish()
  expect(report.draft.id).toBe("10000000-0000-4000-8000-000000000002")
  expect(report.events.filter(({ kind }) => kind === ContinuationFixtureEventKind.Latest)).toHaveLength(1)
  expect(report.events.some(({ kind }) => kind === ContinuationFixtureEventKind.Analyze)).toBe(false)
})

it("requires a separate explicit discard confirmation", async ({ ui }) => {
  await ui.start(FixtureMode.Resume)
  await ui.pressAndWait("D", "Confirm discard - draft not deleted")
  expect((await ui.events()).some(({ kind }) => kind === ContinuationFixtureEventKind.Discard)).toBe(false)
  await ui.pressAndWait(escape, "Continuation assessment")
  await ui.pressAndWait("D", "Confirm discard - draft not deleted")
  const report = await ui.finish("D")
  expect(report.events.filter(({ kind }) => kind === ContinuationFixtureEventKind.Discard)).toHaveLength(1)
})

it("keeps a dependent action waiting and does not treat prerequisite delivery as completed work", async ({ ui }) => {
  await ui.start(FixtureMode.Resume)
  await prepareFirst(ui)
  await ui.pressAndWait(escape, "Action 1:")
  await ui.pressAndWait(escape, "Continuation assessment")
  await ui.pressAndWait("5", "5. Implement the checked next step")
  await ui.pressAndWait(" ", "[x] 5.")
  await ui.pressAndWait(enter, "Action 5:")
  await ui.pressAndWait("g", "Prompt choice 1 of 3")
  await ui.pressAndWait(enter, "Full outgoing prompt - action 5", "WAITING")
  await ui.pressAndWait(escape, "Action 5:")
  await ui.pressAndWait("x", "A prerequisite is selected in this batch")
  await ui.pressAndWait("l", "Confirm launch - nothing sent yet", "Ready to launch: 1. Waiting: 1.")
  await ui.pressAndWait(enter, "Continuation assessment", "Launch results saved")
  const report = await ui.finish()
  expect(report.draft.actions[0]?.status).toBe(ContinuationActionStatus.Launched)
  expect(report.draft.actions[4]).toMatchObject({
    status: ContinuationActionStatus.Waiting,
    prerequisitesConfirmed: false,
  })
  expect(report.draft.actions[4]?.launch).toBeUndefined()
})

it("requires explicit committed-only confirmation for a dirty-source worktree and exposes it in prompt review", async ({
  ui,
}) => {
  await ui.start(FixtureMode.DirtySource)
  await prepareFirst(ui)
  await ui.waitForText("[ ] New worktree uses committed files only")
  await ui.pressAndWait("l", "Confirm launch - nothing sent yet")
  await ui.pressAndWait(enter, "Dirty source: confirm exclusion", "Continuation assessment")
  expect((await ui.events()).some(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toBe(false)
  await ui.pressAndWait(enter, "Action 1:")
  await ui.pressAndWait("o", "Full outgoing prompt - action 1", "[ ] New worktree")
  await ui.pressAndWait("t", "[x] New worktree uses committed files only", "Draft saved")
  await ui.pressAndWait("l", "Confirm launch - nothing sent yet", "[x] New worktree")
  await ui.pressAndWait(enter, "Continuation assessment", "Launch results saved")
  const report = await ui.finish()
  expect(report.events.filter(({ kind }) => kind === ContinuationFixtureEventKind.Launch)).toHaveLength(1)
  expect(report.draft.actions[0]).toMatchObject({
    uncommittedChangesConfirmed: true,
    status: ContinuationActionStatus.Launched,
    prompt: expect.stringContaining("WORKFLOW START"),
  })
})
