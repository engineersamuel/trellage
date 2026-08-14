import { describe, expect, it } from "vitest"
import type { Key } from "ink"
import {
  handleCommandInput,
  handleCustomModelInput,
  handleModelInput,
  handleSearchInput,
  isSubmitInput,
  type LaunchTarget,
  type StateSetter,
} from "../src/input.js"
import { createLauncherState, type LaunchEntry, type LauncherState } from "../src/state.js"

const entries: ReadonlyArray<LaunchEntry> = [
  {
    id: "codex:superpowers",
    label: "codex / superpowers",
    harness: "codex",
    profile: "superpowers",
    description: "Codex profile",
    defaultModel: "gpt-default",
    models: ["gpt-default", "gpt-fast"],
    modelOverrideSupported: true,
  },
  {
    id: "claude:council",
    label: "claude / council",
    harness: "claude",
    profile: "council",
    description: "Claude profile",
    defaultModel: "sonnet",
    models: ["sonnet", "opus"],
    modelOverrideSupported: true,
  },
]

const emptyKey: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
}

const keyOf = (overrides: Partial<Key> = {}): Key => ({ ...emptyKey, ...overrides })

interface Recorder {
  readonly launches: Array<LaunchTarget>
  readonly cancels: Array<true>
  state: LauncherState
  searching: boolean
  choosingModel: boolean
  editingCustomModel: boolean
  customModel: string
  modelIndex: number
  detailOffset: number
  showingDetails: boolean
}

const createRecorder = (): Recorder => ({
  launches: [],
  cancels: [],
  state: createLauncherState(entries),
  searching: true,
  choosingModel: false,
  editingCustomModel: false,
  customModel: "",
  modelIndex: 0,
  detailOffset: 0,
  showingDetails: false,
})

const setterFor = <K extends keyof Recorder>(recorder: Recorder, field: K): StateSetter<Recorder[K]> =>
  ((value: unknown) => {
    recorder[field] = typeof value === "function" ? (value as (prior: Recorder[K]) => Recorder[K])(recorder[field]) : (value as Recorder[K])
  }) as StateSetter<Recorder[K]>

const search = (recorder: Recorder, input: string, key: Key): void => {
  handleSearchInput(input, key, setterFor(recorder, "state"), setterFor(recorder, "searching"), (target) => {
    recorder.launches.push(target)
  })
}

const command = (recorder: Recorder, input: string, key: Key, herdrAvailable = false, remoteAvailable = false): void => {
  const selected = recorder.state.entries.find(({ id }) => id === recorder.state.selectedId)
  handleCommandInput(
    input,
    key,
    recorder.state,
    selected,
    herdrAvailable,
    remoteAvailable,
    setterFor(recorder, "state"),
    setterFor(recorder, "searching"),
    setterFor(recorder, "modelIndex"),
    setterFor(recorder, "choosingModel"),
    setterFor(recorder, "detailOffset"),
    setterFor(recorder, "showingDetails"),
    (target) => {
      recorder.launches.push(target)
    },
    () => {
      recorder.cancels.push(true)
    },
  )
}

describe("isSubmitInput", () => {
  it("accepts carriage return, line feed, and the return key", () => {
    expect(isSubmitInput("", keyOf({ return: true }))).toBe(true)
    expect(isSubmitInput("\r", keyOf())).toBe(true)
    expect(isSubmitInput("\n", keyOf())).toBe(true)
  })

  it("rejects blank input from non-alphanumeric named keys", () => {
    expect(isSubmitInput("", keyOf({ pageUp: true }))).toBe(false)
    expect(isSubmitInput("", keyOf())).toBe(false)
  })
})

describe("handleSearchInput", () => {
  it("launches the highlighted entry on a single Enter press", () => {
    const recorder = createRecorder()
    search(recorder, "", keyOf({ return: true }))
    expect(recorder.launches).toEqual(["current"])
    expect(recorder.searching).toBe(true)
  })

  it("launches on a line feed even when the return key flag is false", () => {
    const recorder = createRecorder()
    search(recorder, "\n", keyOf())
    expect(recorder.launches).toEqual(["current"])
  })

  it("leaves filter mode on Escape without launching", () => {
    const recorder = createRecorder()
    search(recorder, "", keyOf({ escape: true }))
    expect(recorder.launches).toEqual([])
    expect(recorder.searching).toBe(false)
  })

  it("ignores blank-input navigation keys", () => {
    const recorder = createRecorder()
    search(recorder, "", keyOf({ pageUp: true }))
    expect(recorder.launches).toEqual([])
    expect(recorder.searching).toBe(true)
    expect(recorder.state.query).toBe("")
  })

  it("appends printable input to the query", () => {
    const recorder = createRecorder()
    search(recorder, "c", keyOf())
    expect(recorder.state.query).toBe("c")
    expect(recorder.launches).toEqual([])
  })

  it("moves the selection on arrow down without launching", () => {
    const recorder = createRecorder()
    const before = recorder.state.selectedId
    search(recorder, "", keyOf({ downArrow: true }))
    expect(recorder.state.selectedId).not.toBe(before)
    expect(recorder.launches).toEqual([])
  })
})

describe("handleCommandInput", () => {
  it("launches on Enter and on the l alias", () => {
    const enterRecorder = createRecorder()
    command(enterRecorder, "", keyOf({ return: true }))
    expect(enterRecorder.launches).toEqual(["current"])

    const aliasRecorder = createRecorder()
    command(aliasRecorder, "l", keyOf())
    expect(aliasRecorder.launches).toEqual(["current"])
  })

  it("does not launch on a blank-input navigation key", () => {
    const recorder = createRecorder()
    command(recorder, "", keyOf({ pageUp: true }))
    expect(recorder.launches).toEqual([])
  })

  it("launches herdr on H only when herdrAvailable", () => {
    const unavailable = createRecorder()
    command(unavailable, "H", keyOf(), false, false)
    expect(unavailable.launches).toEqual([])

    const available = createRecorder()
    command(available, "H", keyOf(), true, false)
    expect(available.launches).toEqual(["herdr"])
  })

  it("launches remote on R only when remoteAvailable", () => {
    const unavailable = createRecorder()
    command(unavailable, "R", keyOf(), false, false)
    expect(unavailable.launches).toEqual([])

    const available = createRecorder()
    command(available, "R", keyOf(), false, true)
    expect(available.launches).toEqual(["remote"])
  })
})

describe("handleModelInput", () => {
  it("does not select a model on a blank-input navigation key", () => {
    const recorder = createRecorder()
    handleModelInput(
      "",
      keyOf({ pageUp: true }),
      entries[0]!,
      0,
      setterFor(recorder, "state"),
      setterFor(recorder, "choosingModel"),
      setterFor(recorder, "editingCustomModel"),
      setterFor(recorder, "customModel"),
      setterFor(recorder, "modelIndex"),
    )
    expect(recorder.choosingModel).toBe(false)
    expect(recorder.state.modelByEntry["codex:superpowers"]).toBeUndefined()
  })
})

describe("handleCustomModelInput", () => {
  const edit = (recorder: Recorder, input: string, key: Key): void => {
    handleCustomModelInput(
      input,
      key,
      "codex:superpowers",
      recorder.customModel,
      setterFor(recorder, "state"),
      setterFor(recorder, "customModel"),
      setterFor(recorder, "editingCustomModel"),
      setterFor(recorder, "choosingModel"),
    )
  }

  it("does not commit on a blank-input navigation key", () => {
    const recorder = createRecorder()
    recorder.customModel = "custom-model"
    recorder.editingCustomModel = true
    edit(recorder, "", keyOf({ pageUp: true }))
    expect(recorder.editingCustomModel).toBe(true)
    expect(recorder.state.modelByEntry["codex:superpowers"]).toBeUndefined()
  })

  it("commits a non-empty model on Enter", () => {
    const recorder = createRecorder()
    recorder.customModel = "custom-model"
    recorder.editingCustomModel = true
    edit(recorder, "", keyOf({ return: true }))
    expect(recorder.editingCustomModel).toBe(false)
    expect(recorder.state.modelByEntry["codex:superpowers"]).toBe("custom-model")
  })
})
