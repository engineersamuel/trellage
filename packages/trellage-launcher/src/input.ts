import type { Key } from "ink"
import {
  cycleSort,
  moveSelection,
  selectModel,
  setQuery,
  type LaunchEntry,
  type LauncherState,
} from "./state.js"
import type { Dispatch, SetStateAction } from "react"

export type StateSetter<T> = Dispatch<SetStateAction<T>>

export type LaunchTarget = "current" | "herdr" | "remote"

export const isSubmitInput = (input: string, key: Key): boolean =>
  key.return || input === "\r" || input === "\n"

export const handleDetailsInput = (
  input: string,
  key: Key,
  expandedDetailCount: number,
  rows: number,
  setShowingDetails: StateSetter<boolean>,
  setDetailOffset: StateSetter<number>,
): void => {
  const maximumOffset = Math.max(0, expandedDetailCount - Math.max(1, rows - 4))
  if (key.escape || input === "D" || input === "q") {
    setShowingDetails(false)
  } else if (key.upArrow || input === "k") {
    setDetailOffset((offset) => Math.max(0, offset - 1))
  } else if (key.downArrow || input === "j") {
    setDetailOffset((offset) => Math.min(maximumOffset, offset + 1))
  }
}

export const handleCustomModelInput = (
  input: string,
  key: Key,
  selectedId: string,
  customModel: string,
  updateState: StateSetter<LauncherState>,
  setCustomModel: StateSetter<string>,
  setEditingCustomModel: StateSetter<boolean>,
  setChoosingModel: StateSetter<boolean>,
): void => {
  if (key.escape) {
    setEditingCustomModel(false)
  } else if (isSubmitInput(input, key)) {
    if (customModel.length > 0) {
      updateState((current) => selectModel(current, selectedId, customModel))
      setEditingCustomModel(false)
      setChoosingModel(false)
    }
  } else if (key.backspace || key.delete) {
    setCustomModel((value) => value.slice(0, -1))
  } else if (
    !key.ctrl &&
    !key.meta &&
    input.length > 0 &&
    customModel.length + input.length <= 256 &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(input)
  ) {
    setCustomModel((value) => value + input)
  }
}

export const handleModelInput = (
  input: string,
  key: Key,
  selected: LaunchEntry,
  modelIndex: number,
  updateState: StateSetter<LauncherState>,
  setChoosingModel: StateSetter<boolean>,
  setEditingCustomModel: StateSetter<boolean>,
  setCustomModel: StateSetter<string>,
  setModelIndex: StateSetter<number>,
): void => {
  const choiceCount = selected.models.length + 1
  if (key.escape) {
    setChoosingModel(false)
  } else if (key.upArrow || input === "k") {
    setModelIndex((index) => (index - 1 + choiceCount) % choiceCount)
  } else if (key.downArrow || input === "j") {
    setModelIndex((index) => (index + 1) % choiceCount)
  } else if (input.toLocaleLowerCase("en") === "l" || isSubmitInput(input, key)) {
    if (modelIndex === selected.models.length) {
      setCustomModel("")
      setEditingCustomModel(true)
    } else {
      updateState((current) => selectModel(current, selected.id, selected.models[modelIndex]!))
      setChoosingModel(false)
    }
  }
}

export const handleSearchInput = (
  input: string,
  key: Key,
  updateState: StateSetter<LauncherState>,
  setSearching: StateSetter<boolean>,
  finish: (target: LaunchTarget) => void,
): void => {
  if (key.upArrow) {
    updateState((current) => moveSelection(current, -1))
  } else if (key.downArrow) {
    updateState((current) => moveSelection(current, 1))
  } else if (key.backspace || key.delete) {
    updateState((current) => setQuery(current, current.query.slice(0, -1)))
  } else if (isSubmitInput(input, key)) {
    finish("current")
  } else if (key.escape) {
    setSearching(false)
  } else if (!key.ctrl && !key.meta && input.length > 0) {
    updateState((current) =>
      setQuery(current, current.query + (current.query.length === 0 && input.startsWith("/") ? input.slice(1) : input)),
    )
  }
}

export const handleCommandMovement = (
  input: string,
  key: Key,
  updateState: StateSetter<LauncherState>,
  cancel: () => void,
): boolean => {
  if (key.escape || input === "q") {
    cancel()
  } else if (key.upArrow || input === "k") {
    updateState((current) => moveSelection(current, -1))
  } else if (key.downArrow || input === "j") {
    updateState((current) => moveSelection(current, 1))
  } else {
    return false
  }
  return true
}

export const handleCommandInput = (
  input: string,
  key: Key,
  state: LauncherState,
  selected: LaunchEntry | undefined,
  herdrAvailable: boolean,
  remoteAvailable: boolean,
  updateState: StateSetter<LauncherState>,
  setSearching: StateSetter<boolean>,
  setModelIndex: StateSetter<number>,
  setChoosingModel: StateSetter<boolean>,
  setDetailOffset: StateSetter<number>,
  setShowingDetails: StateSetter<boolean>,
  finish: (target: LaunchTarget) => void,
  cancel: () => void,
): void => {
  if (handleCommandMovement(input, key, updateState, cancel)) return
  if (input === "/") {
    setSearching(true)
  } else if (input.toLocaleLowerCase("en") === "s") {
    updateState(cycleSort)
  } else if (input.toLocaleLowerCase("en") === "m" && selected?.modelOverrideSupported) {
    const active = state.modelByEntry[selected.id] ?? selected.defaultModel
    setModelIndex(Math.max(0, selected.models.indexOf(active ?? selected.models[0]!)))
    setChoosingModel(true)
  } else if (input === "D" && selected !== undefined) {
    setDetailOffset(0)
    setShowingDetails(true)
  } else if (input === "H" && herdrAvailable) {
    finish("herdr")
  } else if (input === "R" && remoteAvailable) {
    finish("remote")
  } else if (input.toLocaleLowerCase("en") === "l" || isSubmitInput(input, key)) {
    finish("current")
  }
}
