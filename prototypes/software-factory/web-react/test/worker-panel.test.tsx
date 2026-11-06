import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { WorkerPanel } from "../src/shared/WorkerPanel"
import type { Worker } from "../src/shared/factory"

const w = (id: string, name: string, role: string, status: string) =>
  ({ id, name, role, status, model: "m", auth: "native", pid: null, rssKb: null, home: "", task: null, lastMessage: null, eventCount: 0, contextTokens: null, contextLimit: null }) as unknown as Worker

const coordinator = w("coordinator", "Factory desk", "coordinator", "idle")
const namer = w("namer", "namer", "worker", "running")
const html = (selected: string) => renderToStaticMarkup(<WorkerPanel workers={[coordinator, namer]} selected={selected} onSelect={() => {}} />)

describe("worker panel actions", () => {
  test("an idle coordinator has neither Cancel run nor Remove", () => {
    const page = html("coordinator")
    expect(page).not.toContain("Cancel run")
    expect(page).not.toContain("Remove worker")
  })

  test("a running worker can cancel its run; Remove asks in a dialog first", () => {
    const page = html("namer")
    expect(page).toContain('aria-label="Cancel run of namer"')
    expect(page).toContain('aria-label="Remove namer"')
    expect(page).toContain("Remove namer?")
    expect(page).toContain("You cannot undo this.")
  })
})
