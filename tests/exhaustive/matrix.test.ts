import { expect, test } from "bun:test"
import { cartesianCases, matrixSize } from "./matrix.ts"

test("Cartesian enumeration retains omitted states and every invalid cross combination", () => {
  const domains = [
    {
      name: "mode",
      values: [
        { id: "omitted", argv: [] },
        { id: "json", argv: ["--json"] },
      ],
    },
    {
      name: "intent",
      values: [
        { id: "omitted", argv: [] },
        { id: "empty", argv: ["--intent", ""] },
        { id: "stdin", argv: ["--intent-stdin"] },
      ],
    },
  ]
  expect(matrixSize(domains)).toBe(6n)
  expect([...cartesianCases("guide", domains)].map(({ id, argv }) => ({ id, argv }))).toEqual([
    { id: "guide:0", argv: [] },
    { id: "guide:1", argv: ["--intent", ""] },
    { id: "guide:2", argv: ["--intent-stdin"] },
    { id: "guide:3", argv: ["--json"] },
    { id: "guide:4", argv: ["--json", "--intent", ""] },
    { id: "guide:5", argv: ["--json", "--intent-stdin"] },
  ])
})

test("a shard resumes stable case IDs without changing the full product", () => {
  const domains = [
    {
      name: "value",
      values: [
        { id: "a", argv: ["a"] },
        { id: "b", argv: ["b"] },
        { id: "c", argv: ["c"] },
      ],
    },
  ]
  expect([...cartesianCases("run", domains, { start: 1n, end: 3n })].map(({ id, argv }) => ({ id, argv }))).toEqual([
    { id: "run:1", argv: ["b"] },
    { id: "run:2", argv: ["c"] },
  ])
  expect(() => [...cartesianCases("run", domains, { start: 0n, end: 4n })]).toThrow("range")
})

test("empty or ambiguous domains fail instead of concealing omitted cases", () => {
  expect(() => matrixSize([{ name: "mode", values: [] }])).toThrow("empty")
  const domain = { name: "mode", values: [{ id: "omitted", argv: [] }] }
  expect(() => matrixSize([domain, domain])).toThrow("Duplicate domain")
  expect(() => matrixSize([{ name: "mode", values: [...domain.values, ...domain.values] }])).toThrow("Duplicate value")
})

test("global operands remain before the command across every Cartesian combination", () => {
  const domains = [
    {
      name: "root-help",
      values: [
        { id: "omitted", argv: [] },
        { id: "long", argv: [], rootArgv: ["--help"] },
      ],
    },
    {
      name: "model",
      values: [
        { id: "omitted", argv: [] },
        { id: "empty", argv: ["--model", ""] },
      ],
    },
  ]
  expect(matrixSize(domains)).toBe(4n)
  expect([...cartesianCases("run", domains)].map(({ rootArgv, argv }) => ({ rootArgv, argv }))).toEqual([
    { rootArgv: [], argv: [] },
    { rootArgv: [], argv: ["--model", ""] },
    { rootArgv: ["--help"], argv: [] },
    { rootArgv: ["--help"], argv: ["--model", ""] },
  ])
})
